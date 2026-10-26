// GUI subsystem in every build: a debug build would otherwise open a stray console window.
// Nothing is lost, the server's output goes to server.log.
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

#[derive(Default)]
struct Quit {
    phase: Mutex<QuitPhase>,
    /// Set by the Linux reopen before `app.exit`: that exit is not a user quit and gets no graceful stop.
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

    /// Only the Linux reopen asks for an exit without a graceful stop.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    fn exit_at_once(&self) {
        self.immediate.store(true, Ordering::SeqCst);
    }

    fn exits_at_once(&self) -> bool {
        self.immediate.load(Ordering::SeqCst)
    }
}

/// Begins the graceful stop once, on its own thread; the window is already gone when this runs. Later calls do
/// nothing: the stop thread ends the app itself when the server has closed or the grace has passed.
fn begin_graceful_quit(app: &tauri::AppHandle) {
    let quit = app.state::<Quit>();
    let slot = app.state::<ServerChild>().0.clone();
    let sidecar = match quit.begin(|| locked(&slot).take()) {
        Began::Stop(sidecar) => sidecar,
        Began::Nothing | Began::Already => return,
    };
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = sidecar.stop_gracefully(SIDECAR_STOP_GRACE);
        handle.state::<Quit>().finish();
        handle.exit(0);
    });
}

/// This executable with the arguments it was started with: what a second launch that arrived mid-quit asked for.
/// Under an AppImage the image itself is run, not the binary mounted from it, which goes away with this process.
fn relaunch_command(app: &tauri::AppHandle) -> Option<Command> {
    let env = app.env();
    let binary = tauri::process::current_binary(&env).ok()?;
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

/// Windows gets Ancilla's own title bar, drawn by the UI; macOS keeps the native traffic
/// lights overlaid on the UI, so the sidebar runs the full height of the window; other
/// platforms keep the native frame.
const CUSTOM_FRAME: bool = cfg!(windows);

/// Tells the UI, before it loads, to draw the window controls and drag regions.
const FRAME_SCRIPT: &str = "window.__ANCILLA_FRAME__ = 'custom';";

/// Tells the UI, before it loads, that the macOS traffic lights float over the sidebar.
#[cfg(target_os = "macos")]
const OVERLAY_SCRIPT: &str = "window.__ANCILLA_TITLEBAR__ = 'overlay';";

/// Where the server's port is remembered between launches, inside the app's data folder.
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
const SPLASH_PAGE: &str = "data:text/html,<!doctype html><meta charset=utf-8><title>Ancilla</title><style>html{color-scheme:light dark;background:Canvas;color:GrayText;font:13px system-ui,sans-serif}body{margin:0;height:100vh;display:grid;place-items:center}</style><body>Starting Ancilla</body>";

const MISSING_NODE_PAGE: &str = "data:text/html,<!doctype html><meta charset=utf-8><title>Ancilla</title><style>html{color-scheme:light dark;background:Canvas;color:CanvasText;font:14px/1.5 system-ui,sans-serif}body{margin:0;height:100vh;display:grid;place-items:center}main{max-width:420px;padding:24px}p{color:GrayText}</style><main><h1 style=font-size:20px>Ancilla needs Node.js</h1><p>Ancilla could not start its local server because its bundled Node.js is missing and Node.js 22 or newer was not found on this computer. Reinstall Ancilla, or install Node.js 22 or newer, then open Ancilla again.</p></main>";

const MISSING_SERVER_PAGE: &str = "data:text/html,<!doctype html><meta charset=utf-8><title>Ancilla</title><style>html{color-scheme:light dark;background:Canvas;color:CanvasText;font:14px/1.5 system-ui,sans-serif}body{margin:0;height:100vh;display:grid;place-items:center}main{max-width:420px;padding:24px}p{color:GrayText}</style><main><h1 style=font-size:20px>Ancilla is missing files</h1><p>The bundled Ancilla server was not found next to the app. Reinstall Ancilla to restore it.</p></main>";

const SERVER_FAILED_PAGE: &str = "data:text/html,<!doctype html><meta charset=utf-8><title>Ancilla</title><style>html{color-scheme:light dark;background:Canvas;color:CanvasText;font:14px/1.5 system-ui,sans-serif}body{margin:0;height:100vh;display:grid;place-items:center}main{max-width:420px;padding:24px}p{color:GrayText}</style><main><h1 style=font-size:20px>Ancilla could not start</h1><p>Its local server did not come up. The server log in the Ancilla app log folder has the details. Close Ancilla and open it again to retry.</p></main>";

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
    format!("data:text/html,<!doctype html><meta charset=utf-8><title>Ancilla</title><style>{PAGE_STYLE}</style><main><h1 style=font-size:20px>Ancilla is already open</h1><p>Another copy of Ancilla is using your data folder: a window on another desktop, a copy that is still closing, or an ancilla-server started by hand. Close it, then open Ancilla again.</p>{open}{elsewhere}</main>")
}

