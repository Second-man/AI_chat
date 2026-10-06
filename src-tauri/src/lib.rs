use std::{env, fs, path::PathBuf, process::{Child, Command}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, thread, time::Duration};
use tauri::{Emitter, Manager};

#[cfg(target_os = "windows")]
use windows::{
  Win32::{
    Foundation::HWND,
    System::{
      Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED},
      Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION},
    },
    UI::{
      Accessibility::{CUIAutomation, IUIAutomation, TreeScope_Subtree, UIA_NamePropertyId},
      WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, GetWindowTextLengthW, GetWindowTextW},
    },
  },
};

struct LocalApiProcess(Mutex<Option<Child>>);

/// The monitor is opt-in and ephemeral. It never searches hidden windows or
/// chat databases: it polls only the *currently foreground* WeChat window.
struct WechatMonitor {
  active: Arc<AtomicBool>,
  contact_id: Mutex<Option<i64>>,
}

impl Default for WechatMonitor {
  fn default() -> Self {
    Self { active: Arc::new(AtomicBool::new(false)), contact_id: Mutex::new(None) }
  }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WechatStatus {
  state: &'static str,
  detail: String,
  chat_title: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WechatMessage {
  chat_title: String,
  content: String,
  role: &'static str,
  source_key: String,
}

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

fn emit_wechat_status(app: &tauri::AppHandle, state: &'static str, detail: impl Into<String>, chat_title: Option<String>) {
  let _ = app.emit("wechat-monitor-status", WechatStatus { state, detail: detail.into(), chat_title });
}

#[cfg(target_os = "windows")]
unsafe fn foreground_window_title(hwnd: HWND) -> String {
  let length = unsafe { GetWindowTextLengthW(hwnd) };
  if length <= 0 { return String::new(); }
  let mut buffer = vec![0u16; length as usize + 1];
  let written = unsafe { GetWindowTextW(hwnd, &mut buffer) };
  String::from_utf16_lossy(&buffer[..written as usize]).trim().to_string()
}

#[cfg(target_os = "windows")]
unsafe fn foreground_process_is_wechat(hwnd: HWND) -> bool {
  let mut process_id = 0u32;
  unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)); }
  if process_id == 0 { return false; }
  let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }) else { return false; };
  let mut path = vec![0u16; 2048];
  let mut length = path.len() as u32;
  let result = unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, windows::core::PWSTR(path.as_mut_ptr()), &mut length) };
  let _ = unsafe { windows::Win32::Foundation::CloseHandle(process) };
  if result.is_err() { return false; }
  // The current Windows desktop client identifies its main process as
  // `Weixin.exe` (and may host parts of its UI in `WeChatAppEx.exe`), while
  // older builds use `WeChat.exe`. Accept the official variants only.
  let executable = String::from_utf16_lossy(&path[..length as usize]).to_lowercase();
  executable.contains("wechat") || executable.contains("weixin") || executable.contains("xwechat")
}

#[cfg(target_os = "windows")]
unsafe fn read_visible_uia_text(hwnd: HWND) -> windows::core::Result<Vec<String>> {
  // UI Automation reads accessibility data exposed by the visible app. It
  // cannot access WeChat's stored chat history or private databases.
  let automation: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }?;
  let root = unsafe { automation.ElementFromHandle(hwnd) }?;
  let condition = unsafe { automation.CreateTrueCondition() }?;
  let elements = unsafe { root.FindAll(TreeScope_Subtree, &condition) }?;
  let count = unsafe { elements.Length() }?;
  let mut result = Vec::new();
  for index in 0..count {
    let element = unsafe { elements.GetElement(index) }?;
    let name = unsafe { element.GetCurrentPropertyValue(UIA_NamePropertyId) }?;
    let text = name.to_string();
    let text = text.trim();
    // Labels such as buttons and navigation entries are generally very short;
    // excluding them reduces accidental capture while retaining message text.
    if text.chars().count() >= 2 && text.chars().count() <= 2000 && !result.iter().any(|seen: &String| seen == text) {
      result.push(text.to_string());
    }
  }
  Ok(result)
}

