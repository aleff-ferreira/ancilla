// Ancilla native desktop host application (Tauri 2).
// Configured with Windows GUI subsystem to prevent terminal console flashing.
#![windows_subsystem = "windows"]

use std::ffi::{OsStr, OsString};
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::Emitter;

#[cfg(target_os = "linux")]
mod linux_desktop;

/// The local server and the write end of its stdin. The pipe is kept for the child's whole life: the server
/// closes itself when the pipe ends (`STDIN_WATCHDOG_FLAG`), which happens when the quit drops it here and, with
/// no help from anyone, when this process dies, so a sidecar never outlives a shell killed in Task Manager.
struct Sidecar {
    child: Child,
    stdin: Option<ChildStdin>,
}

/// What a graceful stop ended with: the server's own exit, or the kill after the grace. The quit does not act on
/// the code (the server is gone either way); the tests do.
#[allow(dead_code)]
enum StopOutcome {
    Exited(Option<i32>),
    Killed,
}

/// The longest a quit waits for the server to close itself before killing it: shutdown.ts gives the close
/// SHUTDOWN_DEADLINE_MS (20_000 ms; the server exits by then, 0 or 1), and the rest is the exit itself (exit hooks,
/// a process tree with wsl.exe children on Windows) on a loaded machine. A Node-side contract test reads these
/// numbers from this file, so they stay as two literals.
const SIDECAR_STOP_GRACE: Duration = Duration::from_millis(20_000 + 5_000);

/// How often a stop looks for the server's exit.
const STOP_POLL: Duration = Duration::from_millis(100);

/// Hidden server flag, passed last: close when stdin reaches its end. Only the desktop shell passes it, and the
/// server never defaults to it: stdin from /dev/null, a closed stdin and a parent that has exited all end at once,
/// so an unconditional watchdog would stop every server under systemd, Docker without -i, nohup and cron.
const STDIN_WATCHDOG_FLAG: &str = "--close-on-stdin-eof";

impl Sidecar {
    /// Spawns with a pipe to its stdin, which this handle keeps until the child is stopped or this process ends.
    fn spawn(cmd: &mut Command) -> std::io::Result<Sidecar> {
        let mut child = cmd.stdin(Stdio::piped()).spawn()?;
        let stdin = child.stdin.take();
        Ok(Sidecar { child, stdin })
    }

    /// The updater's exit, the Linux reopen and the resource drop: at once, and waited for, so the port is free
    /// and node.exe is closed before the installer replaces it or the next copy starts.
    fn kill_and_wait(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// The quit path: end of stdin, then the server's own close (its deadline is inside `grace`), then the kill.
    fn stop_gracefully(mut self, grace: Duration) -> StopOutcome {
        drop(self.stdin.take());
        let started = Instant::now();
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => return StopOutcome::Exited(status.code()),
                Ok(None) if started.elapsed() < grace => std::thread::sleep(STOP_POLL),
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    return StopOutcome::Killed;
                }
            }
        }
    }
}

struct ServerChild(Arc<Mutex<Option<Sidecar>>>);

/// Stops the local server, killed and waited for, when Tauri clears its resources (`cleanup_before_exit`): on
/// every exit, and right before the updater quits the app to run the installer, since the updater builder the
/// plugin's `check` command uses registers that cleanup as its `on_before_exit` (tauri-plugin-updater 2.11,
/// `updater_builder`); the plugin offers no other hook. The wait is what lets the NSIS installer replace
/// node.exe. A normal quit has already stopped the server from the window's Destroyed handler, and finds nothing.
struct ServerGuard(Arc<Mutex<Option<Sidecar>>>);

impl tauri::Resource for ServerGuard {}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        let taken = locked(&self.0).take();
        if let Some(sidecar) = taken {
            sidecar.kill_and_wait();
        }
    }
}

/// A poisoned lock holds nothing the next user cannot read; the thread that poisoned it is the one that failed.
fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Where the quit is. A stop begins once, from the window's Destroyed handler; while it runs the event loop is
/// kept open (`prevent_exit`) with no window, and the stop thread ends the app when the server has closed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum QuitPhase {
    #[default]
    Idle,
    Stopping,
    Stopped,
}

/// What `Quit::begin` found: something to stop, nothing (the quit is over at once), or a quit already begun.
enum Began<T> {
    Stop(T),
    Nothing,
    Already,
}

/// What the Exit event does with the sidecar it finds: stop it gracefully (an exit that no window's close began),
/// kill it and wait (an exit that asked for no graceful stop), or nothing (a stop already ran).
enum AtExit<T> {
    Stop(T),
    Kill(T),
    Nothing,
}

#[derive(Default)]
struct Quit {
    phase: Mutex<QuitPhase>,
    /// Set by the Linux reopen before `app.exit`, and by an exit with a code other than 0 (the updater's, a
    /// restart's): those are not user quits and get no graceful stop.
    immediate: AtomicBool,
    /// A copy of Ancilla to start from the Exit event, once the sidecar is dead and the plugins have let go of
    /// their names: the Linux reopen, or a second launch that arrived while this one was quitting.
    relaunch: Mutex<Option<Command>>,
}

impl Quit {
    /// The one transition out of Idle. `take` runs under the lock, so a sidecar handed over here is never also
    /// kept by a boot that saw Idle a moment earlier (`admit`).
    fn begin<T>(&self, take: impl FnOnce() -> Option<T>) -> Began<T> {
        let mut phase = locked(&self.phase);
        if *phase != QuitPhase::Idle {
            return Began::Already;
        }
        match take() {
            Some(running) => {
                *phase = QuitPhase::Stopping;
                Began::Stop(running)
            }
            None => {
                *phase = QuitPhase::Stopped;
                Began::Nothing
            }
        }
    }

    fn finish(&self) {
        *locked(&self.phase) = QuitPhase::Stopped;
    }

    fn phase(&self) -> QuitPhase {
        *locked(&self.phase)
    }

    /// Keeps `value` through `store` while no quit has begun; hands it back otherwise, for the caller to end.
    fn admit<T>(&self, value: T, store: impl FnOnce(T)) -> Option<T> {
        let phase = locked(&self.phase);
        if *phase != QuitPhase::Idle {
            return Some(value);
        }
        store(value);
        None
    }

    fn remember_relaunch(&self, command: Command) {
        *locked(&self.relaunch) = Some(command);
    }

    fn take_relaunch(&self) -> Option<Command> {
        locked(&self.relaunch).take()
    }

    /// The Exit event's share of the quit. macOS ends a Dock Quit with `terminate:`, which tao delivers as the Exit
    /// event alone, with no ExitRequested and no window close before it; no stop has begun then, and none is
    /// coming, so it runs here (no window remains, and blocking the main thread is acceptable). An exit that asked
    /// for no graceful stop kills the sidecar and waits for it instead. Either way the sidecar is gone before a
    /// copy of Ancilla is started from this event.
    fn at_exit<T>(&self, take: impl FnOnce() -> Option<T>) -> AtExit<T> {
        if self.exits_at_once() {
            return take().map_or(AtExit::Nothing, AtExit::Kill);
        }
        match self.begin(take) {
            Began::Stop(running) => AtExit::Stop(running),
            Began::Nothing | Began::Already => AtExit::Nothing,
        }
    }

    /// An exit that is not a user quit: the Linux reopen, the updater's, a restart's.
    fn exit_at_once(&self) {
        self.immediate.store(true, Ordering::SeqCst);
    }

    fn exits_at_once(&self) -> bool {
        self.immediate.load(Ordering::SeqCst)
    }
}

/// Begins the graceful stop once, on its own thread; the window is already gone when this runs. Later calls do
/// nothing: the stop thread ends the app itself when the server has closed or the grace has passed. Answers
/// whether a stop thread now owns the exit: with nothing to stop, nothing will end the app but the caller.
fn begin_graceful_quit(app: &tauri::AppHandle) -> bool {
    let quit = app.state::<Quit>();
    let slot = app.state::<ServerChild>().0.clone();
    let sidecar = match quit.begin(|| locked(&slot).take()) {
        Began::Stop(sidecar) => sidecar,
        Began::Nothing | Began::Already => return false,
    };
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = sidecar.stop_gracefully(SIDECAR_STOP_GRACE);
        handle.state::<Quit>().finish();
        handle.exit(0);
    });
    true
}