enum BootError {
    NodeMissing,
    ServerMissing,
    ServerFailed,
    /// The server exited with EXIT_DATA_DIR_OWNED; the record is what the data folder held afterwards.
    DataDirOwned(Option<OwnerRecord>),
}

impl BootError {
    fn page(&self) -> String {
        match self {
            BootError::NodeMissing => MISSING_NODE_PAGE.to_string(),
            BootError::ServerMissing => MISSING_SERVER_PAGE.to_string(),
            BootError::ServerFailed => SERVER_FAILED_PAGE.to_string(),
            BootError::DataDirOwned(owner) => owned_page(owner.as_ref()),
        }
    }
}

/// Why one server start produced no URL. A server that exits at once may have lost its port to another
/// process between the check and its own bind; one that never answers or never spawned would not be
/// helped by another port; one refused by the data folder's owner must not be started anywhere else.
#[derive(Debug, PartialEq, Eq)]
enum StartFailure {
    Exited,
    Failed,
    Owned,
}

/// The exit code decides: only EXIT_DATA_DIR_OWNED means the folder is owned; any other exit, a signal death
/// included, is an exit; no exit within the wait is a server that is stuck.
fn classify_exit(status: Option<ExitStatus>) -> StartFailure {
    match status {
        Some(status) if status.code() == Some(EXIT_DATA_DIR_OWNED) => StartFailure::Owned,
        Some(_) => StartFailure::Exited,
        None => StartFailure::Failed,
    }
}

/// Tauri hands out `\\?\` verbatim paths on Windows; Node cannot load a main module from one.
fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// Bundled resources keep their relative path (`resources/server.cjs`); older layouts put them at the root.
fn find_resource(resource_dir: &Path, name: &str) -> Option<PathBuf> {
    [resource_dir.join("resources").join(name), resource_dir.join(name)]
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(|found| plain_path(&found))
}

/// The port the last launch remembered, if any.
fn saved_port(data_dir: Option<&Path>) -> Option<u16> {
    data_dir
        .and_then(|dir| std::fs::read_to_string(dir.join(PORT_FILE)).ok())
        .and_then(|text| text.trim().parse::<u16>().ok())
        .filter(|port| *port != 0)
}

/// The port to start the server on: the saved one whenever there is one, busy or not. The window's origin
/// includes the port and the UI keeps its settings in that origin's storage, so a new port would forget them,
/// automatic updates switched off included. A saved port that is busy is usually the previous copy still closing:
/// the server waits for it and binds the same port. When something else holds it the server exits at once and
/// `start_with_retry` tries a fresh port. Nothing is written here; only an announced port is remembered.
fn stable_port(data_dir: Option<&Path>) -> u16 {
    saved_port(data_dir).unwrap_or_else(fresh_port)
}

/// A port nothing is using right now. Returns 0, any free port, only when none can be found.
fn fresh_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .unwrap_or(0)
}

/// Remembers the port the server announced, and only that: a refused, crashed or stuck start leaves the file as it
/// was, so the next launch keeps the same origin. A file that already says so is left untouched.
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

