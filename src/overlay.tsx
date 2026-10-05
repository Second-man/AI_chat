import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import './overlay.css'

function Overlay() {
  return <main className="overlay-shell">
    <div className="overlay-dot">e</div>
    <div className="overlay-copy"><strong>EchoMate 快捷助手</strong><span>仅在你点击后读取剪贴板</span></div>
    <button onClick={() => invoke('toggle_assistant')}>收起</button>
  </main>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><Overlay /></StrictMode>,
)
