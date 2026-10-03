use std::{env, path::PathBuf, process::{Child, Command}, sync::Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct LocalApiProcess(Mutex<Option<Child>>);

fn project_root() -> PathBuf {
  // `current_dir` varies between `tauri dev`, an installed application and an IDE.
  // Cargo always compiles this file from `<project>/src-tauri`, so this is stable.
  PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .map(PathBuf::from)
    .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn start_local_api(app: &tauri::AppHandle) {
  let root = project_root();
  let python = env::var("ECHOMATE_PYTHON").unwrap_or_else(|_| {
    let bundled = root.join(".venv").join("python.exe");
    if bundled.exists() { bundled.to_string_lossy().to_string() } else { "python".to_string() }
  });
  match Command::new(python)
    .current_dir(&root)
    .env("ECHOMATE_DATA_DIR", root.join(".echomate"))
    .args(["backend/main.py"])
    .spawn() {
      Ok(child) => {
        if let Ok(mut process) = app.state::<LocalApiProcess>().0.lock() {
          *process = Some(child);
        }
      }
      Err(error) => eprintln!("Unable to start EchoMate local API: {error}"),
    }
}

fn stop_local_api(app: &tauri::AppHandle) {
  if let Ok(mut process) = app.state::<LocalApiProcess>().0.lock() {
    if let Some(mut child) = process.take() {
      let _ = child.kill();
    }
  }
}

#[tauri::command]
fn toggle_assistant(app: tauri::AppHandle) -> Result<(), String> {
  if let Some(window) = app.get_webview_window("assistant") {
    if window.is_visible().map_err(|error| error.to_string())? {
      window.hide().map_err(|error| error.to_string())?;
    } else {
      window.show().map_err(|error| error.to_string())?;
      window.set_focus().map_err(|error| error.to_string())?;
    }
    return Ok(());
  }
  WebviewWindowBuilder::new(&app, "assistant", WebviewUrl::App("index.html#overlay".into()))
    .title("EchoMate 快捷助手")
    .inner_size(360.0, 86.0)
    .min_inner_size(300.0, 72.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .build()
    .map_err(|error| error.to_string())?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(LocalApiProcess(Mutex::new(None)))
    .invoke_handler(tauri::generate_handler![toggle_assistant])
    .setup(|app| {
      start_local_api(app.handle());
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Focused(false), .. } = &event {
        if label == "assistant" {
          if let Some(window) = app.get_webview_window("assistant") {
            let _ = window.hide();
          }
        }
      }
      if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
        stop_local_api(app);
      }
    });
}