/// Starts the server on `port`, and once more on a fresh port if it exits at once, unless a quit has begun in the
/// meantime (`quitting`) or the data folder is owned: that server is refused everywhere, so no port would help.
fn start_with_retry<T>(
    port: u16,
    fresh: impl FnOnce() -> u16,
    quitting: impl Fn() -> bool,
    mut spawn: impl FnMut(u16) -> Result<T, StartFailure>,
) -> Result<T, BootError> {
    match spawn(port) {
        Ok(started) => Ok(started),
        Err(StartFailure::Owned) => Err(BootError::DataDirOwned(None)),
        Err(StartFailure::Exited) if quitting() => Err(BootError::ServerFailed),
        Err(StartFailure::Exited) => spawn(fresh()).map_err(|_| BootError::ServerFailed),
        Err(StartFailure::Failed) => Err(BootError::ServerFailed),
    }
}

/// A child process that never flashes a console window on Windows.
fn command<S: AsRef<OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn node_runs(program: &Path) -> bool {
    command(program)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// The Node.js runtime that ships next to the app executable as a Tauri sidecar, when this build has one.
fn bundled_node(resource_dir: Option<&Path>) -> Option<PathBuf> {
    // Debian/RPM own only Ancilla's private runtime, never the system's /usr/bin/node.
    if let Some(node) = resource_dir.and_then(|dir| find_resource(dir, "node")).filter(|path| path.is_file()) {
        return Some(node);
    }
    let exe = std::env::current_exe().ok()?;
    bundled_node_in(exe.parent()?)
}

fn bundled_node_in(dir: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    Some(dir.join(name)).filter(|path| path.is_file()).map(|path| plain_path(&path))
}

/// The bundled Node.js first, so users need nothing installed. Without it (a source build, or a damaged
/// install), Node.js the way a terminal sees it. GUI apps on macOS start with a minimal PATH that misses
/// Homebrew, ~/.local/bin and everything a version manager adds through the shell's rc files, so
/// plain `node` fails for most users when Ancilla is opened from the Finder rather than a terminal.
fn find_node(resource_dir: &Path) -> Option<PathBuf> {
    if let Some(bundled) = bundled_node(Some(resource_dir)).filter(|node| node_runs(node)) {
        return Some(bundled);
    }
    let mut candidates = vec![PathBuf::from("node")];
    #[cfg(unix)]
    {
        if let Some(found) = shell_probe("/bin/sh", &["-lc", "command -v node"]) {
            candidates.push(found);
        }
        if let Ok(shell) = std::env::var("SHELL") {
            if shell != "/bin/sh" {
                // Login plus interactive, so .zshrc-style rc files run and managers like fnm, nvm,
                // volta and mise put their node on PATH.
                let probe = if shell.ends_with("csh") {
                    "which node"
                } else {
                    "command -v node"
                };
                if let Some(found) = shell_probe(&shell, &["-li", "-c", probe]) {
                    candidates.push(found);
                }
            }
        }
        candidates.extend(well_known_nodes());
    }
    candidates.into_iter().find(|candidate| node_runs(candidate))
}

/// Runs one shell probe with a timeout: rc files can hang, and boot must not hang with them.
#[cfg(unix)]
fn shell_probe(shell: &str, args: &[&str]) -> Option<PathBuf> {
    let shell = shell.to_string();
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let output = command(&shell).args(&args).output().ok();
        let _ = tx.send(output);
    });
    let output = rx.recv_timeout(Duration::from_secs(10)).ok()??;
    if !output.status.success() {
        return None;
    }
    // The probe runs after the rc files, so its answer is the last path-like line; anything the
    // rc files printed above it is ignored.
    select_probe_path(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(unix)]
fn select_probe_path(output: &str) -> Option<PathBuf> {
    output
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_absolute() && path.is_file())
}

/// Node binaries in their usual homes, for when the shells above do not know them.
#[cfg(unix)]
fn well_known_nodes() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    well_known_nodes_in(&home)
}

