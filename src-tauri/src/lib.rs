use std::{env, fs, path::PathBuf, process::{Child, Command}, sync::Mutex};
use tauri::{Emitter, Manager};

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

fn restore_main_window(app: &tauri::AppHandle) -> Result<(), String> {
  if let Some(assistant) = app.get_webview_window("assistant") {
    assistant.hide().map_err(|error| error.to_string())?;
  }
  if let Some(main) = app.get_webview_window("main") {
    main.unminimize().map_err(|error| error.to_string())?;
    main.show().map_err(|error| error.to_string())?;
    main.set_focus().map_err(|error| error.to_string())?;
  }
  Ok(())
}

fn expand_assistant_window(app: &tauri::AppHandle) -> Result<(), String> {
  let assistant = app.get_webview_window("assistant")
    .ok_or("快捷助手窗口未初始化。请重启 EchoMate 后重试。")?;
  assistant.set_min_size(Some(tauri::LogicalSize::new(360.0, 90.0))).map_err(|error| error.to_string())?;
  assistant.set_size(tauri::LogicalSize::new(420.0, 104.0)).map_err(|error| error.to_string())?;
  Ok(())
}

#[tauri::command]
fn collapse_assistant(app: tauri::AppHandle) -> Result<(), String> {
  let assistant = app.get_webview_window("assistant")
    .ok_or("快捷助手窗口未初始化。请重启 EchoMate 后重试。")?;
  assistant.set_min_size::<tauri::LogicalSize<f64>>(None).map_err(|error| error.to_string())?;
  assistant.set_size(tauri::LogicalSize::new(52.0, 52.0)).map_err(|error| error.to_string())?;
  Ok(())
}

#[tauri::command]
fn expand_assistant(app: tauri::AppHandle) -> Result<(), String> {
  expand_assistant_window(&app)
}

#[tauri::command]
fn restore_workspace(app: tauri::AppHandle) -> Result<(), String> {
  restore_main_window(&app)
}

#[tauri::command]
fn deliver_overlay_draft(app: tauri::AppHandle, content: String) -> Result<(), String> {
  let content = content.trim().to_string();
  if content.is_empty() {
    return Err("剪贴板中没有可用文字。".into());
  }
  app.emit("overlay-draft", content).map_err(|error| error.to_string())?;
  restore_main_window(&app)
}

#[tauri::command]
fn toggle_assistant(app: tauri::AppHandle) -> Result<(), String> {
  if let Some(window) = app.get_webview_window("assistant") {
    if window.is_visible().map_err(|error| error.to_string())? {
      collapse_assistant(app.clone())?;
    } else {
      if let Some(main) = app.get_webview_window("main") {
        main.minimize().map_err(|error| error.to_string())?;
      }
      expand_assistant_window(&app)?;
      window.show().map_err(|error| error.to_string())?;
      window.set_focus().map_err(|error| error.to_string())?;
    }
    return Ok(());
  }
  Err("快捷助手窗口未初始化。请重启 EchoMate 后重试。".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(LocalApiProcess(Mutex::new(None)))
    .invoke_handler(tauri::generate_handler![toggle_assistant, restore_workspace, deliver_overlay_draft, collapse_assistant, expand_assistant])
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
      // The assistant (including its collapsed orb) intentionally remains
      // visible when another application gains focus. It is an always-on-top
      // desktop companion and is hidden only by an explicit user action.
      if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
        stop_local_api(app);
      }
    });
}
