import { useEffect, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './overlay.css'

const API = 'http://127.0.0.1:8787'
type Contact = { id: number; name: string; relationship: string }
type Message = { id: number; role: 'sent' | 'received'; content: string; source: string }
type Analysis = { answer: string; citations: { file_name: string; excerpt: string }[] }
type AnalysisHistory = { id: number; prompt: string; response: string; created_at: string }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json', ...options?.headers }, ...options })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail || '本地服务暂时无法完成请求')
  }
  return response.json()
}

export default function OverlayAssistant() {
  const [status, setStatus] = useState('选择联系人后记录或预览一条消息')
  const [collapsed, setCollapsed] = useState(false)
  const [monitoring, setMonitoring] = useState(false)
  const [showWechatConsent, setShowWechatConsent] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [role, setRole] = useState<'received' | 'sent'>('received')
  const [busy, setBusy] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [analysisMinimized, setAnalysisMinimized] = useState(false)
  const [showAnalysisHistory, setShowAnalysisHistory] = useState(false)
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisHistory[]>([])
  const loadMessages = async (contactId: number) => setMessages(await request<Message[]>(`/contacts/${contactId}/messages`))
  const loadAnalysisHistory = async (contactId: number) => setAnalysisHistory(await request<AnalysisHistory[]>(`/contacts/${contactId}/analyses`))
  const refreshContacts = async () => {
    try {
      const items = await request<Contact[]>('/contacts')
      setContacts(items)
      setSelected((current) => items.some((contact) => contact.id === current) ? current : (items[0]?.id ?? null))
      if (!items.length) setStatus('请先在工作台新建一个联系人')
    } catch { setStatus('本地服务未连接；点击联系人列表可再次刷新') }
  }

  useEffect(() => { void refreshContacts() }, [])
  useEffect(() => {
    if (!selected) return
    setAnalysis(null); setAnalysisMinimized(false); setShowAnalysisHistory(false)
    loadMessages(selected).catch((error) => setStatus(error.message))
    loadAnalysisHistory(selected).catch((error) => setStatus(error.message))
  }, [selected])
  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<{ state: string; detail: string }>('wechat-monitor-status', (event) => { setStatus(event.payload.detail); setMonitoring(['probing', 'mapping', 'monitoring', 'paused', 'fallback_ocr'].includes(event.payload.state)) }).then((stop) => { unlisten = stop }).catch(() => undefined)
    return () => unlisten?.()
  }, [])

  const readClipboard = async () => {
    try { const content = await navigator.clipboard.readText(); if (!content.trim()) return setStatus('剪贴板中没有可用文字'); setDraft(content); setStatus('已读取剪贴板；可保存或转入发送预览') } catch { setStatus('无法读取剪贴板，请直接输入') }
  }
  const saveDraft = async () => {
    if (!selected) return setStatus('请先选择联系人')
    if (!draft.trim()) return setStatus('先输入一条消息')
    try { setBusy(true); await request<Message>('/messages', { method: 'POST', body: JSON.stringify({ contact_id: selected, content: draft, role, source: '悬浮助手（用户输入）' }) }); setDraft(''); await loadMessages(selected); setStatus('消息已保存到本地会话') } catch (error) { setStatus(error instanceof Error ? error.message : '无法保存消息') } finally { setBusy(false) }
  }
  const requestModelAdvice = async () => {
    if (!selected) return setStatus('请先选择联系人')
    if (!draft.trim()) return setStatus('先输入或读取一条消息')
    try {
      setBusy(true)
      setStatus('正在请求模型建议…')
      await request<Message>('/messages', { method: 'POST', body: JSON.stringify({ contact_id: selected, content: draft, role, source: '悬浮助手（用户输入）' }) })
      const result = await request<Analysis>('/analyze', {
        method: 'POST',
        body: JSON.stringify({ contact_id: selected, content: draft, current_role: role, message_ids: messages.slice(-4).map((message) => message.id) }),
      })
      setAnalysis(result)
      setAnalysisMinimized(false)
      setShowAnalysisHistory(false)
      setDraft('')
      await loadMessages(selected)
      await loadAnalysisHistory(selected)
      setStatus('模型建议已生成；由你决定是否采用和发送')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '模型请求失败')
    } finally { setBusy(false) }
  }
  const collapse = async () => { await invoke('collapse_assistant'); setCollapsed(true) }
  const expand = async () => { await invoke('expand_assistant'); setCollapsed(false) }
  const toggleWechatMonitor = async () => {
    if (monitoring) { await invoke('stop_wechat_monitor'); setMonitoring(false); setStatus('微信前台监听已停止'); return }
    await invoke('show_wechat_consent'); setShowWechatConsent(true)
  }
  const dismissWechatConsent = async () => { await invoke('expand_assistant'); setShowWechatConsent(false) }
  const startWechatMonitor = async () => { await dismissWechatConsent(); setStatus('正在等待已授权的微信聊天窗口…'); await invoke('start_wechat_monitor'); setMonitoring(true) }
  const startDragging = (event: ReactMouseEvent<HTMLElement>) => { if (event.button !== 0) return; event.preventDefault(); getCurrentWindow().startDragging().catch(() => setStatus('当前环境不支持移动悬浮助手')) }
  const showHistory = async () => {
    if (!selected) return setStatus('请先选择联系人')
    try { await loadAnalysisHistory(selected); setShowAnalysisHistory(true); setAnalysisMinimized(true) } catch (error) { setStatus(error instanceof Error ? error.message : '无法读取本地历史建议') }
  }
  const toggleAdvicePanel = () => {
    if (analysis && analysisMinimized) { setAnalysisMinimized(false); setShowAnalysisHistory(false); return }
    void showHistory()
  }

  if (collapsed) return <div className="assistant-orb" title="拖动外圈移动；点击 e 展开 EchoMate 快捷助手" onMouseDown={startDragging}><button className="assistant-orb-expand" title="展开 EchoMate 快捷助手" onMouseDown={(event) => event.stopPropagation()} onClick={expand}>e</button></div>
  if (showWechatConsent) return <main className="overlay-shell overlay-consent"><div className="overlay-consent-copy"><strong>授权前台微信监听</strong><span>仅本次会话读取当前前台、且你有权处理的微信可访问文本；切换窗口即暂停。不读微信数据库，不自动发送给模型。</span></div><div className="overlay-actions"><button className="overlay-secondary" onClick={dismissWechatConsent}>取消</button><button onClick={startWechatMonitor}>同意并开始</button></div></main>

  const active = contacts.find((contact) => contact.id === selected)
  return <main className="overlay-shell overlay-workbench">
    <header className="overlay-workbench-head" onMouseDown={startDragging} title="拖动此处移动悬浮助手"><div className="overlay-dot">e</div><div className="overlay-copy"><strong>{active?.name || 'EchoMate 快捷助手'}</strong><span>{active?.relationship || '本地对话工作台'}</span></div><button className="overlay-close" onMouseDown={(event) => event.stopPropagation()} onClick={collapse}>收起</button></header>
    <div className="overlay-control-row"><select aria-label="选择联系人（点击时刷新）" value={selected ?? ''} onMouseDown={() => void refreshContacts()} onChange={(event) => setSelected(Number(event.target.value))}><option value="" disabled>选择联系人</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select><button className="overlay-secondary overlay-refresh" title="刷新联系人列表" onClick={() => void refreshContacts()}>↻</button><button className={monitoring ? 'overlay-stop' : 'overlay-secondary'} onClick={toggleWechatMonitor}>{monitoring ? '停止监听' : '监听微信'}</button><button className="overlay-secondary" onClick={toggleAdvicePanel}>{analysis && analysisMinimized ? '展开建议' : '历史建议'}</button><button className="overlay-secondary" onClick={() => invoke('restore_workspace')}>工作台</button></div>
    <p className="overlay-status">{status}</p>
    <section className={`overlay-thread ${(analysis && !analysisMinimized) || showAnalysisHistory ? 'showing-answer' : ''}`} aria-label={showAnalysisHistory ? '历史模型建议' : (analysis && !analysisMinimized ? '本次模型建议' : '最近聊天消息')}>{showAnalysisHistory ? <article className="overlay-answer overlay-history"><div><span>历史模型建议（本地保存）</span><button className="overlay-close" onClick={() => setShowAnalysisHistory(false)}>−</button></div>{analysisHistory.length ? analysisHistory.map((item) => <button className="overlay-history-item" key={item.id} onClick={() => { setAnalysis({ answer: item.response, citations: [] }); setAnalysisMinimized(false); setShowAnalysisHistory(false) }}><small>{new Date(item.created_at).toLocaleString()}</small><b>{item.prompt}</b><span>{item.response}</span></button>) : <p>暂无本地历史建议。</p>}</article> : (analysis && !analysisMinimized ? <article className="overlay-answer" aria-live="polite"><div><span>本次模型建议</span><button className="overlay-close" title="最小化建议" onClick={() => setAnalysisMinimized(true)}>−</button></div><p>{analysis.answer}</p>{analysis.citations.length > 0 && <small>参考：{analysis.citations.map((item) => item.file_name).join('、')}</small>}</article> : (messages.length ? messages.slice(-4).map((message) => <article className={`overlay-message ${message.role}`} key={message.id}><small>{message.role === 'sent' ? '我' : '对方'}</small><p>{message.content}</p></article>) : <p className="overlay-empty">尚无本地消息。输入一条内容开始。</p>))}</section>
    <textarea className="overlay-composer" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={role === 'received' ? '粘贴对方刚发来的内容…' : '输入我准备发送的内容…'} />
    <footer className="overlay-footer"><div><select aria-label="消息角色" value={role} onChange={(event) => setRole(event.target.value as 'received' | 'sent')}><option value="received">对方说的</option><option value="sent">我发出的</option></select><button className="overlay-secondary" onClick={readClipboard}>读剪贴板</button></div><div><button className="overlay-secondary" disabled={busy} onClick={saveDraft}>仅保存</button><button disabled={busy} onClick={requestModelAdvice}>{busy ? '请求中…' : '请求模型建议'}</button></div></footer>
  </main>
}
