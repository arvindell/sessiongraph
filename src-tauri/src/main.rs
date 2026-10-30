#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{io::{BufRead, BufReader}, process::{Child, Command, Stdio}, sync::Mutex, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

struct Backend(Mutex<Child>);
impl Drop for Backend { fn drop(&mut self) { if let Ok(child) = self.0.get_mut() { let _ = child.kill(); let _ = child.wait(); } } }

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let resource = if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
            } else { app.path().resource_dir()?.join("resources") };
            let node = resource.join(if cfg!(windows) { "node.exe" } else { "node" });
            let mut command = Command::new(node);
            command.arg(resource.join("server.mjs")).arg("--assets").arg(resource.join("web"))
                .arg("--parent-pid").arg(std::process::id().to_string())
                .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::inherit());
            #[cfg(windows)] {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = command.spawn()?;
            let stdout = child.stdout.take().ok_or("Backend did not provide stdout")?;
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut line = String::new();
                let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
                let _ = sender.send(result);
            });
            let line = match receiver.recv_timeout(Duration::from_secs(30)) {
                Ok(Ok(line)) => line,
                _ => { let _ = child.kill(); return Err("Session Atlas local backend could not start".into()); }
            };
            let ready: serde_json::Value = serde_json::from_str(&line)?;
            let url: tauri::Url = ready["url"].as_str().ok_or("Missing backend URL")?.parse()?;
            if url.host_str() != Some("127.0.0.1") { let _ = child.kill(); return Err("Invalid local backend URL".into()); }
            let origin = url.origin();
            app.manage(Backend(Mutex::new(child)));
            let handle = app.handle().clone();
            let external = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Session Atlas — Search & visualize all your LLM sessions").inner_size(1440.0, 960.0).min_inner_size(380.0, 600.0)
                .on_new_window(move |url, _| {
                    if ["http", "https"].contains(&url.scheme()) { let _ = external.opener().open_url(url.as_str(), None::<&str>); }
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_navigation(move |url| {
                    if url.origin() == origin { return true; }
                    if ["http", "https"].contains(&url.scheme()) { let _ = handle.opener().open_url(url.as_str(), None::<&str>); }
                    false
                }).build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not build Session Atlas")
        .run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(backend) = handle.try_state::<Backend>() { if let Ok(mut child) = backend.0.lock() { let _ = child.kill(); let _ = child.wait(); } }
            }
        });
}
