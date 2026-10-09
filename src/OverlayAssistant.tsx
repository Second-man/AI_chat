import { useEffect, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './overlay.css'
import { WebSearchOptions, WebSources } from './WebSearch'
import type { WebSearchResult, WebSource } from './WebSearch'

const API = 'http://127.0.0.1:8787'
type Contact = { id: number; name: string; relationship: string }
type Message = { id: number; role: 'sent' | 'received'; content: string; source: string }
type Analysis = { answer: string; citations: { file_name: string; excerpt: string; similarity?: number }[]; retrieval_message?: string; web_sources?: WebSource[]; web_retrieved_at?: string | null }
type AnalysisHistory = Analysis & { id: number; prompt: string; response: string; created_at: string }

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
  const [wechatTitle, setWechatTitle] = useState<string | null>(null)
  const [mappingRequired, setMappingRequired] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [selectedMessageIds, setSelectedMessageIds] = useState<number[]>([])
  const [draft, setDraft] = useState('')
  const [role, setRole] = useState<'received' | 'sent'>('received')
  const [busy, setBusy] = useState(false)
  const [webEnabled, setWebEnabled] = useState(false)
  const [webQuery, setWebQuery] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [searchResult, setSearchResult] = useState<WebSearchResult | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [analysisMinimized, setAnalysisMinimized] = useState(false)
  const [showAnalysisHistory, setShowAnalysisHistory] = useState(false)
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisHistory[]>([])
  const loadMessages = async (contactId: number, resetSelection = false, selectNewMessageId?: number) => {
    const items = await request<Message[]>(`/contacts/${contactId}/messages`)
    setMessages(items)
    setSelectedMessageIds((current) => {
      if (resetSelection) return items.map((message) => message.id)
      const retained = current.filter((id) => items.some((message) => message.id === id))
      if (selectNewMessageId !== undefined && items.some((message) => message.id === selectNewMessageId) && !retained.includes(selectNewMessageId)) retained.push(selectNewMessageId)
      return retained
    })
  }
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
    loadMessages(selected, true).catch((error) => setStatus(error.message))
    loadAnalysisHistory(selected).catch((error) => setStatus(error.message))
  }, [selected])
  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<{ state: string; detail: string; chatTitle?: string }>('wechat-monitor-status', (event) => {
      setStatus(event.payload.detail)
      setMonitoring(!['stopped', 'unsupported'].includes(event.payload.state))
      if (event.payload.state === 'mapping' && event.payload.chatTitle) {
        setWechatTitle(event.payload.chatTitle); setMappingRequired(true)
      }
    }).then((stop) => { unlisten = stop }).catch(() => undefined)
    return () => unlisten?.()
  }, [])
  useEffect(() => {
    let stop: (() => void) | undefined
    listen<{ contactId: number; messageId: number }>('wechat-message-saved', (event) => {
      if (selected === event.payload.contactId) void loadMessages(selected, false, event.payload.messageId).catch((error) => setStatus(error.message))
    }).then((unlisten) => { stop = unlisten }).catch(() => undefined)
    return () => stop?.()
  }, [selected])
  useEffect(() => {
    let stop: (() => void) | undefined
    listen<{ chatTitle: string }>('wechat-mapping-confirmed', (event) => {
      if (event.payload.chatTitle === wechatTitle) setMappingRequired(false)
    }).then((unlisten) => { stop = unlisten }).catch(() => undefined)
    return () => stop?.()
  }, [wechatTitle])
  const confirmWechatContact = async () => {
    if (!selected || !wechatTitle) return
    try {
      await request('/wechat/mappings', { method: 'PUT', body: JSON.stringify({ chat_title: wechatTitle, contact_id: selected }) })
      await emit('wechat-mapping-confirmed', { chatTitle: wechatTitle, contactId: selected })
      setMappingRequired(false); setStatus(`已关联“${wechatTitle}”，新消息会保存到当前联系人`)
    } catch (error) { setStatus(error instanceof Error ? error.message : '关联失败') }
  }

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
      setPreviewError('')
      let web = searchResult
      if (webEnabled && !web) {
        web = await request<WebSearchResult>('/web-search', { method: 'POST', body: JSON.stringify({ query: webQuery.trim() }) })
        setSearchResult(web)
      }
      setStatus('正在请求模型建议…')
      await request<Message>('/messages', { method: 'POST', body: JSON.stringify({ contact_id: selected, content: draft, role, source: '悬浮助手（用户输入）' }) })
      const result = await request<Analysis>('/analyze', {
        method: 'POST',
        body: JSON.stringify({
          contact_id: selected,
          content: draft,
          current_role: role,
          message_ids: messages.filter((message) => selectedMessageIds.includes(message.id)).map((message) => message.id),
          web_search_id: webEnabled ? web?.search_id : undefined,
        }),
      })
      setAnalysis(result)
      setAnalysisMinimized(false)
      setShowAnalysisHistory(false)
      setDraft('')
      setShowPreview(false); setWebEnabled(false); setWebQuery(''); setSearchResult(null)
      await loadMessages(selected)
      await loadAnalysisHistory(selected)
      setStatus('模型建议已生成；由你决定是否采用和发送')
    } catch (error) {
      const detail = error instanceof Error ? error.message : '模型请求失败'
      setStatus(detail); setPreviewError(detail); setSearchResult(null)
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
  const toggleMessageContext = (messageId: number) => setSelectedMessageIds((ids) => ids.includes(messageId) ? ids.filter((id) => id !== messageId) : [...ids, messageId])

  if (collapsed) return <div className="assistant-orb" title="拖动外圈移动；点击 e 展开 EchoMate 快捷助手" onMouseDown={startDragging}><button className="assistant-orb-expand" title="展开 EchoMate 快捷助手" onMouseDown={(event) => event.stopPropagation()} onClick={expand}>e</button></div>
  if (showPreview) return <main className="overlay-shell overlay-preview"><h3>发送预览</h3><p>模型：当前消息、以下勾选历史、双方档案、目标、RAG 摘录及搜索摘要。</p><blockquote>{draft}{'\n'}{messages.filter((item) => selectedMessageIds.includes(item.id)).map((item) => `${item.role === 'sent' ? '我' : '对方'}：${item.content}`).join('\n')}</blockquote><p>Tavily：{webEnabled ? webQuery : '不联网，不发送搜索请求'}</p>{previewError && <p role="alert">{previewError}</p>}<div className="overlay-actions"><button disabled={busy} onClick={() => { setShowPreview(false); setWebEnabled(false); setWebQuery(''); setSearchResult(null) }}>取消</button>{webEnabled && <button disabled={busy} onClick={() => { setWebEnabled(false); setSearchResult(null); setPreviewError('') }}>关闭联网</button>}<button disabled={busy} onClick={requestModelAdvice}>{busy ? '处理中…' : '确认 / 重试'}</button></div></main>
  if (showWechatConsent) return <main className="overlay-shell overlay-consent"><div className="overlay-consent-copy"><strong>授权前台微信监听</strong><span>仅本次会话读取你有权处理的前台微信聊天；必要时使用本地窗口截图 OCR，截图不落盘、不上传。切到其他应用暂停，使用悬浮助手不中断。不读数据库，不自动发送给模型。</span></div><div className="overlay-actions"><button className="overlay-secondary" onClick={dismissWechatConsent}>取消</button><button onClick={startWechatMonitor}>同意并开始</button></div></main>

  const active = contacts.find((contact) => contact.id === selected)
  const renderMessage = (message: Message) => {
    const isSelected = selectedMessageIds.includes(message.id)
    return <article className={`overlay-message ${message.role} ${isSelected ? 'context-selected' : ''}`} key={message.id}>
      <label className="overlay-context-check"><input type="checkbox" checked={isSelected} onChange={() => toggleMessageContext(message.id)} /> 本次分析</label>
      <small>{message.role === 'sent' ? '我' : '对方'}</small><p>{message.content}</p>
    </article>
  }
  return <main className="overlay-shell overlay-workbench">
    <header className="overlay-workbench-head" onMouseDown={startDragging} title="拖动此处移动悬浮助手"><div className="overlay-dot">e</div><div className="overlay-copy"><strong>{active?.name || 'EchoMate 快捷助手'}</strong><span>{active?.relationship || '本地对话工作台'}</span></div><button className="overlay-close" onMouseDown={(event) => event.stopPropagation()} onClick={collapse}>收起</button></header>
    <div className="overlay-control-row"><select aria-label="选择联系人（点击时刷新）" value={selected ?? ''} onMouseDown={() => void refreshContacts()} onChange={(event) => setSelected(Number(event.target.value))}><option value="" disabled>选择联系人</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select><button className="overlay-secondary overlay-refresh" title="刷新联系人列表" onClick={() => void refreshContacts()}>↻</button><button className={monitoring ? 'overlay-stop' : 'overlay-secondary'} onClick={toggleWechatMonitor}>{monitoring ? '停止监听' : '监听微信'}</button><button className="overlay-secondary" onClick={toggleAdvicePanel}>{analysis && analysisMinimized ? '展开建议' : '历史建议'}</button><button className="overlay-secondary" onClick={() => invoke('restore_workspace')}>工作台</button></div>
    <div className="overlay-status" title={status}><span>{status}</span>{mappingRequired && wechatTitle && <button className="overlay-secondary" disabled={!selected} onClick={confirmWechatContact}>将“{wechatTitle}”关联到当前联系人</button>}</div>
    <section className={`overlay-thread ${(analysis && !analysisMinimized) || showAnalysisHistory ? 'showing-answer' : ''}`} aria-label={showAnalysisHistory ? '历史模型建议' : (analysis && !analysisMinimized ? '本次模型建议' : '全部聊天消息')}>
      {showAnalysisHistory ? <article className="overlay-answer overlay-history"><div><span>历史模型建议（本地保存）</span><button className="overlay-close" onClick={() => setShowAnalysisHistory(false)}>−</button></div>{analysisHistory.length ? analysisHistory.map((item) => <button className="overlay-history-item" key={item.id} onClick={() => { setAnalysis({ answer: item.response, citations: item.citations || [], web_sources: item.web_sources, web_retrieved_at: item.web_retrieved_at }); setAnalysisMinimized(false); setShowAnalysisHistory(false) }}><small>{new Date(item.created_at).toLocaleString()}</small><b>{item.prompt}</b><span>{item.response}</span></button>) : <p>暂无本地历史建议。</p>}</article> : (analysis && !analysisMinimized ? <article className="overlay-answer" aria-live="polite"><div><span>本次模型建议</span><button className="overlay-close" title="最小化建议" onClick={() => setAnalysisMinimized(true)}>−</button></div><p>{analysis.answer}</p>{analysis.citations.length > 0 && <small>参考：{analysis.citations.map((item) => `${item.file_name}${item.similarity !== undefined ? `（相似度 ${item.similarity.toFixed(3)}）` : ''}`).join('、')}</small>}{!analysis.citations.length && analysis.retrieval_message && <small>{analysis.retrieval_message}</small>}<WebSources sources={analysis.web_sources} retrievedAt={analysis.web_retrieved_at} /></article> : (messages.length ? messages.map(renderMessage) : <p className="overlay-empty">尚无本地消息。输入一条内容开始。</p>))}
    </section>
    <div className="overlay-input-area"><WebSearchOptions enabled={webEnabled} query={webQuery} onEnabled={(value) => { setWebEnabled(value); setSearchResult(null) }} onQuery={(value) => { setWebQuery(value); setSearchResult(null) }} /><textarea className="overlay-composer" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={role === 'received' ? '粘贴对方刚发来的内容…' : '输入我准备发送的内容…'} /></div>
    <footer className="overlay-footer"><div><select aria-label="消息角色" value={role} onChange={(event) => setRole(event.target.value as 'received' | 'sent')}><option value="received">对方说的</option><option value="sent">我发出的</option></select><button className="overlay-secondary" onClick={readClipboard}>读剪贴板</button></div><div><button className="overlay-secondary" disabled={busy} onClick={saveDraft}>仅保存</button><button disabled={busy} onClick={() => { if (!selected || !draft.trim()) return setStatus('先选择联系人并输入当前消息'); if (webEnabled && !webQuery.trim()) return setStatus('请填写搜索关键词'); setPreviewError(''); setSearchResult(null); setShowPreview(true) }}>查看发送预览</button></div></footer>
  </main>
}
