//! User-owned Linux launchers. No shell, elevated privileges, or arbitrary paths cross the IPC boundary.
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

const MARKER: &str = "X-Ancilla-Managed=true";
const INSTALL_ID: &str = "app.ancilla.desktop";
const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxDesktopStatus {
    kind: &'static str,
    menu_installed: bool,
    desktop_shortcut_installed: bool,
    desktop_shortcut_supported: bool,
    can_install: bool,
    restart_required: bool,
    installed_path: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Installation {
    owner: String,
    version: String,
    extract_and_run: bool,
}

struct Locations {
    install: PathBuf,
    menu: PathBuf,
    legacy_menu: PathBuf,
    legacy_appimage: PathBuf,
    desktop: Option<PathBuf>,
    uid: u32,
}

impl Locations {
    fn for_app(app: &tauri::AppHandle) -> Result<Self, String> {
        let data = app.path().data_dir().map_err(|e| e.to_string())?;
        let home = app.path().home_dir().map_err(|e| e.to_string())?;
        let desktop = app.path().desktop_dir().ok().filter(|path| path != &home);
        Ok(Self {
            install: data.join(INSTALL_ID).join("installation"),
            menu: data.join("applications/Ancilla.desktop"),
            legacy_menu: data.join("applications/ancilla.desktop"),
            legacy_appimage: home.join("Applications/Ancilla.AppImage"),
            desktop: desktop.map(|dir| dir.join("Ancilla.desktop")),
            uid: fs::metadata("/proc/self").map_err(|e| e.to_string())?.uid(),
        })
    }

    fn binary(&self) -> PathBuf {
        self.install.join("Ancilla.AppImage")
    }
    fn manifest(&self) -> PathBuf {
        self.install.join("installation.json")
    }
    fn icon(&self) -> PathBuf {
        self.install.join("ancilla.png")
    }
}

fn appimage_source() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file())
}

