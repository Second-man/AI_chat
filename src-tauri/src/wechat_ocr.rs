//! Local-only window capture. Never writes screenshots or sends them over a network.
use windows::{
  core::{Error, HSTRING, Result},
  Globalization::Language,
  Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap},
  Media::Ocr::OcrEngine,
  Storage::Streams::DataWriter,
  Win32::{
    Foundation::{HWND, RECT},
    Graphics::Gdi::{CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetWindowDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ},
    Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS},
    UI::WindowsAndMessaging::{FindWindowW, GetWindowRect, IsIconic, IsWindowVisible},
  },
};

pub struct OcrLine {
  pub text: String,
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  pub sent: bool,
}

pub struct Snapshot {
  pub width: i32,
  pub height: i32,
  pub lines: Vec<OcrLine>,
}

pub struct ChatSnapshot {
  pub title: String,
  pub messages: Vec<super::wechat_tracker::VisibleMessage>,
}

impl Snapshot {
  pub fn chat(&self) -> Option<ChatSnapshot> {
    // WeChat's top chat header is to the right of the search box. Use its
    // measured position instead of a percentage crop (sidebar width is fixed).
    let header = self.lines.iter().filter(|line| {
      line.y >= 30.0 && line.y < 105.0 && line.x > 180.0 && line.x < self.width as f64 * 0.85
        && !line.text.trim().is_empty()
    }).min_by(|a,b| a.y.total_cmp(&b.y).then(b.x.total_cmp(&a.x)))?;
    let scale = (header.height / 18.0).clamp(0.8, 2.5);
    let left = header.x - 28.0 * scale;
    let top = header.y + header.height + 20.0 * scale;
    // Keep the composer and draft area out of the chat region. The exact
    // height varies by WeChat build, so leave a generous bottom safety band.
    let bottom = self.height as f64 - 230.0 * scale;
    let mut lines: Vec<_> = self.lines.iter().filter(|line| {
      line.x >= left && line.x + line.width <= self.width as f64 && line.y >= top && line.y + line.height < bottom
        && !is_timestamp(&line.text, !line.sent && ((line.x + line.width/2.0) - (left + self.width as f64)/2.0).abs() < 90.0 * scale)
    }).collect();
    lines.sort_by(|a,b| a.y.total_cmp(&b.y).then(a.x.total_cmp(&b.x)));
    let mut messages: Vec<super::wechat_tracker::VisibleMessage> = Vec::new();
    let mut last_bottom = 0.0;
    let mut last_x = 0.0f64;
    for line in lines {
      let content = line.text.trim();
      if content.is_empty() || is_composer_text(content) { continue; }
      // Speaker is defined by horizontal placement in the chat pane, not
      // bubble color (themes and capture surfaces can alter colors).
      let role = if line.x + line.width / 2.0 >= (left + self.width as f64) / 2.0 { "sent" } else { "received" };
      if let Some(last) = messages.last_mut() {
        if last.role == role && line.y - last_bottom < line.height * 0.65
          && (line.x-last_x).abs() < 35.0 * scale {
          last.content.push('\n'); last.content.push_str(content);
          last_bottom = line.y + line.height; last_x = line.x;
          continue;
        }
      }
      messages.push(super::wechat_tracker::VisibleMessage { content: content.to_string(), role });
      last_bottom = line.y + line.height; last_x = line.x;
    }
    Some(ChatSnapshot { title: header.text.trim().to_string(), messages })
  }
}

fn is_timestamp(text: &str, centered: bool) -> bool {
  let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
  if !centered { return false; }
  let time_without_colon = compact.len() == 4 && compact.chars().all(|c| c.is_ascii_digit())
    && compact[..2].parse::<u32>().is_ok_and(|n| n < 24)
    && compact[2..].parse::<u32>().is_ok_and(|n| n < 60);
  time_without_colon || (compact.contains([':', '：']) && compact.chars().all(|c| c.is_ascii_digit() || ":：-/年月日周星期一二三四五六天昨上午下午晚上".contains(c)))
}

