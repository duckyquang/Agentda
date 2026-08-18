#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// The shell is deliberately thin: the daemon owns every decision, and this
// window is a client of its loopback API like any other. That keeps one
// implementation of the gate, the audit log, and the approval queue — a desktop
// app with its own copy of any of that would be a second place for them to
// disagree.
//
// The daemon is started as a child process and its printed URL (which carries
// the per-run token) is what the window loads. Bundling it as a packaged
// sidecar binary needs Node itself packaged and is not done yet; see the
// desktop README.

struct Daemon(Mutex<Option<Child>>);

fn repo_root() -> PathBuf {
    // src-tauri/../../.. — apps/desktop/src-tauri lives three levels down.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .expect("repo root")
        .to_path_buf()
}

fn spawn_daemon() -> std::io::Result<(Child, String)> {
    let root = repo_root();
    let mut child = Command::new("node")
        .arg("--env-file-if-exists=.env.local")
        .arg("node_modules/tsx/dist/cli.mjs")
        .arg("apps/daemon/src/index.ts")
        .current_dir(&root)
        // The daemon exits when this pipe closes, which is the only thing that
        // still works if the window is killed outright — otherwise a headless
        // daemon keeps polling Telegram and firing routines with nothing on
        // screen to say so.
        .env("AGENTDA_EXIT_WITH_PARENT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;

    let stdout = child.stdout.take().expect("piped stdout");
    let (tx, rx) = channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            // Everything the daemon says still belongs in the terminal: the
            // pairing code is printed there and people need to read it.
            println!("{line}");
            if let Some(url) = line.strip_prefix("desktop UI at ") {
                let _ = tx.send(url.trim().to_string());
            }
        }
    });

    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(url) => Ok((child, url)),
        Err(RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            Err(std::io::Error::other("the daemon did not report a URL within 60s"))
        }
        Err(RecvTimeoutError::Disconnected) => {
            let _ = child.wait();
            Err(std::io::Error::other("the daemon exited before it was ready"))
        }
    }
}

fn main() {
    // Point at an already-running daemon instead of starting one — how you work
    // on the daemon and the window at the same time.
    let existing = std::env::var("AGENTDA_URL").ok();

    tauri::Builder::default()
        .manage(Daemon(Mutex::new(None)))
        .setup(move |app| {
            let url = match existing.clone() {
                Some(url) => url,
                None => {
                    let (child, url) = spawn_daemon()?;
                    *app.state::<Daemon>().0.lock().unwrap() = Some(child);
                    url
                }
            };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Agentda")
                .inner_size(1180.0, 800.0)
                .min_inner_size(880.0, 560.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start the Agentda window")
        .run(|app, event| {
            // Quitting ends the daemon we started. The stdin pipe covers the
            // cases this event never fires for.
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Daemon>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