/// This executable with the arguments it was started with: what a second launch that arrived mid-quit asked for.
/// Under an AppImage the image itself is run, not the binary mounted from it, which goes away with this process;
/// it is started as the reopen does, with the dying mount's environment removed and, on a machine without FUSE,
/// the flag the AppImage runtime takes out of the arguments it hands on.
fn relaunch_command(app: &tauri::AppHandle) -> Option<Command> {
    let env = app.env();
    let binary = tauri::process::current_binary(&env).ok()?;
    #[cfg(target_os = "linux")]
    let mut command = if linux_desktop::installation_kind() == "appimage" {
        linux_desktop::appimage_command(binary, linux_desktop::extract_and_run_active())
    } else {
        Command::new(binary)
    };
    #[cfg(not(target_os = "linux"))]
    let mut command = Command::new(binary);
    command.args(env.args_os.iter().skip(1));
    Some(command)
}

/// A second launch, forwarded by the running copy's single-instance plugin: focus the window, or, while this copy
/// is quitting, remember to start a fresh one once the stop is over.
fn single_instance_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        let Some(quit) = app.try_state::<Quit>() else {
            return;
        };
        if quit.phase() != QuitPhase::Idle {
            if let Some(command) = relaunch_command(app) {
                quit.remember_relaunch(command);
            }
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
}

/// Custom frame configuration: Windows renders client-side UI titlebars.
const CUSTOM_FRAME: bool = cfg!(windows);

/// Injected script signaling client UI to activate custom titlebar chrome.
const FRAME_SCRIPT: &str = "window.__ANCILLA_FRAME__ = 'custom';";

/// Injected script on macOS signaling overlay traffic lights positioning.
#[cfg(target_os = "macos")]
const OVERLAY_SCRIPT: &str = "window.__ANCILLA_TITLEBAR__ = 'overlay';";

/// Storage filename for persisting allocated HTTP server port.
const PORT_FILE: &str = "server-port";

/// The server's record of who owns the data folder, inside it: one JSON line it writes on start and removes on
/// close. Read here only after the server refused to start because another copy holds it.
const OWNER_FILE: &str = "ancilla.owner";

/// The server's exit code for "the data folder is owned by a live Ancilla": sysexits EX_TEMPFAIL, the same number
/// as EXIT_DATA_DIR_OWNED in packages/server/src/exitCodes.ts. The server wrote one line to stderr and nothing to
/// stdout; this shell shows its own page and neither retries on another port nor touches server-port.
const EXIT_DATA_DIR_OWNED: i32 = 75;

/// How long the first stdout line may take. The server's boot budget is 20 s (a wait of up to 10 s for a data
/// folder another copy is still releasing, then the store and the boot sweeps, cut when the budget ends), and a
/// slow disk adds to that; a line that is late is only late, so the wait is generous.
const READY_LINE_DEADLINE: Duration = Duration::from_secs(45);

/// server.log is the server's stderr, an inherited handle nothing in the server can rotate; the crash output of
/// node itself has to land there too. It is rotated here, before each start: above this size the previous file is
/// kept once as server.log.1 and a new one begins.
const SERVER_LOG_CAP: u64 = 8 * 1024 * 1024;

/// The style every inline page shares; the splash has its own.
const PAGE_STYLE: &str = "html{color-scheme:light dark;background:Canvas;color:CanvasText;font:14px/1.5 system-ui,sans-serif}body{margin:0;height:100vh;display:grid;place-items:center}main{max-width:420px;padding:24px}p{color:GrayText}";

/// Shown the instant the window opens, while the local server starts. System colors follow the OS theme.
const SPLASH_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Ancilla</title><style>html{color-scheme:light dark;background:Canvas;color:GrayText;font:13px system-ui,sans-serif}body{margin:0;height:100vh;display:grid;place-items:center}</style><body>Starting Ancilla</body>";

const MISSING_NODE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Ancilla</title><style>html{color-scheme:light dark;background:Canvas;color:CanvasText;font:14px/1.5 system-ui,sans-serif}body{margin:0;height:100vh;display:grid;place-items:center}main{max-width:420px;padding:24px}p{color:GrayText}</style><main><h1 style=font-size:20px>Ancilla needs Node.js</h1><p>Ancilla could not start its local server because its bundled Node.js is missing and Node.js 22 or newer was not found on this computer. Reinstall Ancilla, or install Node.js 22 or newer, then open Ancilla again.</p></main>";

const MISSING_SERVER_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Ancilla</title><style>html{color-scheme:light dark;background:Canvas;color:CanvasText;font:14px/1.5 system-ui,sans-serif}body{margin:0;height:100vh;display:grid;place-items:center}main{max-width:420px;padding:24px}p{color:GrayText}</style><main><h1 style=font-size:20px>Ancilla is missing files</h1><p>The bundled Ancilla server was not found next to the app. Reinstall Ancilla to restore it.</p></main>";

const SERVER_FAILED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Ancilla</title><style>html{color-scheme:light dark;background:Canvas;color:CanvasText;font:14px/1.5 system-ui,sans-serif}body{margin:0;height:100vh;display:grid;place-items:center}main{max-width:420px;padding:24px}p{color:GrayText}</style><main><h1 style=font-size:20px>Ancilla could not start</h1><p>Its local server did not come up. The server log in the Ancilla app log folder has the details. Close Ancilla and open it again to retry.</p></main>";

/// The scheme of the app's own that serves the splash and the error pages. None of them can be a `data:` address:
/// the webview rebuilds the page's address as an http request for every message a page sends to the app, a
/// plugin's start-up script sends one on load, and an address that is no http URI aborts the app (seen on
/// Linux with the "already open" page). The splash can stay up for the whole boot budget over a contended
/// data folder, so it is served the same way.
const PAGE_SCHEME: &str = "ancilla";

/// The splash's path on the scheme.
const SPLASH_PATH: &str = "/splash";

/// The error page's path on the scheme.
const ERROR_PATH: &str = "/error";

/// Where the window finds a page of the app's own: Windows reaches an app scheme through a host of that name.
fn page_url(path: &str) -> String {
    if cfg!(windows) {
        format!("http://{PAGE_SCHEME}.localhost{path}")
    } else {
        format!("{PAGE_SCHEME}://localhost{path}")
    }
}

fn splash_page_url() -> String {
    page_url(SPLASH_PATH)
}

fn error_page_url() -> String {
    page_url(ERROR_PATH)
}

/// The error page the window shows instead of the UI, set by the boot before it navigates there.
#[derive(Default)]
struct ErrorPage(Mutex<Option<String>>);