pub fn installation_kind() -> &'static str {
    if appimage_source().is_some() {
        "appimage"
    } else if std::env::current_exe().ok().as_deref() == Some(Path::new("/usr/bin/ancilla")) {
        "package"
    } else {
        "development"
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

fn owned_file(path: &Path, uid: u32) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() && meta.uid() == uid => Ok(true),
        Ok(_) => Err(format!(
            "Ancilla will not replace {} because it is not a regular file owned by you.",
            path.display()
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

fn ensure_owned_dir(path: &Path, uid: u32) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && meta.uid() == uid => Ok(()),
        Ok(_) => Err(format!("Choose a user-owned folder for Linux application data. {} is not a directory owned by you.", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or("The Linux application-data path has no parent.")?;
            ensure_owned_dir(parent, uid)?;
            fs::create_dir(path).map_err(|e| format!("Could not create {}: {e}", path.display()))?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
        }
        Err(e) => Err(format!("Could not open {}: {e}", path.display())),
    }
}

/// The destination is replaced only after the whole write succeeds; pre-existing symlinks are refused.
fn atomic_file(
    path: &Path,
    uid: u32,
    mode: u32,
    write: impl FnOnce(&mut File) -> std::io::Result<()>,
) -> Result<(), String> {
    owned_file(path, uid)?;
    let parent = path
        .parent()
        .ok_or("The installation path has no parent.")?;
    ensure_owned_dir(parent, uid)?;
    let temporary = parent.join(format!(
        ".ancilla-{}-{}.tmp",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&temporary)
        .map_err(|e| {
            format!(
                "Could not create an installation file in {}: {e}",
                parent.display()
            )
        })?;
    let result = (|| {
        write(&mut file)?;
        file.sync_all()?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(mode))?;
        fs::rename(&temporary, path)
    })();
    let _ = fs::remove_file(&temporary);
    result.map_err(|e| format!("Could not save {}: {e}", path.display()))
}

fn write_bytes(path: &Path, uid: u32, mode: u32, bytes: &[u8]) -> Result<(), String> {
    atomic_file(path, uid, mode, |file| file.write_all(bytes))
}

fn read_installation(loc: &Locations) -> Option<Installation> {
    if !owned_file(&loc.manifest(), loc.uid).ok()? {
        return None;
    }
    let installation: Installation =
        serde_json::from_slice(&fs::read(loc.manifest()).ok()?).ok()?;
    (installation.owner == INSTALL_ID).then_some(installation)
}

fn field(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

/// Exec quoting has two layers: the Desktop Entry string, then its argument parser. It is not a shell command.
fn exec_argument(path: &Path) -> Result<String, String> {
    let value = path
        .to_str()
        .ok_or("The app path must contain valid text to create a Linux shortcut.")?;
    if value.chars().any(char::is_control) {
        return Err("The app path contains a control character.".into());
    }
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$")
        .replace('%', "%%");
    Ok(field(&format!("\"{escaped}\"")))
}

fn launcher(binary: &Path, icon: &Path, extract_and_run: bool) -> Result<String, String> {
    let exec = exec_argument(binary)?;
    let icon = field(
        icon.to_str()
            .ok_or("The icon path must contain valid text.")?,
    );
    let args = if extract_and_run {
        " --appimage-extract-and-run"
    } else {
        ""
    };
    Ok(format!("[Desktop Entry]\nType=Application\nName=Ancilla\nComment=Deep Research and agent monitoring\nExec={exec}{args}\nIcon={icon}\nTerminal=false\nCategories=Development;\nStartupWMClass=ancilla\nKeywords=Muse;Research;Agents;\n{MARKER}\n"))
}

fn managed_launcher(path: &Path) -> bool {
    fs::read_to_string(path).is_ok_and(|text| text.lines().any(|line| line == MARKER))
}

/// Recognize the exact manual shortcut previously documented, so migrating it preserves a backup.
fn legacy_launcher(text: &str, source: Option<&Path>) -> bool {
    let Some(source) = source.and_then(Path::to_str) else {
        return false;
    };
    text.lines().any(|line| line == "Name=Ancilla")
        && text
            .lines()
            .any(|line| line == "Comment=Deep Research and agent monitoring")
        && text
            .lines()
            .any(|line| line == format!("Exec=\"{source}\"") || line == format!("Exec={source}"))
}

fn check_launcher(
    path: &Path,
    loc: &Locations,
    source: Option<&Path>,
) -> Result<Option<Vec<u8>>, String> {
    if !owned_file(path, loc.uid)? {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    if text.lines().any(|line| line == MARKER) {
        return Ok(None);
    }
    if legacy_launcher(&text, source) || legacy_launcher(&text, Some(&loc.legacy_appimage)) {
        return Ok(Some(bytes));
    }
    Err(format!("A different shortcut already exists at {}. Rename that shortcut, then try again; Ancilla has left it unchanged.", path.display()))
}

fn status(loc: &Locations, kind: &'static str, source: Option<&Path>) -> LinuxDesktopStatus {
    let binary = loc.binary();
    let installed =
        read_installation(loc).is_some() && owned_file(&binary, loc.uid).unwrap_or(false);
    LinuxDesktopStatus {
        kind,
        menu_installed: kind == "package" || (installed && managed_launcher(&loc.menu)),
        desktop_shortcut_installed: loc.desktop.as_deref().is_some_and(managed_launcher),
        desktop_shortcut_supported: loc.desktop.is_some(),
        can_install: kind == "appimage" || (kind == "package" && loc.desktop.is_some()),
        restart_required: kind == "appimage"
            && installed
            && source.is_some_and(|source| !same_file(source, &binary)),
        installed_path: if kind == "package" {
            Some("/usr/bin/ancilla".into())
        } else {
            installed.then(|| binary.to_string_lossy().into_owned())
        },
    }
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

fn install(
    loc: &Locations,
    kind: &'static str,
    source: Option<&Path>,
    desktop_shortcut: bool,
    version: &str,
    extract: bool,
) -> Result<LinuxDesktopStatus, String> {
    if kind != "appimage" && kind != "package" {
        return Err("Desktop shortcuts are available in the installed Linux app.".into());
    }
    let desktop = if desktop_shortcut {
        loc.desktop.as_ref()
    } else {
        None
    };
    // Check all existing destinations before changing anything.
    let legacy_source = source.or(Some(loc.legacy_appimage.as_path()));
    let menu_backup = check_launcher(&loc.menu, loc, legacy_source)?;
    // A package replaces a previously managed per-user entry too: otherwise it shadows the package's menu entry.
    let write_menu = kind == "appimage" || loc.menu.exists();
    let legacy_menu = if owned_file(&loc.legacy_menu, loc.uid).unwrap_or(false) {
        fs::read(&loc.legacy_menu).ok().filter(|bytes| {
            let text = String::from_utf8_lossy(bytes);
            legacy_launcher(&text, legacy_source)
                || legacy_launcher(&text, Some(&loc.legacy_appimage))
        })
    } else {
        None
    };
    let desktop_backup = desktop
        .map(|path| check_launcher(path, loc, legacy_source))
        .transpose()?
        .flatten();
    let previous = read_installation(loc);
    if loc.install.exists()
        && previous.is_none()
        && fs::read_dir(&loc.install)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
    {
        return Err(format!(
            "{} already contains files from another installation. Ancilla has left them unchanged.",
            loc.install.display()
        ));
    }
    ensure_owned_dir(&loc.install, loc.uid)?;
    owned_file(&loc.binary(), loc.uid)?;
    owned_file(&loc.icon(), loc.uid)?;
    let extract = extract
        || previous
            .as_ref()
            .is_some_and(|previous| previous.extract_and_run);
    let installation = Installation {
        owner: INSTALL_ID.into(),
        version: version.into(),
        extract_and_run: extract,
    };
    // Claim the otherwise empty private directory before copying. An interrupted copy can then be retried safely.
    if previous.is_none() {
        write_bytes(
            &loc.manifest(),
            loc.uid,
            0o600,
            &serde_json::to_vec(&installation).map_err(|e| e.to_string())?,
        )?;
    }
    let binary = if kind == "appimage" {
        let source = source.ok_or(
            "Ancilla could not find its AppImage. Download the Linux installer and open it again.",
        )?;
        if !same_file(source, &loc.binary()) {
            if previous
                .as_ref()
                .is_some_and(|previous| version_parts(&previous.version) > version_parts(version))
            {
                return Err("A newer Ancilla is already installed. Open Ancilla from the application menu to continue.".into());
            }
            let mut input =
                File::open(source).map_err(|e| format!("Could not read the AppImage: {e}"))?;
            let mut magic = [0; 4];
            input.read_exact(&mut magic).map_err(|e| e.to_string())?;
            if &magic != b"\x7fELF" {
                return Err(
                    "The AppImage is not an executable Linux application. Download Ancilla again."
                        .into(),
                );
            }
            atomic_file(&loc.binary(), loc.uid, 0o755, |file| {
                file.write_all(&magic)?;
                std::io::copy(&mut input, file).map(|_| ())
            })?;
        }
        loc.binary()
    } else {
        PathBuf::from("/usr/bin/ancilla")
    };
    write_bytes(&loc.icon(), loc.uid, 0o644, ICON)?;
    let entry = launcher(&binary, &loc.icon(), kind == "appimage" && extract)?;
    for (name, bytes) in [
        ("previous-menu-shortcut", menu_backup),
        ("previous-desktop-shortcut", desktop_backup),
        ("previous-manual-menu-shortcut", legacy_menu.clone()),
    ] {
        if let Some(bytes) = bytes {
            let path = loc.install.join(name);
            // A previous backup stays intact across retries.
            if !path.exists() {
                write_bytes(&path, loc.uid, 0o600, &bytes)?;
            }
        }
    }
    if write_menu {
        write_bytes(&loc.menu, loc.uid, 0o644, entry.as_bytes())?;
    }
    if let Some(desktop) = desktop {
        write_bytes(desktop, loc.uid, 0o755, entry.as_bytes())?;
    }
    write_bytes(
        &loc.manifest(),
        loc.uid,
        0o600,
        &serde_json::to_vec(&installation).map_err(|e| e.to_string())?,
    )?;
    if let Some(previous) = legacy_menu {
        // Remove only the exact entry whose contents were backed up; another program's replacement stays intact.
        if owned_file(&loc.legacy_menu, loc.uid)?
            && fs::read(&loc.legacy_menu).ok().as_ref() == Some(&previous)
        {
            fs::remove_file(&loc.legacy_menu).map_err(|e| e.to_string())?;
        }
    }
    Ok(status(loc, kind, source))
}

#[tauri::command]
pub fn linux_installation_status(app: tauri::AppHandle) -> Result<LinuxDesktopStatus, String> {
    let loc = Locations::for_app(&app)?;
    // The updater replaces the binary in place; record its running version before another downloaded copy can be installed.
    if appimage_source()
        .as_deref()
        .is_some_and(|source| same_file(source, &loc.binary()))
    {
        if let Some(mut installation) = read_installation(&loc) {
            if version_parts(env!("CARGO_PKG_VERSION")) > version_parts(&installation.version) {
                installation.version = env!("CARGO_PKG_VERSION").into();
                write_bytes(
                    &loc.manifest(),
                    loc.uid,
                    0o600,
                    &serde_json::to_vec(&installation).map_err(|e| e.to_string())?,
                )?;
            }
        }
    }
    Ok(status(
        &loc,
        installation_kind(),
        appimage_source().as_deref(),
    ))
}

#[tauri::command]
pub async fn install_linux_launcher(
    app: tauri::AppHandle,
    desktop_shortcut: bool,
) -> Result<LinuxDesktopStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let loc = Locations::for_app(&app)?;
        let extract = std::env::var_os("APPIMAGE_EXTRACT_AND_RUN").is_some()
            || std::env::var("APPDIR").is_ok_and(|value| value.contains("appimage_extracted"));
        let result = install(
            &loc,
            installation_kind(),
            appimage_source().as_deref(),
            desktop_shortcut,
            env!("CARGO_PKG_VERSION"),
            extract,
        )?;
        // These helpers are optional. Some desktops require the user to choose Allow Launching themselves.
        if let Some(directory) = loc.menu.parent() {
            let _ = Command::new("update-desktop-database")
                .arg(directory)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
        if desktop_shortcut {
            if let Some(desktop) = loc.desktop {
                let _ = Command::new("gio")
                    .args(["set", "-t", "string"])
                    .arg(desktop)
                    .args(["metadata::trusted", "true"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn relaunch_installed_linux(app: tauri::AppHandle) -> Result<(), String> {
    let loc = Locations::for_app(&app)?;
    let installation = read_installation(&loc)
        .ok_or("Add Ancilla to the application menu before reopening it.")?;
    if installation_kind() != "appimage" || !owned_file(&loc.binary(), loc.uid)? {
        return Err("There is no installed AppImage to reopen.".into());
    }
    let mut command = Command::new(loc.binary());
    if installation.extract_and_run {
        command.arg("--appimage-extract-and-run");
    }
    // Do not carry a mounted AppImage's library paths or identity into the new runtime.
    for name in [
        "APPIMAGE",
        "APPDIR",
        "ARGV0",
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
    ] {
        command.env_remove(name);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Free the stable server port before the new copy starts, preserving the UI's storage origin.
    if let Some(state) = app.try_state::<crate::ServerChild>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    if let Err(error) = command.spawn() {
        // A failed exec leaves the current app usable, with the same server port and preferences.
        let _ = crate::boot_server(&app);
        return Err(format!(
            "Could not reopen Ancilla. Open it from the application menu: {error}"
        ));
    }
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        loc: Locations,
        image: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "ancilla-linux-{}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let uid = fs::metadata(&root).unwrap().uid();
            let image = root.join("Ancilla download.AppImage");
            fs::write(&image, b"\x7fELFpayload").unwrap();
            Self {
                loc: Locations {
                    install: root.join("data/installation"),
                    menu: root.join("applications/Ancilla.desktop"),
                    legacy_menu: root.join("applications/ancilla.desktop"),
                    legacy_appimage: root.join("Applications/Ancilla.AppImage"),
                    desktop: Some(root.join("Desktop/Ancilla.desktop")),
                    uid,
                },
                root,
                image,
            }
        }
        fn install(&self, shortcut: bool) -> Result<LinuxDesktopStatus, String> {
            install(
                &self.loc,
                "appimage",
                Some(&self.image),
                shortcut,
                "0.20.3",
                false,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn installs_stable_binary_menu_icon_and_optional_desktop_without_removing_download() {
        let fixture = Fixture::new();
        let result = fixture.install(true).unwrap();
        assert!(
            result.menu_installed && result.desktop_shortcut_installed && result.restart_required
        );
        assert_eq!(
            fs::read(fixture.loc.binary()).unwrap(),
            fs::read(&fixture.image).unwrap()
        );
        assert_eq!(
            fs::metadata(fixture.loc.binary())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        assert!(fs::read_to_string(&fixture.loc.menu)
            .unwrap()
            .contains("X-Ancilla-Managed=true"));
        assert!(fixture.loc.icon().is_file());
        assert!(fixture.install(true).is_ok());
        assert!(!status(&fixture.loc, "appimage", Some(&fixture.loc.binary())).restart_required);
    }

    #[test]
    fn menu_only_does_not_create_a_desktop_file() {
        let fixture = Fixture::new();
        let result = fixture.install(false).unwrap();
        assert!(result.menu_installed);
        assert!(!result.desktop_shortcut_installed);
        assert!(!fixture.loc.desktop.as_ref().unwrap().exists());
    }

    #[test]
    fn unavailable_desktop_does_not_block_application_menu_installation() {
        let mut fixture = Fixture::new();
        fixture.loc.desktop = None;
        let result = fixture.install(true).unwrap();
        assert!(result.menu_installed);
        assert!(!result.desktop_shortcut_installed);
        assert!(!result.desktop_shortcut_supported);
    }

    #[test]
    fn moves_the_old_lowercase_manual_menu_entry_without_duplicates() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.loc.menu.parent().unwrap()).unwrap();
        let old = format!("[Desktop Entry]\nName=Ancilla\nComment=Deep Research and agent monitoring\nExec=\"{}\"\n", fixture.loc.legacy_appimage.display());
        fs::write(&fixture.loc.legacy_menu, &old).unwrap();
        assert!(fixture.install(false).unwrap().menu_installed);
        assert!(!fixture.loc.legacy_menu.exists());
        assert_eq!(
            fs::read_to_string(fixture.loc.install.join("previous-manual-menu-shortcut")).unwrap(),
            old
        );
    }

    #[test]
    fn refuses_to_replace_a_newer_managed_appimage() {
        let fixture = Fixture::new();
        install(
            &fixture.loc,
            "appimage",
            Some(&fixture.image),
            false,
            "0.21.0",
            false,
        )
        .unwrap();
        let original = fs::read(fixture.loc.binary()).unwrap();
        assert!(fixture
            .install(false)
            .unwrap_err()
            .contains("newer Ancilla"));
        assert_eq!(fs::read(fixture.loc.binary()).unwrap(), original);
    }

    #[test]
    fn existing_shortcuts_and_symlinks_are_never_clobbered() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.loc.menu.parent().unwrap()).unwrap();
        fs::write(&fixture.loc.menu, "unrelated user shortcut").unwrap();
        assert!(fixture
            .install(false)
            .unwrap_err()
            .contains("left it unchanged"));
        assert_eq!(
            fs::read_to_string(&fixture.loc.menu).unwrap(),
            "unrelated user shortcut"
        );
        fs::remove_file(&fixture.loc.menu).unwrap();
        std::os::unix::fs::symlink(&fixture.image, &fixture.loc.menu).unwrap();
        assert!(fixture.install(false).is_err());
        assert_eq!(fs::read(&fixture.image).unwrap(), b"\x7fELFpayload");
    }

    #[test]
    fn migrates_the_documented_manual_shortcut_and_keeps_a_backup() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.loc.menu.parent().unwrap()).unwrap();
        let old = format!("[Desktop Entry]\nName=Ancilla\nComment=Deep Research and agent monitoring\nExec=\"{}\"\n", fixture.image.display());
        fs::write(&fixture.loc.menu, &old).unwrap();
        assert!(fixture.install(false).unwrap().menu_installed);
        assert_eq!(
            fs::read_to_string(fixture.loc.install.join("previous-menu-shortcut")).unwrap(),
            old
        );
    }

    #[test]
    fn package_shortcut_targets_the_package_and_never_copies_an_appimage() {
        let fixture = Fixture::new();
        let result = install(&fixture.loc, "package", None, true, "0.20.3", false).unwrap();
        assert!(result.menu_installed && result.desktop_shortcut_installed);
        assert!(!result.restart_required);
        assert!(!fixture.loc.binary().exists());
        assert!(!fixture.loc.menu.exists());
        assert!(fs::read_to_string(fixture.loc.desktop.as_ref().unwrap())
            .unwrap()
            .contains("Exec=\"/usr/bin/ancilla\""));
    }

    #[test]
    fn package_setup_repoints_an_earlier_managed_appimage_menu_entry() {
        let fixture = Fixture::new();
        fixture.install(false).unwrap();
        install(&fixture.loc, "package", None, true, "0.20.3", false).unwrap();
        assert!(fs::read_to_string(&fixture.loc.menu)
            .unwrap()
            .contains("Exec=\"/usr/bin/ancilla\""));
        assert!(
            fixture.loc.binary().exists(),
            "the previous portable binary is preserved"
        );
    }

    #[test]
    fn quotes_desktop_exec_without_interpreting_shell_syntax_or_field_codes() {
        assert_eq!(
            exec_argument(Path::new("/home/a b/Ancilla.AppImage")).unwrap(),
            "\"/home/a b/Ancilla.AppImage\""
        );
        let argument = exec_argument(Path::new("/tmp/$value`x`\\file\"%u")).unwrap();
        assert_eq!(
            argument,
            "\"/tmp/\\\\$value\\\\`x\\\\`\\\\\\\\file\\\\\"%%u\""
        );
        assert!(exec_argument(Path::new("/tmp/a\nExec=bad")).is_err());
    }

    #[test]
    fn failed_copy_preserves_the_existing_binary() {
        let fixture = Fixture::new();
        fixture.install(false).unwrap();
        let original = fs::read(fixture.loc.binary()).unwrap();
        let result = atomic_file(&fixture.loc.binary(), fixture.loc.uid, 0o755, |file| {
            file.write_all(b"partial")?;
            Err(std::io::Error::other("disk full"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(fixture.loc.binary()).unwrap(), original);
    }
}