#[cfg(unix)]
fn well_known_nodes_in(home: &Path) -> Vec<PathBuf> {
    let mut nodes = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/opt/local/bin/node"),
        home.join(".local/bin/node"),
        home.join(".volta/bin/node"),
        home.join(".asdf/shims/node"),
        home.join(".local/share/mise/shims/node"),
        home.join(".fnm/aliases/default/bin/node"),
    ];
    if let Some(nvm) = latest_nvm_node(home) {
        nodes.push(nvm);
    }
    nodes.into_iter().filter(|node| node.is_file()).collect()
}

/// The newest node nvm has installed, by version number.
#[cfg(unix)]
fn latest_nvm_node(home: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(home.join(".nvm/versions/node")).ok()?;
    let mut versions: Vec<(Vec<u64>, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(number) = name.strip_prefix('v') else {
            continue;
        };
        let parts: Option<Vec<u64>> = number.split('.').map(|part| part.parse::<u64>().ok()).collect();
        let node = entry.path().join("bin/node");
        if let (Some(parts), true) = (parts, node.is_file()) {
            versions.push((parts, node));
        }
    }
    versions.sort_by(|a, b| a.0.cmp(&b.0));
    versions.pop().map(|(_, node)| node)
}

/// A PATH for the server that sees what a terminal sees: the node that was found, plus the user
/// bin folders, in front of whatever the app inherited. The server's own probes (`muse`, skills)
/// and the user's `!` commands all run under it.
#[cfg(unix)]
fn augmented_path(node: &Path, resource_dir: Option<&Path>) -> Option<OsString> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut prepend: Vec<PathBuf> = Vec::new();
    // The bundled node sits beside the app executable; putting that folder first would shadow the
    // user's own node for their `!` commands.
    if node.is_absolute() && bundled_node(resource_dir).as_deref() != Some(node) {
        if let Some(dir) = node.parent() {
            prepend.push(dir.to_path_buf());
        }
    }
    let mut folders = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/local/bin"),
    ];
    if let Some(home) = &home {
        folders.extend([home.join(".local/bin"), home.join(".volta/bin"), home.join(".asdf/shims")]);
    }
    prepend.extend(folders.into_iter().filter(|dir| dir.is_dir()));
    if prepend.is_empty() {
        return None;
    }
    Some(prepend_to_path(&prepend, std::env::var_os("PATH")))
}

#[cfg(unix)]
fn prepend_to_path(prepend: &[PathBuf], current: Option<OsString>) -> OsString {
    let mut parts: Vec<OsString> = prepend.iter().map(|dir| dir.as_os_str().to_os_string()).collect();
    let already: Vec<PathBuf> = current
        .as_ref()
        .map(|path| std::env::split_paths(path).collect())
        .unwrap_or_default();
    parts.retain(|dir| !already.iter().any(|have| have.as_os_str() == dir));
    if let Some(current) = current {
        if !current.is_empty() {
            parts.push(current);
        }
    }
    let mut joined = OsString::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            joined.push(":");
        }
        joined.push(part);
    }
    joined
}

fn wait_for_url(child: &mut Child) -> Option<String> {
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        if reader.read_line(&mut line).is_ok() {
            let _ = tx.send(line);
        }
    });
    let line = rx.recv_timeout(READY_LINE_DEADLINE).ok()?;
    parse_listening_url(&line)
}