/// The answer of the app scheme for `path`: the splash, the error page that was set, or nothing: before any
/// error page was set, and for any other path.
fn page_response(path: &str, error_page: Option<String>) -> tauri::http::Response<Vec<u8>> {
    let page = match path {
        SPLASH_PATH => Some(SPLASH_PAGE.to_string()),
        ERROR_PATH => error_page,
        _ => None,
    };
    let (status, body): (u16, Vec<u8>) = match page {
        Some(html) => (200, html.into_bytes()),
        None => (404, Vec::new()),
    };
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .body(body)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// The platform name the server writes into the owner record (Node's `process.platform`), for this build.
const NODE_PLATFORM: &str = if cfg!(windows) {
    "win32"
} else if cfg!(target_os = "macos") {
    "darwin"
} else {
    std::env::consts::OS
};

/// The owner record the server keeps in the data folder. Every field is optional: the page is built from what
/// can be read, and a record from a future build may carry more. The whole record is read so that a wrong
/// shape is noticed; the page needs only the address and the platform.
#[allow(dead_code)]
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct OwnerRecord {
    format: Option<u32>,
    instance_id: Option<String>,
    pid: Option<u64>,
    host: Option<String>,
    port: Option<u16>,
    started_at: Option<String>,
    closing_at: Option<String>,
    ancilla_version: Option<String>,
    platform: Option<String>,
}

impl OwnerRecord {
    /// Where the running copy answers, when the record names a bound port and a host that can go into a link.
    fn url(&self) -> Option<String> {
        let port = self.port?;
        let host = self.host.as_deref().unwrap_or_default();
        if !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')) {
            return None;
        }
        let host = match host {
            "" | "0.0.0.0" | "::" => "127.0.0.1".to_string(),
            v6 if v6.contains(':') && !v6.starts_with('[') => format!("[{v6}]"),
            other => other.to_string(),
        };
        Some(format!("http://{host}:{port}/"))
    }

    /// A record written on another system (a WSL command line over the Windows folder, or the reverse) names a
    /// pid of another kernel and a loopback this one cannot reach, so the server refuses it until the file is gone.
    fn from_another_platform(&self) -> bool {
        self.platform.as_deref().is_some_and(|platform| platform != NODE_PLATFORM)
    }
}

fn read_owner_record(data_dir: &Path) -> Option<OwnerRecord> {
    let text = std::fs::read_to_string(data_dir.join(OWNER_FILE)).ok()?;
    serde_json::from_str(text.lines().next()?).ok()
}

/// The page for a data folder another Ancilla owns. The link to the running copy stays in this window (loopback
/// addresses are never sent to the browser), so the user lands in the other copy's UI with no IPC at all.
fn owned_page(owner: Option<&OwnerRecord>) -> String {
    let open = owner
        .and_then(OwnerRecord::url)
        .map(|url| format!("<p><a href=\"{url}\">Open the running copy</a></p>"))
        .unwrap_or_default();
    let elsewhere = if owner.is_some_and(OwnerRecord::from_another_platform) {
        format!("<p>The record was written by Ancilla on another system. If no Ancilla is running there, delete the file {OWNER_FILE} in the Ancilla data folder and open Ancilla again.</p>")
    } else {
        String::new()
    };
    format!("<!doctype html><meta charset=utf-8><title>Ancilla</title><style>{PAGE_STYLE}</style><main><h1 style=font-size:20px>Ancilla is already open</h1><p>Another copy of Ancilla is using your data folder: a window on another desktop, a copy that is still closing, or an ancilla-server started by hand. Close it, then open Ancilla again.</p>{open}{elsewhere}</main>")
}

enum BootError {
    NodeMissing,
    ServerMissing,
    ServerFailed,
    /// The server exited with EXIT_DATA_DIR_OWNED; the record is what the data folder held afterwards.
    DataDirOwned(Option<OwnerRecord>),
}

impl BootError {
    /// The page's HTML, served at `error_page_url`.
    fn page(&self) -> String {
        match self {
            BootError::NodeMissing => MISSING_NODE_PAGE.to_string(),
            BootError::ServerMissing => MISSING_SERVER_PAGE.to_string(),
            BootError::ServerFailed => SERVER_FAILED_PAGE.to_string(),
            BootError::DataDirOwned(owner) => owned_page(owner.as_ref()),
        }
    }
}

/// Reason for a child server startup failure.
#[derive(Debug, PartialEq, Eq)]
enum StartFailure {
    Exited,
    Failed,
    Owned,
}

/// Categorizes exit status into StartFailure variants.
fn classify_exit(status: Option<ExitStatus>) -> StartFailure {
    match status {
        Some(st) if st.code() == Some(EXIT_DATA_DIR_OWNED) => StartFailure::Owned,
        Some(_) => StartFailure::Exited,
        None => StartFailure::Failed,
    }
}

/// Strips Windows verbatim UNC and device prefixes (`\\?\` and `\\?\UNC\`) from path.
fn plain_path(path: &Path) -> PathBuf {
    let raw_str = path.to_string_lossy();
    if let Some(unc_suffix) = raw_str.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc_suffix}"));
    }
    if let Some(plain_suffix) = raw_str.strip_prefix(r"\\?\") {
        return PathBuf::from(plain_suffix);
    }
    path.to_path_buf()
}

/// Resolves bundled asset by looking under `resources/<name>` or `<name>`.
fn find_resource(resource_dir: &Path, name: &str) -> Option<PathBuf> {
    let subfolder_target = resource_dir.join("resources").join(name);
    if subfolder_target.exists() {
        return Some(plain_path(&subfolder_target));
    }
    let direct_target = resource_dir.join(name);
    if direct_target.exists() {
        return Some(plain_path(&direct_target));
    }
    None
}

fn saved_port(data_dir: Option<&Path>) -> Option<u16> {
    let target_dir = data_dir?;
    let content = std::fs::read_to_string(target_dir.join(PORT_FILE)).ok()?;
    let parsed_val = content.trim().parse::<u16>().ok()?;
    if parsed_val == 0 {
        None
    } else {
        Some(parsed_val)
    }
}

fn stable_port(data_dir: Option<&Path>) -> u16 {
    saved_port(data_dir).unwrap_or_else(fresh_port)
}

fn fresh_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|sock| sock.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(0)
}

fn remember_port(data_dir: Option<&Path>, url: &str) {
    let Some(dir) = data_dir else {
        return;
    };
    let Some(port) = announced_port(url) else {
        return;
    };
    if saved_port(Some(dir)) != Some(port) {
        let _ = std::fs::write(dir.join(PORT_FILE), port.to_string());
    }
}

fn announced_port(url: &str) -> Option<u16> {
    url.parse::<Url>().ok()?.port()
}

fn start_with_retry<T>(
    port: u16,
    fresh: impl FnOnce() -> u16,
    quitting: impl Fn() -> bool,
    mut spawn: impl FnMut(u16) -> Result<T, StartFailure>,
) -> Result<T, BootError> {
    match spawn(port) {
        Ok(res) => Ok(res),
        Err(StartFailure::Owned) => Err(BootError::DataDirOwned(None)),
        Err(StartFailure::Exited) if quitting() => Err(BootError::ServerFailed),
        Err(StartFailure::Exited) => {
            let alternative_port = fresh();
            spawn(alternative_port).map_err(|_| BootError::ServerFailed)
        }
        Err(StartFailure::Failed) => Err(BootError::ServerFailed),
    }
}

fn command<S: AsRef<OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut process_cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const FLAG_CREATE_NO_WINDOW: u32 = 0x0800_0000;
        process_cmd.creation_flags(FLAG_CREATE_NO_WINDOW);
    }
    process_cmd
}

fn node_runs(program: &Path) -> bool {
    command(program)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|st| st.success())
        .unwrap_or(false)
}

fn bundled_node(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(r_dir) = resource_dir {
        if let Some(found_node) = find_resource(r_dir, "node").filter(|p| p.is_file()) {
            return Some(found_node);
        }
    }
    let current_binary = std::env::current_exe().ok()?;
    let exe_parent = current_binary.parent()?;
    bundled_node_in(exe_parent)
}

fn bundled_node_in(dir: &Path) -> Option<PathBuf> {
    let filename = if cfg!(windows) { "node.exe" } else { "node" };
    let candidate = dir.join(filename);
    if candidate.is_file() {
        Some(plain_path(&candidate))
    } else {
        None
    }
}

fn find_node(resource_dir: &Path) -> Option<PathBuf> {
    if let Some(local_runtime) = bundled_node(Some(resource_dir)).filter(|node| node_runs(node)) {
        return Some(local_runtime);
    }

    let mut candidate_list = vec![PathBuf::from("node")];

    #[cfg(unix)]
    {
        if let Some(default_sh_node) = shell_probe("/bin/sh", &["-lc", "command -v node"]) {
            candidate_list.push(default_sh_node);
        }

        if let Ok(user_shell) = std::env::var("SHELL") {
            if user_shell != "/bin/sh" {
                let lookup_command = if user_shell.ends_with("csh") {
                    "which node"
                } else {
                    "command -v node"
                };
                if let Some(user_shell_node) = shell_probe(&user_shell, &["-li", "-c", lookup_command]) {
                    candidate_list.push(user_shell_node);
                }
            }
        }

        candidate_list.extend(well_known_nodes());
    }

    candidate_list.into_iter().find(|binary| node_runs(binary))
}

