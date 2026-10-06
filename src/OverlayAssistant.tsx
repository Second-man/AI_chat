import { useEffect, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './overlay.css'

export default function OverlayAssistant() {
  const [status, setStatus] = useState('只在你点击后读取剪贴板')
  const [collapsed, setCollapsed] = useState(false)
  const [monitoring, setMonitoring] = useState(false)
  const [showWechatConsent, setShowWechatConsent] = useState(false)

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
    await invoke('show_wechat_consent')
    setShowWechatConsent(true)
  }

  const dismissWechatConsent = async () => {
    await invoke('expand_assistant')
    setShowWechatConsent(false)
  }

  const startWechatMonitor = async () => {
    await dismissWechatConsent()
    setStatus('正在等待已授权的微信聊天窗口…')
    await invoke('start_wechat_monitor')
    setMonitoring(true)
  }

  // Use Tauri's native drag API rather than relying only on the declarative
  // drag-region attribute; some WebView2 builds do not recognize that
  // attribute for a secondary, undecorated webview.
  const startDragging = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    getCurrentWindow().startDragging().catch(() => setStatus('当前环境不支持移动悬浮助手'))
  }

  if (collapsed) {
    return <div className="assistant-orb" title="拖动外圈移动；点击 e 展开 EchoMate 快捷助手" onMouseDown={startDragging}>
      <button className="assistant-orb-expand" title="展开 EchoMate 快捷助手" onMouseDown={(event) => event.stopPropagation()} onClick={expand}>e</button>
    </div>
  }

  if (showWechatConsent) {
    return <main className="overlay-shell overlay-consent">
      <div className="overlay-consent-copy"><strong>授权前台微信监听</strong><span>仅本次会话读取当前前台、且你有权处理的微信可访问文本；切换窗口即暂停。不读微信数据库，不自动发送给模型。</span></div>
      <div className="overlay-actions"><button className="overlay-secondary" onClick={dismissWechatConsent}>取消</button><button onClick={startWechatMonitor}>同意并开始</button></div>
    </main>
  }

  return <main className="overlay-shell">
    <div className="overlay-drag-handle" title="拖动此处移动悬浮助手" onMouseDown={startDragging}>
      <div className="overlay-dot">e</div>
      <div className="overlay-copy"><strong>EchoMate 快捷助手</strong><span>{status}</span></div>
    </div>
    <div className="overlay-actions">
      <button onClick={readClipboard}>读剪贴板</button>
      <button className={monitoring ? 'overlay-stop' : 'overlay-secondary'} onClick={toggleWechatMonitor}>{monitoring ? '停止微信监听' : '监听前台微信'}</button>
      <button className="overlay-secondary" onClick={() => invoke('restore_workspace')}>工作台</button>
      <button className="overlay-close" onClick={collapse}>收起</button>
    </div>
  </main>
}