/// Only the server's ready line, which is the one line it ever writes to stdout; anything else is not an address.
fn parse_listening_url(line: &str) -> Option<String> {
    let rest = line.strip_prefix("ancilla-server listening on ")?.trim();
    rest.starts_with("http://").then(|| rest.to_string())
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

/// One attempt to run the bundled server on `port`, returning it with the URL it announced.
fn spawn_server(
    app: &tauri::AppHandle,
    node: &Path,
    server: &Path,
    frontend: Option<&Path>,
    data: Option<&Path>,
    port: u16,
) -> Result<(Sidecar, String), StartFailure> {
    let mut cmd = command(node);
    #[cfg(unix)]
    if let Some(path) = augmented_path(node, app.path().resource_dir().ok().as_deref()) {
        cmd.env("PATH", path);
    }
    cmd.args(server_args(server, port, frontend, data));
    let log = app
        .path()
        .app_log_dir()
        .ok()
        .map(|dir| plain_path(&dir))
        .and_then(|dir| std::fs::create_dir_all(&dir).ok().map(|_| rotate_server_log(&dir, SERVER_LOG_CAP)))
        .and_then(|path| OpenOptions::new().create(true).append(true).open(path).ok());
    cmd.stdout(Stdio::piped())
        .stderr(log.map(Stdio::from).unwrap_or_else(Stdio::null));
    let mut sidecar = Sidecar::spawn(&mut cmd).map_err(|_| StartFailure::Failed)?;
    if let Some(url) = wait_for_url(&mut sidecar.child) {
        return Ok((sidecar, url));
    }
    // Its output can end a moment before the exit is reported, so give the exit up to a second to show.
    let mut status = None;
    for _ in 0..20 {
        if let Ok(Some(exited)) = sidecar.child.try_wait() {
            status = Some(exited);
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let failure = classify_exit(status);
    sidecar.kill_and_wait();
    Err(failure)
}

fn boot_server(app: &tauri::AppHandle) -> Result<String, BootError> {
    let resource_dir = app.path().resource_dir().map_err(|_| BootError::ServerMissing)?;
    let node = find_node(&resource_dir).ok_or(BootError::NodeMissing)?;
    let server = find_resource(&resource_dir, "server.cjs").ok_or(BootError::ServerMissing)?;
    let frontend = find_resource(&resource_dir, "frontend");
    // Projects, pins and thread titles persist per user, next to the app's other data.
    let data = app
        .path()
        .app_data_dir()
        .ok()
        .filter(|dir| std::fs::create_dir_all(dir).is_ok())
        .map(|dir| plain_path(&dir));
    let quit = app.state::<Quit>();
    let (sidecar, url) = start_with_retry(
        stable_port(data.as_deref()),
        fresh_port,
        || quit.phase() != QuitPhase::Idle,
        |port| spawn_server(app, &node, &server, frontend.as_deref(), data.as_deref(), port),
    )
    .map_err(|error| match error {
        BootError::DataDirOwned(_) => BootError::DataDirOwned(data.as_deref().and_then(read_owner_record)),
        other => other,
    })?;
    remember_port(data.as_deref(), &url);
    let state = app.state::<ServerChild>();
    if let Some(sidecar) = quit.admit(sidecar, |sidecar| *locked(&state.0) = Some(sidecar)) {
        // The window went while the server was starting: there is nothing to show it to, and nothing to retry.
        sidecar.kill_and_wait();
        return Err(BootError::ServerFailed);
    }
    app.resources_table().add(ServerGuard(state.0.clone()));
    Ok(url)
}

/// WKWebView swallows Cmd+/− for its own page zoom before JS sees them. A native View menu
/// takes those keys and emits `ancilla://zoom` so the UI can step Ancilla's zoom instead.
#[cfg(target_os = "macos")]
fn install_zoom_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let zoom_in = MenuItemBuilder::with_id("zoom-in", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("zoom-out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("zoom-reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    // Quit closes the window rather than exiting: the window's Destroyed handler is the one place a quit
    // begins, so Cmd+Q and the close button stop the server the same way.
    let quit = MenuItemBuilder::with_id("quit", "Quit Ancilla")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Ancilla")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .separator()
        .close_window()
        .build()?;
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit)
        .item(&view)
        .item(&window)
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let step = match event.id().0.as_str() {
            "zoom-in" => "in",
            "zoom-out" => "out",
            "zoom-reset" => "reset",
            "quit" => {
                match app.get_webview_window("main") {
                    Some(window) => {
                        let _ = window.close();
                    }
                    None => app.exit(0),
                }
                return;
            }
            _ => return,
        };
        let _ = app.emit("ancilla://zoom", step);
    });
    Ok(())
}

/// Web and mail links that belong in the user's browser or mail app. Ancilla's own local server, the inline
/// splash and error pages, and Tauri's internal schemes stay in the window.
fn is_external_link(url: &Url) -> bool {
    match url.scheme() {
        "mailto" => true,
        "http" | "https" => !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]" | "ipc.localhost" | "tauri.localhost")),
        _ => false,
    }
}