#[cfg(unix)]
fn shell_probe(shell: &str, args: &[&str]) -> Option<PathBuf> {
    let shell_path = shell.to_string();
    let command_args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let (tx_channel, rx_channel) = mpsc::channel();

    std::thread::spawn(move || {
        let exec_result = command(&shell_path).args(&command_args).output().ok();
        let _ = tx_channel.send(exec_result);
    });

    let probe_output = rx_channel.recv_timeout(Duration::from_secs(10)).ok()??;
    if !probe_output.status.success() {
        return None;
    }

    select_probe_path(&String::from_utf8_lossy(&probe_output.stdout))
}

#[cfg(unix)]
fn select_probe_path(output: &str) -> Option<PathBuf> {
    output
        .lines()
        .rev()
        .map(str::trim)
        .filter(|row| !row.is_empty())
        .map(PathBuf::from)
        .find(|loc| loc.is_absolute() && loc.is_file())
}

#[cfg(unix)]
fn well_known_nodes() -> Vec<PathBuf> {
    let Some(user_home_dir) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    well_known_nodes_in(&user_home_dir)
}

#[cfg(unix)]
fn well_known_nodes_in(home: &Path) -> Vec<PathBuf> {
    let mut standard_paths = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/opt/local/bin/node"),
        home.join(".local/bin/node"),
        home.join(".volta/bin/node"),
        home.join(".asdf/shims/node"),
        home.join(".local/share/mise/shims/node"),
        home.join(".fnm/aliases/default/bin/node"),
    ];

    if let Some(nvm_active_binary) = latest_nvm_node(home) {
        standard_paths.push(nvm_active_binary);
    }

    standard_paths.into_iter().filter(|p| p.is_file()).collect()
}

#[cfg(unix)]
fn latest_nvm_node(home: &Path) -> Option<PathBuf> {
    let version_parent = home.join(".nvm/versions/node");
    let directory_iter = std::fs::read_dir(version_parent).ok()?;
    let mut detected_releases: Vec<(Vec<u64>, PathBuf)> = Vec::new();

    for dir_entry in directory_iter.flatten() {
        let folder_name = dir_entry.file_name().to_string_lossy().into_owned();
        let Some(semver_slice) = folder_name.strip_prefix('v') else {
            continue;
        };

        let parsed_segments: Option<Vec<u64>> = semver_slice
            .split('.')
            .map(|tok| tok.parse::<u64>().ok())
            .collect();

        let binary_path = dir_entry.path().join("bin/node");
        if let (Some(num_parts), true) = (parsed_segments, binary_path.is_file()) {
            detected_releases.push((num_parts, binary_path));
        }
    }

    detected_releases.sort_by(|entry_a, entry_b| entry_a.0.cmp(&entry_b.0));
    detected_releases.pop().map(|(_, target_node)| target_node)
}

#[cfg(unix)]
fn augmented_path(node: &Path, resource_dir: Option<&Path>) -> Option<OsString> {
    let home_dir = std::env::var_os("HOME").map(PathBuf::from);
    let mut prepend_dirs: Vec<PathBuf> = Vec::new();

    if node.is_absolute() && bundled_node(resource_dir).as_deref() != Some(node) {
        if let Some(node_parent) = node.parent() {
            prepend_dirs.push(node_parent.to_path_buf());
        }
    }

    let mut common_search_folders = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/local/bin"),
    ];

    if let Some(user_home) = &home_dir {
        common_search_folders.push(user_home.join(".local/bin"));
        common_search_folders.push(user_home.join(".volta/bin"));
        common_search_folders.push(user_home.join(".asdf/shims"));
    }

    prepend_dirs.extend(common_search_folders.into_iter().filter(|d| d.is_dir()));
    if prepend_dirs.is_empty() {
        return None;
    }

    Some(prepend_to_path(&prepend_dirs, std::env::var_os("PATH")))
}

#[cfg(unix)]
fn prepend_to_path(prepend: &[PathBuf], current: Option<OsString>) -> OsString {
    let mut resulting_elements: Vec<OsString> = prepend.iter().map(|d| d.as_os_str().to_os_string()).collect();
    let existing_elements: Vec<PathBuf> = current
        .as_ref()
        .map(|raw| std::env::split_paths(raw).collect())
        .unwrap_or_default();

    resulting_elements.retain(|dir_os| !existing_elements.iter().any(|ex| ex.as_os_str() == dir_os));

    if let Some(base_path) = current {
        if !base_path.is_empty() {
            resulting_elements.push(base_path);
        }
    }

    let mut assembled_path = OsString::new();
    for (idx, seg) in resulting_elements.iter().enumerate() {
        if idx > 0 {
            assembled_path.push(":");
        }
        assembled_path.push(seg);
    }
    assembled_path
}

fn wait_for_url(child: &mut Child) -> Option<String> {
    let child_stdout = child.stdout.take()?;
    let (tx_line, rx_line) = mpsc::channel();

    std::thread::spawn(move || {
        let mut line_reader = BufReader::new(child_stdout);
        let mut text_buffer = String::new();
        if line_reader.read_line(&mut text_buffer).is_ok() {
            let _ = tx_line.send(text_buffer);
        }
    });

    let first_line = rx_line.recv_timeout(READY_LINE_DEADLINE).ok()?;
    parse_listening_url(&first_line)
}

fn parse_listening_url(line: &str) -> Option<String> {
    let listening_prefix = "ancilla-server listening on ";
    let remainder = line.strip_prefix(listening_prefix)?.trim();
    if remainder.starts_with("http://") {
        Some(remainder.to_string())
    } else {
        None
    }
}

/// The server's arguments, the watchdog flag last.
fn server_args(server: &Path, port: u16, frontend: Option<&Path>, data: Option<&Path>) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![server.into(), "--port".into(), port.to_string().into()];
    if let Some(frontend) = frontend {
        args.push("--static".into());
        args.push(frontend.into());
    }
    if let Some(data) = data {
        args.push("--data-dir".into());
        args.push(data.into());
    }
    args.push(STDIN_WATCHDOG_FLAG.into());
    args
}

/// The path of server.log in `dir`, after moving a file above `cap` aside as server.log.1 (replacing the previous
/// one). A move that fails leaves the log to grow; nothing is lost over a rotation that did not happen.
fn rotate_server_log(dir: &Path, cap: u64) -> PathBuf {
    let log = dir.join("server.log");
    if std::fs::metadata(&log).map(|meta| meta.len() > cap).unwrap_or(false) {
        let _ = std::fs::rename(&log, dir.join("server.log.1"));
    }
    log
}

