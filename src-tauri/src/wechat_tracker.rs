//! Incremental visible-message tracking, independent of capture technology.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisibleMessage {
  pub content: String,
  pub role: &'static str,
}

#[derive(Default)]
pub struct Tracker {
  previous: Vec<VisibleMessage>,
  baseline: bool,
  recent_views: std::collections::VecDeque<Vec<VisibleMessage>>,
}

impl Tracker {
  pub fn reset(&mut self) { *self = Self::default(); }

  pub fn observe(&mut self, current: Vec<VisibleMessage>) -> Vec<VisibleMessage> {
    if !self.baseline {
      self.previous = current;
      self.baseline = true;
      return Vec::new();
    }
    if self.previous == current { return Vec::new(); }
    // A blank capture after messages were visible is not a genuinely empty
    // conversation. Keep the last usable baseline across rendering failures.
    if current.is_empty() && !self.previous.is_empty() { return Vec::new(); }
    let returning_to_history = self.recent_views.contains(&current);
    // Only additions after the previous trailing message count. An entirely
    // different viewport is a new baseline, not an import of old history.
    let overlap = (1..=self.previous.len().min(current.len())).rev().find_map(|n| {
      let tail = &self.previous[self.previous.len()-n..];
      current.windows(n).position(|window| window == tail).map(|start| start+n)
    });
    let added = if returning_to_history { Vec::new() }
      else if self.previous.is_empty() { current.clone() }
      else { overlap.map(|n| current[n..].to_vec()).unwrap_or_default() };
    self.recent_views.push_back(self.previous.clone());
    if self.recent_views.len() > 64 { self.recent_views.pop_front(); }
    self.previous = current;
    added
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  fn messages(values: &[&str]) -> Vec<VisibleMessage> {
    values.iter().map(|v| VisibleMessage {content: v.to_string(), role:"received"}).collect()
  }
  fn stable(t: &mut Tracker, values: &[&str]) -> Vec<VisibleMessage> {
    t.observe(messages(values))
  }
  #[test] fn baseline_does_not_import_history() {
    let mut t = Tracker::default(); assert!(stable(&mut t, &["旧消息"]).is_empty());
  }
  #[test] fn captures_appended_messages_once() {
    let mut t = Tracker::default(); stable(&mut t, &["旧消息"]);
    assert_eq!(stable(&mut t, &["旧消息", "新消息"]), messages(&["新消息"]));
    assert!(stable(&mut t, &["旧消息", "新消息"]).is_empty());
  }
  #[test] fn identical_text_can_be_sent_twice() {
    let mut t = Tracker::default(); stable(&mut t, &["你好"]);
    assert_eq!(stable(&mut t, &["你好", "你好"]), messages(&["你好"]));
  }
  #[test] fn tail_overlap_handles_upward_shift_on_new_message() {
    let mut t = Tracker::default(); stable(&mut t, &["一", "二", "三"]);
    assert_eq!(stable(&mut t, &["二", "三", "四"]), messages(&["四"]));
  }
  #[test] fn unrelated_viewport_is_not_new_messages() {
    let mut t = Tracker::default(); stable(&mut t, &["现在"]);
    assert!(stable(&mut t, &["更早的历史"]).is_empty());
  }
  #[test] fn transient_ocr_does_not_emit() {
    let mut t = Tracker::default(); stable(&mut t, &["你好"]);
    assert_eq!(t.observe(messages(&["你好", "误识别"])), messages(&["误识别"]));
    assert!(stable(&mut t, &["你好"]).is_empty());
  }
  #[test] fn reset_rebuilds_baseline() {
    let mut t = Tracker::default(); stable(&mut t, &["一"]); t.reset();
    assert!(stable(&mut t, &["另一个会话"]).is_empty());
  }
  #[test] fn first_message_in_empty_chat_is_new() {
    let mut t = Tracker::default(); stable(&mut t, &[]);
    assert_eq!(stable(&mut t, &["第一条"]), messages(&["第一条"]));
  }
  #[test] fn blank_frames_do_not_reimport_visible_history() {
    let mut t = Tracker::default(); stable(&mut t, &["历史"]);
    assert!(stable(&mut t, &[]).is_empty());
    assert!(stable(&mut t, &["历史"]).is_empty());
    assert_eq!(stable(&mut t, &["历史", "新增"]), messages(&["新增"]));
  }
  #[test] fn scrolling_back_to_previous_view_does_not_emit() {
    let mut t = Tracker::default(); stable(&mut t, &["一", "二", "三"]);
    stable(&mut t, &["二", "三", "四"]);
    assert!(stable(&mut t, &["一", "二", "三"]).is_empty());
    assert!(stable(&mut t, &["二", "三", "四"]).is_empty());
  }
  #[test] fn historical_ocr_jitter_does_not_block_stable_new_tail() {
    let mut t = Tracker::default(); stable(&mut t, &["历史", "尾部"]);
    assert_eq!(t.observe(messages(&["历吏", "尾部", "新消息"])), messages(&["新消息"]));
    assert_eq!(t.observe(messages(&["历史", "尾部", "新消息"])),messages(&["新消息"]));
  }
}
