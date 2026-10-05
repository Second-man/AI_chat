import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './overlay.css'

export default function OverlayAssistant() {
  const [status, setStatus] = useState('只在你点击后读取剪贴板')
  const [collapsed, setCollapsed] = useState(false)

  const readClipboard = async () => {
    try {
      const content = await navigator.clipboard.readText()
      if (!content.trim()) {
        setStatus('剪贴板中没有可用文字')
        return
      }
      await invoke('deliver_overlay_draft', { content })
      setStatus(`已将 ${content.trim().length} 个字转入工作台`)
    } catch {
      setStatus('无法读取剪贴板，请在工作台手动粘贴')
    }
  }

  const collapse = async () => {
    await invoke('collapse_assistant')
    setCollapsed(true)
  }

  const expand = async () => {
    await invoke('expand_assistant')
    setCollapsed(false)
  }

  if (collapsed) {
    return <button className="assistant-orb" title="展开 EchoMate 快捷助手" onClick={expand}>e</button>
  }

  return <main className="overlay-shell">
    <div className="overlay-dot">e</div>
    <div className="overlay-copy"><strong>EchoMate 快捷助手</strong><span>{status}</span></div>
    <div className="overlay-actions">
      <button onClick={readClipboard}>读剪贴板</button>
      <button className="overlay-secondary" onClick={() => invoke('restore_workspace')}>工作台</button>
      <button className="overlay-close" onClick={collapse}>收起</button>
    </div>
  </main>
}