fn main() {
    // The single-instance plugin goes first, as its documentation asks, so a second launch is forwarded before
    // anything else of this copy starts. On Linux it needs the session bus; without one it is left out and the
    // server's own data folder lock is what keeps two copies apart.
    let builder = tauri::Builder::default();
    #[cfg(not(target_os = "linux"))]
    let builder = builder.plugin(single_instance_plugin());
    #[cfg(target_os = "linux")]
    let builder = if linux_desktop::session_bus_likely() {
        builder.plugin(single_instance_plugin())
    } else {
        builder
    };
    // System packages are updated by the distribution's installer. The AppImage updater may
    // replace only an AppImage, and is unavailable altogether in Debian/RPM installations.
    #[cfg(target_os = "linux")]
    let builder = if linux_desktop::installation_kind() == "appimage" {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    #[cfg(not(target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(target_os = "linux")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        linux_desktop::linux_installation_status,
        linux_desktop::install_linux_launcher,
        linux_desktop::relaunch_installed_linux,
    ]);
    builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ServerChild(Arc::new(Mutex::new(None))))
        .manage(Quit::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            install_zoom_menu(app)?;
            // Open the window at once on a splash page; the server can take a few seconds to probe WSL.
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(SPLASH_PAGE.parse()?))
                .title("Ancilla")
                .inner_size(1280.0, 820.0)
                .min_inner_size(880.0, 560.0)
                // Native file-drop consumes HTML5 DnD (sidebar reorder, composer attach) on Windows.
                .disable_drag_drop_handler()
                // A link meant for the browser (`target="_blank"`, or one that would navigate the app away)
                // opens in the user's default browser instead of doing nothing or replacing Ancilla.
                .on_new_window(|url, _features| {
                    if is_external_link(&url) {
                        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_navigation(|url| {
                    if is_external_link(url) {
                        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                        return false;
                    }
                    true
                });
            if CUSTOM_FRAME {
                builder = builder.decorations(false).initialization_script(FRAME_SCRIPT);
            }
            #[cfg(target_os = "linux")]
            {
                builder = builder.initialization_script(format!(
                    "window.__ANCILLA_LINUX_INSTALL__ = '{}';",
                    linux_desktop::installation_kind()
                ));
            }
            // The traffic lights float over the sidebar's top-left corner; the UI leaves room
            // for them and marks its headers as drag regions, like T3 Code.
            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(20.0, 20.0))
                    .initialization_script(OVERLAY_SCRIPT);
            }
            let window = builder.build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let target = match boot_server(&handle) {
                    Ok(url) => url,
                    Err(error) => {
                        // Error pages draw no window controls, so they get the native frame back.
                        if CUSTOM_FRAME {
                            let _ = window.set_decorations(true);
                        }
                        error.page()
                    }
                };
                if let Ok(url) = target.parse::<Url>() {
                    let _ = window.navigate(url);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    begin_graceful_quit(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Ancilla failed to start")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                let quit = app.state::<Quit>();
                // A code other than 0 is the updater's or a restart's exit, not the user's; so is the Linux reopen.
                if quit.exits_at_once() || code.is_some_and(|code| code != 0) {
                    return;
                }
                match quit.phase() {
                    // Tauri's cleanup drops ServerGuard, which finds nothing left to kill after a graceful stop.
                    QuitPhase::Stopped => {}
                    // The stop thread exits the app when the server has closed.
                    QuitPhase::Stopping => api.prevent_exit(),
                    QuitPhase::Idle => {
                        api.prevent_exit();
                        match app.get_webview_window("main") {
                            // A quit from outside the window (the Dock's Quit): the window goes first, like a
                            // close, and its Destroyed handler begins the stop.
                            Some(window) => {
                                let _ = window.close();
                            }
                            None => begin_graceful_quit(app),
                        }
                    }
                }
            }
            tauri::RunEvent::Exit => {
                // Resources are cleared (the sidecar is dead) and the plugins have had their Exit (the single-instance
                // plugin has released its name): only now may another copy start.
                if let Some(mut command) = app.state::<Quit>().take_relaunch() {
                    if let Err(error) = command.spawn() {
                        eprintln!("Ancilla could not reopen: {error}");
                    }
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_node, bundled_node_in, classify_exit, find_resource, fresh_port, owned_page, parse_listening_url, plain_path,
        read_owner_record, remember_port, rotate_server_log, server_args, stable_port, start_with_retry, Began, BootError,
        OwnerRecord, Quit, QuitPhase, Sidecar, StartFailure, StopOutcome, OWNER_FILE, PORT_FILE, READY_LINE_DEADLINE,
        SIDECAR_STOP_GRACE, SPLASH_PAGE, STDIN_WATCHDOG_FLAG,
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
        let external = |u: &str| super::is_external_link(&u.parse::<tauri::Url>().unwrap());
        assert!(external("https://github.com/aleff-ferreira/ancilla/pull/90"));
        assert!(external("mailto:hi@example.com"));
        assert!(!external("http://127.0.0.1:52314/threads/abc"));
        assert!(!external("http://localhost:5173/"));
        assert!(!external("http://ipc.localhost/plugin"));
        assert!(!external("tauri://localhost/"));
        assert!(!external("data:text/html,hi"));
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
        // A refusal names the owner's address, on stderr; were it ever read here it is still not a ready line.
        assert_eq!(parse_listening_url("ancilla-server: another Ancilla (pid 4, started now, http://127.0.0.1:52314) owns the data folder\n"), None);
        assert_eq!(parse_listening_url("noise http://127.0.0.1:1"), None);
        assert_eq!(parse_listening_url("ancilla-server listening on nowhere"), None);
        assert_eq!(parse_listening_url(""), None);
    }

    #[test]
    fn inline_pages_are_valid_urls() {
        assert!(SPLASH_PAGE.parse::<tauri::Url>().is_ok());
        let owner = OwnerRecord { host: Some("127.0.0.1".into()), port: Some(52314), platform: Some(super::NODE_PLATFORM.into()), ..OwnerRecord::default() };
        for error in [BootError::NodeMissing, BootError::ServerMissing, BootError::ServerFailed, BootError::DataDirOwned(None), BootError::DataDirOwned(Some(owner))] {
            assert!(error.page().parse::<tauri::Url>().is_ok());
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
        // Between the claim and the bind the port is null; a record from an older or newer build may lack fields.
        std::fs::write(dir.path().join(OWNER_FILE), "{\"format\":1,\"pid\":7,\"port\":null,\"extra\":true}\n").unwrap();
        let partial = read_owner_record(dir.path()).unwrap();
        assert_eq!(partial.pid, Some(7));
        assert_eq!(partial.port, None);
        assert_eq!(partial.url(), None);
        std::fs::write(dir.path().join(OWNER_FILE), "{\"port\":3127,\"host\":\"0.0.0.0\"}").unwrap();
        assert_eq!(read_owner_record(dir.path()).unwrap().url().as_deref(), Some("http://127.0.0.1:3127/"));
        std::fs::write(dir.path().join(OWNER_FILE), "{\"port\":3127,\"host\":\"::1\"}").unwrap();
        assert_eq!(read_owner_record(dir.path()).unwrap().url().as_deref(), Some("http://[::1]:3127/"));
        // A host that cannot go into a link gives no link rather than a broken page.
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
        // No file: a free port, and still no file; only an announced port is ever written.
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
        // A file that already says so is not rewritten: the newline survives.
        std::fs::write(dir.path().join(PORT_FILE), "4200\n").unwrap();
        remember_port(Some(dir.path()), "http://127.0.0.1:4200");
        assert_eq!(std::fs::read_to_string(dir.path().join(PORT_FILE)).unwrap(), "4200\n");
        remember_port(Some(dir.path()), "not a url");
        assert_eq!(std::fs::read_to_string(dir.path().join(PORT_FILE)).unwrap(), "4200\n");
        remember_port(Some(dir.path()), "http://127.0.0.1:4300");
        assert_eq!(std::fs::read_to_string(dir.path().join(PORT_FILE)).unwrap(), "4300");
        // The data folder can be missing or read-only: the launch goes on without a remembered port.
        remember_port(Some(&dir.path().join("absent")), "http://127.0.0.1:4300");
        remember_port(None, "http://127.0.0.1:4300");
    }

    #[test]
    fn a_refused_launch_never_retries_or_touches_the_port_file() {
        let dir = TempDir::new("refused");
        std::fs::write(dir.path().join(PORT_FILE), "4100").unwrap();
        let unchanged = || std::fs::read_to_string(dir.path().join(PORT_FILE)).unwrap() == "4100";

        // Refused: the folder is owned, so no port would help and the owner's origin must stay the next launch's.
        let mut tried = Vec::new();
        let refused = start_with_retry(stable_port(Some(dir.path())), || panic!("a refused launch takes no fresh port"), || false, |port| {
            tried.push(port);
            Err::<u16, _>(StartFailure::Owned)
        });
        assert!(matches!(refused, Err(BootError::DataDirOwned(None))));
        assert_eq!(tried, vec![4100]);
        assert!(unchanged());

        // Crashed twice: the retry on a fresh port happens, nothing is written for it.
        let mut tried = Vec::new();
        let crashed = start_with_retry(stable_port(Some(dir.path())), || 4200, || false, |port| {
            tried.push(port);
            Err::<u16, _>(StartFailure::Exited)
        });
        assert!(matches!(crashed, Err(BootError::ServerFailed)));
        assert_eq!(tried, vec![4100, 4200]);
        assert!(unchanged());

        // Hung: no retry and nothing written.
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
        // Another process took the checked port before the server bound it: the server exits, the retry lands.
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

        // A quit that began while the first start was running: the exit is not retried.
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
        // No log yet: the path is still the answer.
        let empty = TempDir::new("nolog");
        assert_eq!(rotate_server_log(empty.path(), 1024), empty.path().join("server.log"));
    }

    #[test]
    fn the_stop_grace_outlasts_the_server_deadline() {
        // shutdown.ts SHUTDOWN_DEADLINE_MS, plus the exit itself.
        assert!(SIDECAR_STOP_GRACE >= Duration::from_millis(20_000 + 1_000));
        // The server's boot budget (20 s) with its own boot and a slow disk on top; the quit grace fits in it too.
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
        // A second launch mid-quit is kept for the Exit event, once.
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

        // Nothing running: the quit is over at once.
        let empty = Quit::default();
        assert!(matches!(empty.begin(|| None::<u8>), Began::Nothing));
        assert_eq!(empty.phase(), QuitPhase::Stopped);

        // A server that comes up before any quit is kept; one that comes up after is handed back to be ended.
        let quit = Quit::default();
        let mut slot = None;
        assert_eq!(quit.admit(1u8, |value| slot = Some(value)), None);
        assert_eq!(slot, Some(1));
        assert!(matches!(quit.begin(|| slot.take()), Began::Stop(1)));
        assert_eq!(quit.admit(2u8, |value| slot = Some(value)), Some(2));
        assert_eq!(slot, None);
    }

    #[test]
    fn stdin_eof_ends_a_listening_child_and_a_deaf_one_is_killed() {
        if !super::node_runs(Path::new("node")) {
            eprintln!("skipped: node is not on the PATH");
            return;
        }
        // A server with the watchdog: the end of stdin is its signal to close; it exits 0 on its own.
        let mut listening = super::command("node");
        listening
            .arg("-e")
            .arg("process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); setTimeout(() => process.exit(3), 10000);")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let sidecar = Sidecar::spawn(&mut listening).unwrap();
        assert!(matches!(sidecar.stop_gracefully(Duration::from_secs(8)), StopOutcome::Exited(Some(0))));
        // One that ignores stdin is killed once the grace has passed.
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
        // rc files print above the answer; a removed install may linger below nothing.
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
