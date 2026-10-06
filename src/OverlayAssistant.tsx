import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import './overlay.css'

export default function OverlayAssistant() {
  const [status, setStatus] = useState('只在你点击后读取剪贴板')
  const [collapsed, setCollapsed] = useState(false)
  const [monitoring, setMonitoring] = useState(false)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<{ state: string; detail: string }>('wechat-monitor-status', (event) => {
      setStatus(event.payload.detail)
      setMonitoring(['probing', 'mapping', 'monitoring', 'paused', 'fallback_ocr'].includes(event.payload.state))
    }).then((stop) => { unlisten = stop }).catch(() => undefined)
    return () => unlisten?.()
  }, [])

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

  const toggleWechatMonitor = async () => {
    if (monitoring) {
      await invoke('stop_wechat_monitor')
      setMonitoring(false)
      setStatus('微信前台监听已停止')
      return
    }
    const allowed = window.confirm('仅在本次会话中读取当前前台、且你有权处理的微信聊天可访问文本；切换到其他窗口会暂停。不会读取微信数据库，不会自动发送给模型。是否开始？')
    if (!allowed) return
    setStatus('正在等待已授权的微信聊天窗口…')
    await invoke('start_wechat_monitor')
    setMonitoring(true)
  }

  if (collapsed) {
    return <button className="assistant-orb" data-tauri-drag-region title="拖动移动；单击展开 EchoMate 快捷助手" onClick={expand}>e</button>
  }

  return <main className="overlay-shell">
    <div className="overlay-drag-handle" data-tauri-drag-region title="拖动此处移动悬浮助手">
      <div className="overlay-dot" data-tauri-drag-region>e</div>
      <div className="overlay-copy" data-tauri-drag-region><strong>EchoMate 快捷助手</strong><span>{status}</span></div>
    </div>
    <div className="overlay-actions">
      <button onClick={readClipboard}>读剪贴板</button>
      <button className={monitoring ? 'overlay-stop' : 'overlay-secondary'} onClick={toggleWechatMonitor}>{monitoring ? '停止微信监听' : '监听前台微信'}</button>
      <button className="overlay-secondary" onClick={() => invoke('restore_workspace')}>工作台</button>
      <button className="overlay-close" onClick={collapse}>收起</button>
    </div>
  </main>
}