fn is_composer_text(text: &str) -> bool {
  let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
  compact.contains("按住鼠标") || compact.contains("语音输入") || compact.contains("输入文字")
    || compact.contains("按住说话") || compact == "发送" || compact == "粘贴"
}

fn is_cjk(c: char) -> bool { ('\u{3400}'..='\u{9fff}').contains(&c) }

fn normalize_ocr_text(text: &str) -> String {
  // Windows OCR inserts word separators between Chinese glyphs. Remove only
  // those separators; preserve English spaces and never guess wrong glyphs.
  let chars: Vec<char> = text.chars().collect();
  chars.iter().enumerate().filter_map(|(i,&c)| {
    if c.is_whitespace() {
      let before = chars[..i].iter().rev().find(|c| !c.is_whitespace());
      let after = chars[i+1..].iter().find(|c| !c.is_whitespace());
      if before.is_some_and(|c| is_cjk(*c)) && after.is_some_and(|c| is_cjk(*c)) { return None; }
    }
    Some(c)
  }).collect()
}

fn upscale(pixels: &[u8], width: i32, height: i32, factor: i32) -> Vec<u8> {
  let out_width = width * factor;
  let out_height = height * factor;
  let mut output = vec![0; out_width as usize * out_height as usize * 4];
  for y in 0..out_height {
    for x in 0..out_width {
      let sx = (x as f64 / factor as f64).min((width-1) as f64);
      let sy = (y as f64 / factor as f64).min((height-1) as f64);
      let (x0,y0) = (sx as i32,sy as i32);
      let (x1,y1) = ((x0+1).min(width-1),(y0+1).min(height-1));
      let (dx,dy) = (sx-x0 as f64,sy-y0 as f64);
      for channel in 0..4 {
        let at = |xx: i32, yy: i32| pixels[(yy as usize*width as usize+xx as usize)*4+channel] as f64;
        output[(y as usize*out_width as usize+x as usize)*4+channel] =
          ((at(x0,y0)*(1.0-dx)+at(x1,y0)*dx)*(1.0-dy)+(at(x0,y1)*(1.0-dx)+at(x1,y1)*dx)*dy).round() as u8;
      }
    }
  }
  output
}

fn mask_rectangle(pixels: &mut [u8], width: i32, height: i32, rect: RECT) {
  for y in rect.top.max(0)..rect.bottom.min(height) {
    for x in rect.left.max(0)..rect.right.min(width) {
      let offset = (y as usize * width as usize + x as usize) * 4;
      pixels[offset..offset+4].fill(255);
    }
  }
}

pub fn engine() -> Result<OcrEngine> {
  // Prefer Simplified Chinese rather than silently using an English-only engine.
  let language = Language::CreateLanguage(&HSTRING::from("zh-Hans"))?;
  OcrEngine::TryCreateFromLanguage(&language)
}

