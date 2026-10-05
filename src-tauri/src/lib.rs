use std::{env, fs, path::PathBuf, process::{Child, Command}, sync::Mutex};
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

fn development_python(root: &PathBuf) -> PathBuf {
  if let Ok(python) = env::var("ECHOMATE_PYTHON") {
    return PathBuf::from(python);
  }

  // This repository is commonly kept in D:\AI_\chat-companion while its
  // project virtual environment lives in D:\AI_\.venv. Check both locations
  // rather than accidentally falling back to an unrelated system Python.
  for candidate in [
    root.join(".venv").join("python.exe"),
    root.parent().unwrap_or(root).join(".venv").join("python.exe"),
  ] {
    if candidate.exists() {
      return candidate;
    }
  }
  PathBuf::from("python")
}

fn write_startup_error(data_dir: &PathBuf, message: &str) {
  let _ = fs::create_dir_all(data_dir);
  let _ = fs::write(data_dir.join("startup-error.log"), message);
}

fn start_local_api(app: &tauri::AppHandle) {
  let root = project_root();
  let (program, arguments, working_dir, data_dir) = if cfg!(debug_assertions) {
    (development_python(&root), vec!["backend/main.py".to_string()], root.clone(), root.join(".echomate"))
  } else {
    let data_dir = app.path().app_local_data_dir().unwrap_or_else(|_| root.join(".echomate"));
    let executable = app.path().resource_dir()
      .unwrap_or_else(|_| root.join("resources"))
      .join("resources").join("echomate-api").join("echomate-api.exe");
    (executable, Vec::new(), data_dir.clone(), data_dir)
  };
  let launch_message = format!("无法启动本地 AI 服务。程序：{}；工作目录：{}", program.display(), working_dir.display());
  match Command::new(&program)
    .current_dir(working_dir)
    .env("ECHOMATE_DATA_DIR", &data_dir)
    .args(arguments)
    .spawn() {
      Ok(child) => {
        if let Ok(mut process) = app.state::<LocalApiProcess>().0.lock() {
          *process = Some(child);
        }
        let _ = fs::remove_file(data_dir.join("startup-error.log"));
      }
      Err(error) => {
        let message = format!("{launch_message}\n系统错误：{error}");
        eprintln!("{message}");
        write_startup_error(&data_dir, &message);
      }
    }
}

fn stop_local_api(app: &tauri::AppHandle) {
  if let Ok(mut process) = app.state::<LocalApiProcess>().0.lock() {
    if let Some(mut child) = process.take() {
      let _ = child.kill();
    }
  }
}

fn assistant_page_source() -> &'static str {
  if cfg!(debug_assertions) {
    // The main window is served by Vite during `tauri dev`, but dynamically
    // created `App` URLs resolve through Tauri's packaged asset protocol.
    // Point the child explicitly at Vite so its document and module scripts
    // are available in development as well.
    "http://localhost:5173/overlay.html"
  } else {
    "overlay.html"
  }
}

fn assistant_page() -> WebviewUrl {
  if cfg!(debug_assertions) {
    WebviewUrl::External(assistant_page_source().parse().expect("valid Vite overlay URL"))
  } else {
    WebviewUrl::App(assistant_page_source().into())
  }
}

#[cfg(test)]
mod tests {
  use super::assistant_page_source;

  #[test]
  fn dev_overlay_uses_the_vite_document() {
    assert_eq!(assistant_page_source(), "http://localhost:5173/overlay.html");
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
  // Use a dedicated document instead of routing the main workspace with a
  // fragment. Keep this child WebView opaque: some Windows WebView2 drivers
  // leave transparent child windows as an unpainted white rectangle.
  WebviewWindowBuilder::new(&app, "assistant", assistant_page())
    .title("EchoMate 快捷助手")
    .inner_size(360.0, 86.0)
    .min_inner_size(300.0, 72.0)
    .resizable(false)
    .decorations(false)
    .transparent(false)
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
