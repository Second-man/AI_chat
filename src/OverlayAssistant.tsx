import { invoke } from '@tauri-apps/api/core'
import './overlay.css'

export default function OverlayAssistant() {
  return <main className="overlay-shell">
    <div className="overlay-dot">e</div>
    <div className="overlay-copy"><strong>EchoMate 快捷助手</strong><span>仅在你点击后读取剪贴板</span></div>
    <button onClick={() => invoke('toggle_assistant')}>收起</button>
  </main>
}