fn spawn_server(
    app: &tauri::AppHandle,
    node: &Path,
    server: &Path,
    frontend: Option<&Path>,
    data: Option<&Path>,
    port: u16,
) -> Result<(Sidecar, String), StartFailure> {
    let mut server_process = command(node);

    #[cfg(unix)]
    if let Some(custom_path) = augmented_path(node, app.path().resource_dir().ok().as_deref()) {
        server_process.env("PATH", custom_path);
    }

    server_process.args(server_args(server, port, frontend, data));

    let log_file_handle = app
        .path()
        .app_log_dir()
        .ok()
        .map(|d| plain_path(&d))
        .and_then(|d| std::fs::create_dir_all(&d).ok().map(|_| rotate_server_log(&d, SERVER_LOG_CAP)))
        .and_then(|log_path| OpenOptions::new().create(true).append(true).open(log_path).ok());

    server_process
        .stdout(Stdio::piped())
        .stderr(log_file_handle.map(Stdio::from).unwrap_or_else(Stdio::null));

    let mut sidecar_instance = Sidecar::spawn(&mut server_process).map_err(|_| StartFailure::Failed)?;

    if let Some(announced_address) = wait_for_url(&mut sidecar_instance.child) {
        return Ok((sidecar_instance, announced_address));
    }

    let mut termination_status = None;
    for _ in 0..20 {
        if let Ok(Some(finished_status)) = sidecar_instance.child.try_wait() {
            termination_status = Some(finished_status);
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let failure_kind = classify_exit(termination_status);
    sidecar_instance.kill_and_wait();
    Err(failure_kind)
}

fn boot_server(app: &tauri::AppHandle) -> Result<String, BootError> {
    let app_resource_directory = app.path().resource_dir().map_err(|_| BootError::ServerMissing)?;
    let node_executable = find_node(&app_resource_directory).ok_or(BootError::NodeMissing)?;
    let server_bundle = find_resource(&app_resource_directory, "server.cjs").ok_or(BootError::ServerMissing)?;
    let static_frontend = find_resource(&app_resource_directory, "frontend");

    let persistent_data_dir = app
        .path()
        .app_data_dir()
        .ok()
        .filter(|dir| std::fs::create_dir_all(dir).is_ok())
        .map(|dir| plain_path(&dir));

    let quit_coordinator = app.state::<Quit>();
    let (active_sidecar, active_url) = start_with_retry(
        stable_port(persistent_data_dir.as_deref()),
        fresh_port,
        || quit_coordinator.phase() != QuitPhase::Idle,
        |candidate_port| spawn_server(app, &node_executable, &server_bundle, static_frontend.as_deref(), persistent_data_dir.as_deref(), candidate_port),
    )
    .map_err(|boot_err| match boot_err {
        BootError::DataDirOwned(_) => BootError::DataDirOwned(persistent_data_dir.as_deref().and_then(read_owner_record)),
        other_err => other_err,
    })?;

    remember_port(persistent_data_dir.as_deref(), &active_url);
    let child_state = app.state::<ServerChild>();

    if let Some(orphaned_sidecar) = quit_coordinator.admit(active_sidecar, |sc| *locked(&child_state.0) = Some(sc)) {
        orphaned_sidecar.kill_and_wait();
        return Err(BootError::ServerFailed);
    }

    app.resources_table().add(ServerGuard(child_state.0.clone()));
    Ok(active_url)
}

#[cfg(target_os = "macos")]
fn install_zoom_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let item_zoom_in = MenuItemBuilder::with_id("zoom-in", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let item_zoom_out = MenuItemBuilder::with_id("zoom-out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let item_zoom_reset = MenuItemBuilder::with_id("zoom-reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let item_quit = MenuItemBuilder::with_id("quit", "Quit Ancilla")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let app_submenu = SubmenuBuilder::new(app, "Ancilla")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&item_quit)
        .build()?;

    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(&item_zoom_in)
        .item(&item_zoom_out)
        .item(&item_zoom_reset)
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .separator()
        .close_window()
        .build()?;

    let macos_menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .item(&window_submenu)
        .build()?;

    app.set_menu(macos_menu)?;

    app.on_menu_event(|app_handle, menu_event| {
        let zoom_action = match menu_event.id().0.as_str() {
            "zoom-in" => "in",
            "zoom-out" => "out",
            "zoom-reset" => "reset",
            "quit" => {
                match app_handle.get_webview_window("main") {
                    Some(main_win) => {
                        let _ = main_win.close();
                    }
                    None => app_handle.exit(0),
                }
                return;
            }
            _ => return,
        };
        let _ = app_handle.emit("ancilla://zoom", zoom_action);
    });

    Ok(())
}

fn is_external_link(url: &Url) -> bool {
    match url.scheme() {
        "mailto" => true,
        "http" | "https" => {
            let host_str = url.host_str().unwrap_or_default();
            !matches!(host_str, "127.0.0.1" | "localhost" | "[::1]" | "ipc.localhost" | "tauri.localhost" | "ancilla.localhost")
        }
        _ => false,
    }
}

fn main() {
    let mut app_builder = tauri::Builder::default();

    #[cfg(not(target_os = "linux"))]
    {
        app_builder = app_builder.plugin(single_instance_plugin());
    }

    #[cfg(target_os = "linux")]
    {
        if linux_desktop::session_bus_likely() {
            app_builder = app_builder.plugin(single_instance_plugin());
        }
    }

    #[cfg(target_os = "linux")]
    {
        if linux_desktop::installation_kind() == "appimage" {
            app_builder = app_builder.plugin(tauri_plugin_updater::Builder::new().build());
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        app_builder = app_builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    #[cfg(target_os = "linux")]
    {
        app_builder = app_builder.invoke_handler(tauri::generate_handler![
            linux_desktop::linux_installation_status,
            linux_desktop::install_linux_launcher,
            linux_desktop::relaunch_installed_linux,
        ]);
    }

    app_builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ServerChild(Arc::new(Mutex::new(None))))
        .manage(Quit::default())
        .manage(ErrorPage::default())
        .register_uri_scheme_protocol(PAGE_SCHEME, |context, request| {
            let page_state = context.app_handle().state::<ErrorPage>();
            let custom_error_page = locked(&page_state.0).clone();
            page_response(request.uri().path(), custom_error_page)
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            install_zoom_menu(app)?;

            let splash_address = splash_page_url().parse()?;
            let mut window_config = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(splash_address))
                .title("Ancilla")
                .inner_size(1280.0, 820.0)
                .min_inner_size(880.0, 560.0)
                .disable_drag_drop_handler()
                .on_new_window(|nav_url, _win_features| {
                    if is_external_link(&nav_url) {
                        let _ = tauri_plugin_opener::open_url(nav_url.as_str(), None::<&str>);
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_navigation(|dest_url| {
                    if is_external_link(dest_url) {
                        let _ = tauri_plugin_opener::open_url(dest_url.as_str(), None::<&str>);
                        return false;
                    }
                    true
                });

            if CUSTOM_FRAME {
                window_config = window_config.decorations(false).initialization_script(FRAME_SCRIPT);
            }

            #[cfg(target_os = "linux")]
            {
                window_config = window_config.initialization_script(format!(
                    "window.__ANCILLA_LINUX_INSTALL__ = '{}';",
                    linux_desktop::installation_kind()
                ));
            }

            #[cfg(target_os = "macos")]
            {
                window_config = window_config
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(20.0, 20.0))
                    .initialization_script(OVERLAY_SCRIPT);
            }

            let primary_window = window_config.build()?;

            #[cfg(target_os = "linux")]
            {
                let _ = primary_window.with_webview(|webview_handle| {
                    use glib::prelude::Cast;
                    use webkit2gtk::{
                        PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
                        UserMediaPermissionRequestExt, WebViewExt,
                    };
                    let webview_inner = webview_handle.inner();
                    if let Some(engine_settings) = webview_inner.settings() {
                        engine_settings.set_enable_media_stream(true);
                    }
                    webview_inner.connect_permission_request(|wv_ref, permission_req| {
                        let Some(user_media_req) = permission_req.downcast_ref::<UserMediaPermissionRequest>() else {
                            return false;
                        };
                        let is_localhost_uri = wv_ref
                            .uri()
                            .and_then(|u_str| Url::parse(u_str.as_str()).ok())
                            .map(|parsed_u| {
                                matches!(parsed_u.scheme(), "http" | "https")
                                    && matches!(parsed_u.host_str(), Some("127.0.0.1") | Some("localhost"))
                            })
                            .unwrap_or(false);
                        if is_localhost_uri && user_media_req.is_for_audio_device() && !user_media_req.is_for_video_device() {
                            permission_req.allow();
                        } else {
                            permission_req.deny();
                        }
                        true
                    });
                });
            }

            let async_app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let destination_target = match boot_server(&async_app_handle) {
                    Ok(announced_url) => announced_url,
                    Err(startup_error) => {
                        if CUSTOM_FRAME {
                            let _ = primary_window.set_decorations(true);
                        }
                        let error_page_store = async_app_handle.state::<ErrorPage>();
                        *locked(&error_page_store.0) = Some(startup_error.page());
                        error_page_url()
                    }
                };

                if let Ok(parsed_target_url) = destination_target.parse::<Url>() {
                    let _ = primary_window.navigate(parsed_target_url);
                }
            });

            Ok(())
        })
        .on_window_event(|win_handle, win_event| {
            if win_handle.label() == "main" {
                if let tauri::WindowEvent::Destroyed = win_event {
                    begin_graceful_quit(win_handle.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Ancilla failed to start")
        .run(|app_ref, app_event| match app_event {
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                let quit_controller = app_ref.state::<Quit>();
                if code.is_some_and(|c| c != 0) {
                    quit_controller.exit_at_once();
                }
                if quit_controller.exits_at_once() {
                    return;
                }
                match quit_controller.phase() {
                    QuitPhase::Stopped => {}
                    QuitPhase::Stopping => api.prevent_exit(),
                    QuitPhase::Idle => match app_ref.get_webview_window("main") {
                        Some(open_window) => {
                            api.prevent_exit();
                            let _ = open_window.close();
                        }
                        None => {
                            if begin_graceful_quit(app_ref) {
                                api.prevent_exit();
                            }
                        }
                    },
                }
            }
            tauri::RunEvent::Exit => {
                let exit_quit_controller = app_ref.state::<Quit>();
                let server_slot = app_ref.state::<ServerChild>().0.clone();
                match exit_quit_controller.at_exit(|| locked(&server_slot).take()) {
                    AtExit::Stop(closing_sidecar) => {
                        let _ = closing_sidecar.stop_gracefully(SIDECAR_STOP_GRACE);
                        exit_quit_controller.finish();
                    }
                    AtExit::Kill(immediate_sidecar) => immediate_sidecar.kill_and_wait(),
                    AtExit::Nothing => {}
                }

                if let Some(mut relaunch_proc) = exit_quit_controller.take_relaunch() {
                    if let Err(relaunch_err) = relaunch_proc.spawn() {
                        eprintln!("Ancilla could not reopen: {relaunch_err}");
                    }
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_node, bundled_node_in, classify_exit, error_page_url, find_resource, fresh_port, owned_page, page_response,
        parse_listening_url, plain_path, read_owner_record, remember_port, rotate_server_log, server_args, splash_page_url,
        stable_port, start_with_retry, AtExit, Began, BootError, OwnerRecord, Quit, QuitPhase, Sidecar, StartFailure, StopOutcome,
        ERROR_PATH, OWNER_FILE, PORT_FILE, READY_LINE_DEADLINE, SIDECAR_STOP_GRACE, SPLASH_PAGE, SPLASH_PATH, STDIN_WATCHDOG_FLAG,
    };
    #[cfg(unix)]
    use super::{latest_nvm_node, prepend_to_path, select_probe_path, well_known_nodes_in};
    use std::ffi::OsString;
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::process::{Command, ExitStatus, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    /// A fresh empty folder for one test, removed when the guard drops.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("ancilla-{name}-{}-{}", std::process::id(), NEXT_DIR.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn exit_status(code: i32) -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code << 8)
    }

    #[cfg(windows)]
    fn exit_status(code: i32) -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(code as u32)
    }

    #[test]
    fn sends_only_outside_links_to_the_browser() {
        let external_check = |link_target: &str| super::is_external_link(&link_target.parse::<tauri::Url>().unwrap());
        assert!(external_check("https://github.com/aleff-ferreira/ancilla/pull/90"));
        assert!(external_check("mailto:hi@example.com"));
        assert!(!external_check("http://127.0.0.1:52314/threads/abc"));
        assert!(!external_check("http://localhost:5173/"));
        assert!(!external_check("http://ipc.localhost/plugin"));
        assert!(!external_check("tauri://localhost/"));
        assert!(!external_check("data:text/html,hi"));
        assert!(!external_check("ancilla://localhost/error"));
        assert!(!external_check("http://ancilla.localhost/error"));
        assert!(!external_check(&error_page_url()));
        assert!(!external_check(&splash_page_url()));
    }

    #[test]
    fn strips_windows_verbatim_prefixes() {
        assert_eq!(plain_path(Path::new(r"\\?\D:\apps\ancilla\server.cjs")), PathBuf::from(r"D:\apps\ancilla\server.cjs"));
        assert_eq!(plain_path(Path::new(r"\\?\UNC\host\share\x")), PathBuf::from(r"\\host\share\x"));
        assert_eq!(plain_path(Path::new("/usr/lib/ancilla")), PathBuf::from("/usr/lib/ancilla"));
    }

    #[test]
    fn parses_only_the_ready_line() {
        assert_eq!(
            parse_listening_url("ancilla-server listening on http://127.0.0.1:52314\n"),
            Some("http://127.0.0.1:52314".to_string())
        );
        assert_eq!(parse_listening_url("ancilla-server: another Ancilla (pid 4, started now, http://127.0.0.1:52314) owns the data folder\n"), None);
        assert_eq!(parse_listening_url("noise http://127.0.0.1:1"), None);
        assert_eq!(parse_listening_url("ancilla-server listening on nowhere"), None);
        assert_eq!(parse_listening_url(""), None);
    }

    #[test]
    fn inline_pages_are_valid_urls() {
        for url in [splash_page_url(), error_page_url()] {
            assert!(url.parse::<tauri::Url>().is_ok(), "{url}");
            assert!(url.parse::<tauri::http::Uri>().is_ok(), "{url}");
            assert!(!url.starts_with("data:"), "{url}");
        }
        assert!(SPLASH_PAGE.starts_with("<!doctype html>"));
        let splash = page_response(SPLASH_PATH, None);
        assert_eq!(splash.status(), 200);
        assert_eq!(splash.body().as_slice(), SPLASH_PAGE.as_bytes());
        let owner = OwnerRecord { host: Some("127.0.0.1".into()), port: Some(52314), platform: Some(super::NODE_PLATFORM.into()), ..OwnerRecord::default() };
        for error in [BootError::NodeMissing, BootError::ServerMissing, BootError::ServerFailed, BootError::DataDirOwned(None), BootError::DataDirOwned(Some(owner))] {
            let page = error.page();
            assert!(page.starts_with("<!doctype html>") && page.contains("<title>Ancilla</title>"), "{page}");
            let response = page_response(ERROR_PATH, Some(page.clone()));
            assert_eq!(response.status(), 200);
            assert_eq!(response.headers().get("content-type").and_then(|value| value.to_str().ok()), Some("text/html; charset=utf-8"));
            assert_eq!(response.body().as_slice(), page.as_bytes());
        }
        for (path, error_page) in [(ERROR_PATH, None), ("/elsewhere", Some(SPLASH_PAGE.to_string())), ("/", None)] {
            let missing = page_response(path, error_page);
            assert_eq!(missing.status(), 404, "{path}");
            assert!(missing.body().is_empty());
        }
        assert!(!owned_page(None).contains("href"));
        let linked = owned_page(Some(&OwnerRecord { host: Some("127.0.0.1".into()), port: Some(52314), ..OwnerRecord::default() }));
        assert!(linked.contains("href=\"http://127.0.0.1:52314/\""), "{linked}");
        assert!(!linked.contains(OWNER_FILE));
        let foreign = owned_page(Some(&OwnerRecord { platform: Some("plan9".into()), ..OwnerRecord::default() }));
        assert!(foreign.contains(OWNER_FILE) && !foreign.contains("href"), "{foreign}");
    }

    #[test]
    fn reads_the_owner_record() {
        let dir = TempDir::new("owner");
        assert!(read_owner_record(dir.path()).is_none());
        std::fs::write(
            dir.path().join(OWNER_FILE),
            "{\"format\":1,\"instanceId\":\"2c0d2a6e-7f6e-4f0c-9d4b-1d1c0b1a2e3f\",\"pid\":12345,\"host\":\"127.0.0.1\",\"port\":3127,\"startedAt\":\"2026-10-14T20:00:00.000Z\",\"closingAt\":null,\"ancillaVersion\":\"0.21.0\",\"platform\":\"win32\"}\n",
        )
        .unwrap();
        let record = read_owner_record(dir.path()).unwrap();
        assert_eq!(record.pid, Some(12345));
        assert_eq!(record.port, Some(3127));
        assert_eq!(record.closing_at, None);
        assert_eq!(record.platform.as_deref(), Some("win32"));
        assert_eq!(record.url().as_deref(), Some("http://127.0.0.1:3127/"));
        std::fs::write(dir.path().join(OWNER_FILE), "{\"format\":1,\"pid\":7,\"port\":null,\"extra\":true}\n").unwrap();
        let partial = read_owner_record(dir.path()).unwrap();
        assert_eq!(partial.pid, Some(7));
        assert_eq!(partial.port, None);
        assert_eq!(partial.url(), None);
        std::fs::write(dir.path().join(OWNER_FILE), "{\"port\":3127,\"host\":\"0.0.0.0\"}").unwrap();
        assert_eq!(read_owner_record(dir.path()).unwrap().url().as_deref(), Some("http://127.0.0.1:3127/"));
        std::fs::write(dir.path().join(OWNER_FILE), "{\"port\":3127,\"host\":\"::1\"}").unwrap();
        assert_eq!(read_owner_record(dir.path()).unwrap().url().as_deref(), Some("http://[::1]:3127/"));
        std::fs::write(dir.path().join(OWNER_FILE), "{\"port\":3127,\"host\":\"a b<\"}").unwrap();
        assert_eq!(read_owner_record(dir.path()).unwrap().url(), None);
        std::fs::write(dir.path().join(OWNER_FILE), "{\"format\":1,\"pid\":").unwrap();
        assert!(read_owner_record(dir.path()).is_none());
    }

    #[test]
    fn maps_only_the_owned_exit_code() {
        assert_eq!(classify_exit(Some(exit_status(75))), StartFailure::Owned);
        assert_eq!(classify_exit(Some(exit_status(1))), StartFailure::Exited);
        assert_eq!(classify_exit(Some(exit_status(0))), StartFailure::Exited);
        assert_eq!(classify_exit(None), StartFailure::Failed);
    }

    #[test]
    fn finds_bundled_resources_under_their_relative_path() {
        let root = TempDir::new("res");
        std::fs::create_dir_all(root.path().join("resources")).unwrap();
        std::fs::write(root.path().join("resources").join("server.cjs"), "").unwrap();
        assert_eq!(find_resource(root.path(), "server.cjs"), Some(root.path().join("resources").join("server.cjs")));
        assert_eq!(find_resource(root.path(), "missing.cjs"), None);
    }

    #[test]
    fn finds_the_bundled_node_beside_the_executable() {
        let dir = TempDir::new("sidecar");
        assert_eq!(bundled_node_in(dir.path()), None);
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        std::fs::write(dir.path().join(name), "").unwrap();
        assert_eq!(bundled_node_in(dir.path()), Some(dir.path().join(name)));
    }

    #[test]
    fn finds_the_private_packaged_runtime_before_any_system_node() {
        let dir = TempDir::new("private-node");
        std::fs::create_dir_all(dir.path().join("resources")).unwrap();
        std::fs::write(dir.path().join("resources/node"), "").unwrap();
        assert_eq!(bundled_node(Some(dir.path())), Some(dir.path().join("resources/node")));
    }

    #[test]
    fn keeps_the_saved_server_port_even_while_it_is_busy() {
        let dir = TempDir::new("port");
        assert_ne!(stable_port(Some(dir.path())), 0);
        assert!(!dir.path().join(PORT_FILE).exists());
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let busy = held.local_addr().unwrap().port();
        std::fs::write(dir.path().join(PORT_FILE), busy.to_string()).unwrap();
        assert_eq!(stable_port(Some(dir.path())), busy, "a busy saved port is passed on: the server waits or exits");
        drop(held);
        assert_eq!(stable_port(Some(dir.path())), busy);
        assert_eq!(std::fs::read_to_string(dir.path().join(PORT_FILE)).unwrap(), busy.to_string());
        std::fs::write(dir.path().join(PORT_FILE), "0").unwrap();
        assert_ne!(stable_port(Some(dir.path())), 0, "a zero is no port");
        assert_ne!(stable_port(None), 0);
        assert_ne!(fresh_port(), 0);
    }

    #[test]
    fn remembers_only_an_announced_port() {
        let dir = TempDir::new("remember");
        remember_port(Some(dir.path()), "http://127.0.0.1:4200");
        assert_eq!(std::fs::read_to_string(dir.path().join(PORT_FILE)).unwrap(), "4200");
        std::fs::write(dir.path().join(PORT_FILE), "4200\n").unwrap();
        remember_port(Some(dir.path()), "http://127.0.0.1:4200");
        assert_eq!(std::fs::read_to_string(dir.path().join(PORT_FILE)).unwrap(), "4200\n");
        remember_port(Some(dir.path()), "not a url");
        assert_eq!(std::fs::read_to_string(dir.path().join(PORT_FILE)).unwrap(), "4200\n");
        remember_port(Some(dir.path()), "http://127.0.0.1:4300");
        assert_eq!(std::fs::read_to_string(dir.path().join(PORT_FILE)).unwrap(), "4300");
        remember_port(Some(&dir.path().join("absent")), "http://127.0.0.1:4300");
        remember_port(None, "http://127.0.0.1:4300");
    }

    #[test]
    fn a_refused_launch_never_retries_or_touches_the_port_file() {
        let dir = TempDir::new("refused");
        std::fs::write(dir.path().join(PORT_FILE), "4100").unwrap();
        let unchanged = || std::fs::read_to_string(dir.path().join(PORT_FILE)).unwrap() == "4100";

        let mut tried = Vec::new();
        let refused = start_with_retry(stable_port(Some(dir.path())), || panic!("a refused launch takes no fresh port"), || false, |port| {
            tried.push(port);
            Err::<u16, _>(StartFailure::Owned)
        });
        assert!(matches!(refused, Err(BootError::DataDirOwned(None))));
        assert_eq!(tried, vec![4100]);
        assert!(unchanged());

        let mut tried = Vec::new();
        let crashed = start_with_retry(stable_port(Some(dir.path())), || 4200, || false, |port| {
            tried.push(port);
            Err::<u16, _>(StartFailure::Exited)
        });
        assert!(matches!(crashed, Err(BootError::ServerFailed)));
        assert_eq!(tried, vec![4100, 4200]);
        assert!(unchanged());

        let mut tried = Vec::new();
        let hung = start_with_retry(stable_port(Some(dir.path())), || 4200, || false, |port| {
            tried.push(port);
            Err::<u16, _>(StartFailure::Failed)
        });
        assert!(matches!(hung, Err(BootError::ServerFailed)));
        assert_eq!(tried, vec![4100]);
        assert!(unchanged());
    }

    #[test]
    fn retries_on_a_fresh_port_only_when_the_server_exits_at_once() {
        let mut tried = Vec::new();
        let started = start_with_retry(4100, || 4200, || false, |port| {
            tried.push(port);
            if port == 4100 {
                Err(StartFailure::Exited)
            } else {
                Ok(port)
            }
        });
        assert_eq!(started.ok(), Some(4200));
        assert_eq!(tried, vec![4100, 4200]);

        let mut tried = Vec::new();
        let quitting = start_with_retry(4100, || panic!("no fresh port once a quit has begun"), || true, |port| {
            tried.push(port);
            Err::<u16, _>(StartFailure::Exited)
        });
        assert!(matches!(quitting, Err(BootError::ServerFailed)));
        assert_eq!(tried, vec![4100]);
    }

    #[test]
    fn server_arguments_carry_the_watchdog_flag_last() {
        let args = server_args(Path::new("/app/server.cjs"), 4100, Some(Path::new("/app/frontend")), Some(Path::new("/data")));
        let expected: Vec<OsString> = ["/app/server.cjs", "--port", "4100", "--static", "/app/frontend", "--data-dir", "/data", STDIN_WATCHDOG_FLAG]
            .into_iter()
            .map(OsString::from)
            .collect();
        assert_eq!(args, expected);
        let bare = server_args(Path::new("server.cjs"), 1, None, None);
        assert_eq!(bare.last().map(|arg| arg.as_os_str()), Some(std::ffi::OsStr::new("--close-on-stdin-eof")));
        assert_eq!(bare.len(), 4);
    }

    #[test]
    fn rotates_a_large_server_log_and_keeps_one() {
        let dir = TempDir::new("log");
        let big = vec![b'x'; 2048];
        std::fs::write(dir.path().join("server.log"), &big).unwrap();
        std::fs::write(dir.path().join("server.log.1"), "older").unwrap();
        assert_eq!(rotate_server_log(dir.path(), 1024), dir.path().join("server.log"));
        assert_eq!(std::fs::read(dir.path().join("server.log.1")).unwrap(), big, "the big file moved aside, over the older one");
        assert!(!dir.path().join("server.log").exists());
        std::fs::write(dir.path().join("server.log"), "small").unwrap();
        assert_eq!(rotate_server_log(dir.path(), 1024), dir.path().join("server.log"));
        assert_eq!(std::fs::read_to_string(dir.path().join("server.log")).unwrap(), "small");
        assert_eq!(std::fs::read(dir.path().join("server.log.1")).unwrap(), big);
        let empty = TempDir::new("nolog");
        assert_eq!(rotate_server_log(empty.path(), 1024), empty.path().join("server.log"));
    }

    #[test]
    fn the_stop_grace_outlasts_the_server_deadline() {
        assert!(SIDECAR_STOP_GRACE >= Duration::from_millis(20_000 + 1_000));
        assert!(READY_LINE_DEADLINE >= Duration::from_secs(30));
        assert!(READY_LINE_DEADLINE > SIDECAR_STOP_GRACE);
    }

    #[test]
    fn quit_state_begins_once_and_remembers_a_relaunch() {
        let quit = Quit::default();
        assert_eq!(quit.phase(), QuitPhase::Idle);
        assert!(!quit.exits_at_once());
        assert!(matches!(quit.begin(|| Some(7u8)), Began::Stop(7)));
        assert_eq!(quit.phase(), QuitPhase::Stopping);
        assert!(matches!(quit.begin(|| Some(8u8)), Began::Already));
        assert_eq!(quit.phase(), QuitPhase::Stopping);
        assert!(quit.take_relaunch().is_none());
        quit.remember_relaunch(Command::new("ancilla"));
        quit.finish();
        assert_eq!(quit.phase(), QuitPhase::Stopped);
        assert!(matches!(quit.begin(|| Some(9u8)), Began::Already));
        assert_eq!(quit.phase(), QuitPhase::Stopped);
        assert!(quit.take_relaunch().is_some());
        assert!(quit.take_relaunch().is_none());
        quit.exit_at_once();
        assert!(quit.exits_at_once());

        let empty = Quit::default();
        assert!(matches!(empty.begin(|| None::<u8>), Began::Nothing));
        assert_eq!(empty.phase(), QuitPhase::Stopped);

        let quit = Quit::default();
        let mut slot = None;
        assert_eq!(quit.admit(1u8, |value| slot = Some(value)), None);
        assert_eq!(slot, Some(1));
        assert!(matches!(quit.begin(|| slot.take()), Began::Stop(1)));
        assert_eq!(quit.admit(2u8, |value| slot = Some(value)), Some(2));
        assert_eq!(slot, None);
    }

    #[test]
    fn the_exit_event_stops_what_no_quit_stopped_and_kills_for_an_immediate_exit() {
        let quit = Quit::default();
        assert!(matches!(quit.at_exit(|| Some(1u8)), AtExit::Stop(1)));
        assert_eq!(quit.phase(), QuitPhase::Stopping);
        assert!(matches!(quit.at_exit(|| Some(2u8)), AtExit::Nothing));
        let empty = Quit::default();
        assert!(matches!(empty.at_exit(|| None::<u8>), AtExit::Nothing));
        assert_eq!(empty.phase(), QuitPhase::Stopped);
        let stopped = Quit::default();
        assert!(matches!(stopped.begin(|| Some(3u8)), Began::Stop(3)));
        stopped.finish();
        assert!(matches!(stopped.at_exit(|| None::<u8>), AtExit::Nothing));
        let immediate = Quit::default();
        immediate.exit_at_once();
        assert!(matches!(immediate.at_exit(|| Some(4u8)), AtExit::Kill(4)));
        assert_eq!(immediate.phase(), QuitPhase::Idle);
        assert!(matches!(immediate.at_exit(|| None::<u8>), AtExit::Nothing));
    }

    #[test]
    fn stdin_eof_ends_a_listening_child_and_a_deaf_one_is_killed() {
        assert!(super::node_runs(Path::new("node")), "node is not on the PATH: this test needs it to run a child");
        let mut listening = super::command("node");
        listening
            .arg("-e")
            .arg("process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); setTimeout(() => process.exit(3), 10000);")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let sidecar = Sidecar::spawn(&mut listening).unwrap();
        assert!(matches!(sidecar.stop_gracefully(Duration::from_secs(8)), StopOutcome::Exited(Some(0))));
        let mut deaf = super::command("node");
        deaf.arg("-e").arg("setInterval(() => {}, 1000);").stdout(Stdio::null()).stderr(Stdio::null());
        let sidecar = Sidecar::spawn(&mut deaf).unwrap();
        assert!(matches!(sidecar.stop_gracefully(Duration::from_millis(300)), StopOutcome::Killed));
    }

    #[cfg(unix)]
    #[test]
    fn shell_probe_answers_come_from_the_last_path_line() {
        let root = TempDir::new("probe");
        let node = root.path().join("node");
        std::fs::write(&node, "").unwrap();
        let output = format!("Welcome back\n{}\n", node.display());
        assert_eq!(select_probe_path(&output), Some(node.clone()));
        assert_eq!(select_probe_path("Welcome back\n"), None);
        assert_eq!(select_probe_path("/no/such/node-here\n"), None);
    }

    #[cfg(unix)]
    #[test]
    fn well_known_homes_only_list_installs_that_exist() {
        let home = TempDir::new("home");
        std::fs::create_dir_all(home.path().join(".volta/bin")).unwrap();
        std::fs::write(home.path().join(".volta/bin/node"), "").unwrap();
        let nodes = well_known_nodes_in(home.path());
        assert!(nodes.contains(&home.path().join(".volta/bin/node")));
        assert!(!nodes.contains(&home.path().join(".asdf/shims/node")));
    }

    #[cfg(unix)]
    #[test]
    fn nvm_resolves_to_the_newest_installed_version() {
        let home = TempDir::new("nvm");
        for version in ["v18.20.4", "v20.11.0", "v20.9.0"] {
            let dir = home.path().join(".nvm/versions/node").join(version).join("bin");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("node"), "").unwrap();
        }
        std::fs::create_dir_all(home.path().join(".nvm/versions/node/junk")).unwrap();
        let node = latest_nvm_node(home.path()).unwrap();
        assert!(node.ends_with(".nvm/versions/node/v20.11.0/bin/node"), "got {node:?}");
    }

    #[cfg(unix)]
    #[test]
    fn path_augmentation_prepends_without_duplicating() {
        let prepend = [PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
        assert_eq!(
            prepend_to_path(&prepend, Some(OsString::from("/usr/bin:/bin"))),
            OsString::from("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        );
        assert_eq!(
            prepend_to_path(&prepend, Some(OsString::from("/usr/local/bin:/usr/bin"))),
            OsString::from("/opt/homebrew/bin:/usr/local/bin:/usr/bin")
        );
        assert_eq!(prepend_to_path(&prepend, None), OsString::from("/opt/homebrew/bin:/usr/local/bin"));
    }
}