#[cfg(target_os = "windows")]
fn run_wechat_monitor(app: tauri::AppHandle, active: Arc<AtomicBool>) {
  let mut previous_lines: Vec<String> = Vec::new();
  let mut last_title = String::new();
  let mut baseline_pending = true;
  unsafe { let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED); }
  emit_wechat_status(&app, "probing", "正在等待你切换到前台微信聊天窗口…", None);
  while active.load(Ordering::SeqCst) {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() || !unsafe { foreground_process_is_wechat(hwnd) } {
      emit_wechat_status(&app, "paused", "监听已暂停：请将已授权的微信聊天窗口置于前台。", None);
      thread::sleep(Duration::from_millis(850));
      continue;
    }
    let title = unsafe { foreground_window_title(hwnd) };
    if title.is_empty() {
      emit_wechat_status(&app, "paused", "未识别到当前微信聊天标题，未读取任何内容。", None);
      thread::sleep(Duration::from_millis(850));
      continue;
    }
    if title != last_title {
      previous_lines.clear();
      baseline_pending = true;
      last_title = title.clone();
      emit_wechat_status(&app, "mapping", "检测到微信聊天，请确认要保存到哪个本地联系人。", Some(title.clone()));
    }
    match unsafe { read_visible_uia_text(hwnd) } {
      Ok(lines) if lines.is_empty() => {
        emit_wechat_status(&app, "fallback_ocr", "微信未暴露可读的无障碍文本；可选择仅本次会话启用本地 OCR。", Some(title));
      }
      Ok(lines) => {
        // The existing screen is a visual snapshot, not a history import.
        // Starting from a baseline makes this feature capture only messages
        // that appear after the user explicitly starts listening (or changes
        // the selected WeChat conversation).
        if baseline_pending {
          previous_lines = lines;
          baseline_pending = false;
          emit_wechat_status(&app, "monitoring", "已建立当前可见内容基线；现在只保存之后新出现的可访问文本。", Some(title));
          thread::sleep(Duration::from_millis(850));
          continue;
        }
        let current = lines.iter().filter(|line| !previous_lines.contains(line)).cloned().collect::<Vec<_>>();
        if !current.is_empty() {
          for line in current {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            (title.as_str(), line.as_str()).hash(&mut hasher);
            let source_key = format!("{:016x}", hasher.finish());
            let _ = app.emit("wechat-monitor-message", WechatMessage { chat_title: title.clone(), content: line, role: "received", source_key });
          }
        }
        previous_lines = lines;
        emit_wechat_status(&app, "monitoring", "正在读取当前前台聊天中新出现的可访问文本。切换窗口即暂停。", Some(title));
      }
      Err(_) => emit_wechat_status(&app, "fallback_ocr", "此微信版本未提供可用无障碍文本；可选择仅本次会话启用本地 OCR。", Some(title)),
    }
    thread::sleep(Duration::from_millis(850));
  }
  unsafe { CoUninitialize(); }
  emit_wechat_status(&app, "stopped", "微信前台监听已停止。", None);
}

#[cfg(not(target_os = "windows"))]
fn run_wechat_monitor(app: tauri::AppHandle, _active: Arc<AtomicBool>) {
  emit_wechat_status(&app, "unsupported", "微信前台监听仅在 Windows 桌面版可用。", None);
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
  assistant.set_size(tauri::LogicalSize::new(420.0, 132.0)).map_err(|error| error.to_string())?;
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
fn show_wechat_consent(app: tauri::AppHandle) -> Result<(), String> {
  let assistant = app.get_webview_window("assistant")
    .ok_or("快捷助手窗口未初始化。请重启 EchoMate 后重试。")?;
  assistant.set_min_size(Some(tauri::LogicalSize::new(360.0, 180.0))).map_err(|error| error.to_string())?;
  assistant.set_size(tauri::LogicalSize::new(420.0, 210.0)).map_err(|error| error.to_string())?;
  Ok(())
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

#[tauri::command]
fn start_wechat_monitor(app: tauri::AppHandle) -> Result<(), String> {
  let monitor = app.state::<WechatMonitor>();
  if monitor.active.swap(true, Ordering::SeqCst) {
    return Ok(());
  }
  let active = Arc::clone(&monitor.active);
  let handle = app.clone();
  thread::spawn(move || run_wechat_monitor(handle, active));
  Ok(())
}

#[tauri::command]
fn stop_wechat_monitor(app: tauri::AppHandle) {
  app.state::<WechatMonitor>().active.store(false, Ordering::SeqCst);
}

#[tauri::command]
fn set_wechat_contact(app: tauri::AppHandle, contact_id: i64) {
  if let Ok(mut contact) = app.state::<WechatMonitor>().contact_id.lock() {
    *contact = Some(contact_id);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(LocalApiProcess(Mutex::new(None)))
    .manage(WechatMonitor::default())
    .invoke_handler(tauri::generate_handler![toggle_assistant, restore_workspace, deliver_overlay_draft, collapse_assistant, expand_assistant, show_wechat_consent, start_wechat_monitor, stop_wechat_monitor, set_wechat_contact])
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