pub fn read_window(hwnd: HWND, engine: &OcrEngine) -> Result<Snapshot> {
  unsafe {
    if IsIconic(hwnd).as_bool() { return Err(Error::new(windows::core::HRESULT(0x80004005u32 as i32), "微信窗口已最小化")); }
    let mut rect = RECT::default();
    GetWindowRect(hwnd, &mut rect)?;
    let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
    let limit = OcrEngine::MaxImageDimension()? as i32;
    if width < 200 || height < 200 || width > limit || height > limit {
      return Err(Error::new(windows::core::HRESULT(0x80070057u32 as i32), "窗口尺寸超出本地 OCR 支持范围，请缩小微信窗口"));
    }
    let dc = GetWindowDC(Some(hwnd));
    if dc.0.is_null() { return Err(Error::from_thread()); }
    let memory = CreateCompatibleDC(Some(dc));
    if memory.0.is_null() { ReleaseDC(Some(hwnd), dc); return Err(Error::from_thread()); }
    let info = BITMAPINFO { bmiHeader: BITMAPINFOHEADER {
      biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
      biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32,
      biCompression: BI_RGB.0, ..Default::default()
    }, ..Default::default() };
    let mut bits = std::ptr::null_mut();
    let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
      Ok(bitmap) => bitmap,
      Err(error) => { let _ = DeleteDC(memory); ReleaseDC(Some(hwnd), dc); return Err(error); }
    };
    let previous = SelectObject(memory, HGDIOBJ(bitmap.0));
    // PW_RENDERFULLCONTENT captures the window itself, not overlapping desktop apps.
    let captured = PrintWindow(hwnd, memory, PRINT_WINDOW_FLAGS(2)).as_bool();
    let pixels = if captured && !bits.is_null() {
      Some(std::slice::from_raw_parts(bits as *const u8, width as usize * height as usize * 4).to_vec())
    } else { None };
    SelectObject(memory, previous);
    let _ = DeleteObject(HGDIOBJ(bitmap.0));
    let _ = DeleteDC(memory);
    ReleaseDC(Some(hwnd), dc);
    let mut pixels = pixels.ok_or_else(|| Error::new(windows::core::HRESULT(0x80004005u32 as i32), "微信窗口截图失败"))?;
    // Some Qt/GPU window surfaces include occluding windows even when
    // PrintWindow succeeds. Never OCR our own assistant: that creates a
    // feedback loop where saved messages become 'new' captured messages.
    if let Ok(assistant) = FindWindowW(None, &HSTRING::from("EchoMate 快捷助手")) {
      if IsWindowVisible(assistant).as_bool() {
        let mut overlay = RECT::default();
        if GetWindowRect(assistant, &mut overlay).is_ok() {
          mask_rectangle(&mut pixels, width, height, RECT {
            left: overlay.left - rect.left - 12, top: overlay.top - rect.top - 12,
            right: overlay.right - rect.left + 12, bottom: overlay.bottom - rect.top + 12,
          });
        }
      }
    }
    let writer = DataWriter::new()?;
    let factor = if width*2 <= limit && height*2 <= limit { 2 } else { 1 };
    let enlarged = if factor > 1 { upscale(&pixels,width,height,factor) } else { pixels.clone() };
    writer.WriteBytes(&enlarged)?;
    let image = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&writer.DetachBuffer()?, BitmapPixelFormat::Bgra8, width*factor, height*factor, BitmapAlphaMode::Ignore)?;
    let result = engine.RecognizeAsync(&image)?.join()?;
    let mut lines = Vec::new();
    for line in result.Lines()? {
      let words = line.Words()?;
      let mut left = f64::MAX;
      let mut top = f64::MAX;
      let mut right = 0.0f64;
      let mut bottom = 0.0f64;
      for word in words {
        let r = word.BoundingRect()?;
        left = left.min(r.X as f64 / factor as f64); top = top.min(r.Y as f64 / factor as f64);
        right = right.max((r.X + r.Width) as f64 / factor as f64); bottom = bottom.max((r.Y + r.Height) as f64 / factor as f64);
      }
      if left.is_finite() && top.is_finite() {
        // Outgoing bubbles use WeChat green. Sample around text rather than
        // inferring speaker from line width, which breaks on long messages.
        let mut green = 0;
        let mut samples = 0;
        for y in (top as i32 - 4).max(0)..(bottom as i32 + 4).min(height) {
          for x in (left as i32 - 5).max(0)..(right as i32 + 5).min(width) {
            let p = (y as usize * width as usize + x as usize) * 4;
            let (b,g,r) = (pixels[p] as i32, pixels[p+1] as i32, pixels[p+2] as i32);
            if g > r + 15 && g > b + 15 && g > 100 { green += 1; }
            samples += 1;
          }
        }
        lines.push(OcrLine { text: normalize_ocr_text(&line.Text()?.to_string()), x: left, y: top, width: right-left, height: bottom-top, sent: green * 5 > samples });
      }
    }
    Ok(Snapshot { width, height, lines })
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test] fn timestamps_require_centered_geometry() {
    assert!(is_timestamp("2035",true));
    assert!(is_timestamp("20:35",true));
    assert!(!is_timestamp("2035",false));
    assert!(!is_timestamp("什么东西",true));
  }
  #[test] fn composer_hints_are_not_messages() {
    assert!(is_composer_text("按住鼠标语音输入文字"));
    assert!(is_composer_text("发送"));
    assert!(!is_composer_text("今天几点见？"));
  }
  #[test] fn chinese_spacing_preserves_english() {
    assert_eq!(normalize_ocr_text("什 么 东 西"),"什么东西");
    assert_eq!(normalize_ocr_text("hello world"),"hello world");
    assert_eq!(normalize_ocr_text("亻 十 么"),"亻十么");
  }
  fn line(text: &str, x: f64, y: f64, sent: bool) -> OcrLine {
    OcrLine {text:text.into(), x, y, width:80.0, height:18.0, sent}
  }
  #[test]
  fn masks_overlay_pixels_without_touching_other_content() {
    let mut pixels = vec![0; 4*4*4];
    mask_rectangle(&mut pixels,4,4,RECT {left:-1, top:1, right:2, bottom:3});
    assert_eq!(&pixels[16..24], &[255;8]);
    assert_eq!(&pixels[24..32], &[0;8]);
    assert_eq!(&pixels[..16], &[0;16]);
  }
  #[test]
  fn speaker_uses_position_even_when_color_detection_is_wrong() {
    let snapshot = Snapshot {width:1550, height:926, lines:vec![
      line("测试联系人",380.0,55.0,false),
      line("左侧消息",420.0,180.0,true),
      line("右侧消息",1350.0,240.0,false),
      line("2035",1350.0,300.0,false),
    ]};
    let chat = snapshot.chat().unwrap();
    assert_eq!(chat.messages.len(),3);
    assert_eq!(chat.messages[0].role,"received");
    assert_eq!(chat.messages[1].role,"sent");
    assert_eq!(chat.messages[2].content,"2035");
  }
  #[test]
  fn separates_header_sidebar_input_and_message_roles() {
    let snapshot = Snapshot {width:1550, height:926, lines:vec![
      line("搜索",110.0,55.0,false), line("测试联系人",380.0,55.0,false),
      line("侧栏联系人",130.0,180.0,false), line("昨天 12:30",925.0,130.0,false),
      line("对方新消息",420.0,180.0,false), line("我的消息",1350.0,240.0,true),
      line("未发送的草稿",400.0,820.0,false),
    ]};
    let chat = snapshot.chat().unwrap();
    assert_eq!(chat.title,"测试联系人");
    assert_eq!(chat.messages.len(),2);
    assert_eq!(chat.messages[0].role,"received");
    assert_eq!(chat.messages[1].role,"sent");
  }
  #[test]
  #[ignore = "reads the user's running WeChat window; run explicitly for local verification"]
  fn live_window_capture_and_chinese_ocr() {
    use windows::Win32::{System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED}, UI::WindowsAndMessaging::FindWindowW};
    unsafe {
      CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
      let hwnd = FindWindowW(None, &HSTRING::from("微信")).unwrap();
      let snapshot = read_window(hwnd, &engine().expect("安装 Windows 简体中文 OCR 语言组件")).unwrap();
      println!("window={}x{}, OCR lines={}", snapshot.width, snapshot.height, snapshot.lines.len());
      for line in &snapshot.lines {
        println!("bounds={:.0},{:.0},{:.0},{:.0} chars={}", line.x, line.y, line.width, line.height, line.text.chars().count());
      }
      assert!(!snapshot.lines.is_empty(), "截图成功但 OCR 未读到任何文本");
      let chat = snapshot.chat().expect("未定位当前聊天标题");
      println!("chat_title_chars={}, messages={}, sent={}", chat.title.chars().count(), chat.messages.len(), chat.messages.iter().filter(|m| m.role=="sent").count());
      CoUninitialize();
    }
  }
}
