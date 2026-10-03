import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './App.css'

const API = 'http://127.0.0.1:8787'

type Contact = { id: number; name: string; relationship: string; notes: string }
type Message = { id: number; role: 'sent' | 'received'; content: string; source: string }
type Settings = { base_url: string; chat_model: string; embedding_model: string; api_key_configured: boolean; api_key_storage?: string | null }
type Analysis = { answer: string; citations: { file_name: string; excerpt: string }[]; sent_preview: { history_count: number; retrieval_count: number } }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API}${path}`, { headers: { ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options?.headers }, ...options })
  } catch {
    throw new Error('本地 AI 服务未启动。请关闭应用后用 “pnpm.cmd tauri dev” 重新启动。')
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || '本地服务暂时无法完成请求')
  }
  return response.json()
}

function Overlay() {
  return <main className="overlay-shell"><div className="overlay-dot">e</div><div><strong>EchoMate 快捷助手</strong><span>只在你点击后读取剪贴板</span></div><button onClick={() => invoke('toggle_assistant')}>收起</button></main>
}

function App() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [source, setSource] = useState('手动粘贴')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [newContact, setNewContact] = useState({ name: '', relationship: '', notes: '' })
  const [showSettings, setShowSettings] = useState(false)
  const [showContact, setShowContact] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [status, setStatus] = useState('正在连接本地服务…')
  const [busy, setBusy] = useState(false)

  const refreshContacts = async () => {
    const data = await request<Contact[]>('/contacts')
    setContacts(data)
    if (!selected && data[0]) setSelected(data[0].id)
  }

  const loadMessages = async (contactId: number) => setMessages(await request<Message[]>(`/contacts/${contactId}/messages`))

  useEffect(() => {
    const boot = async () => {
      try {
        const [loadedSettings] = await Promise.all([request<Settings>('/settings'), refreshContacts()])
        setSettings(loadedSettings)
        setStatus('本地资料库已就绪')
      } catch {
        setStatus('正在启动本地 AI 服务，请稍候…')
        window.setTimeout(boot, 1600)
      }
    }
    boot()
  }, [])

  useEffect(() => { if (selected) loadMessages(selected).catch((error) => setStatus(error.message)) }, [selected])

  const createContact = async (event: FormEvent) => {
    event.preventDefault()
    try {
      const contact = await request<Contact>('/contacts', { method: 'POST', body: JSON.stringify(newContact) })
      setContacts((items) => [contact, ...items])
      setSelected(contact.id)
      setNewContact({ name: '', relationship: '', notes: '' })
      setShowContact(false)
    } catch (error) { setStatus(error instanceof Error ? error.message : '无法创建联系人') }
  }

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault()
    if (!settings) return
    try {
      const saved = await request<Settings>('/settings', { method: 'PUT', body: JSON.stringify({ ...settings, api_key: apiKey }) })
      setSettings(saved); setApiKey(''); setShowSettings(false); setStatus('模型设置已保存在本机')
    } catch (error) { setStatus(error instanceof Error ? error.message : '无法保存设置') }
  }

  const importDocument = async (file?: File) => {
    if (!file) return
    const data = new FormData(); data.append('file', file)
    try {
      setBusy(true)
      const result = await request<{ file_name: string; chunks: number; duplicate: boolean }>('/documents/import', { method: 'POST', body: data })
      setStatus(result.duplicate ? '该资料已在本地知识库中' : `已将 ${result.file_name} 分为 ${result.chunks} 个本地检索片段`)
    } catch (error) { setStatus(error instanceof Error ? error.message : '导入失败') } finally { setBusy(false) }
  }

  const captureClipboard = async () => {
    try { setText(await navigator.clipboard.readText()); setSource('剪贴板（用户触发）') } catch { setStatus('无法读取剪贴板，请直接粘贴内容') }
  }

  const prepareAnalysis = () => {
    if (!selected) return setShowContact(true)
    if (!text.trim()) return setStatus('先粘贴或输入一段需要回应的内容')
    if (!settings?.api_key_configured) return setShowSettings(true)
    setShowConfirm(true)
  }

  const runAnalysis = async () => {
    if (!selected) return
    try {
      setBusy(true); setShowConfirm(false); setStatus('正在请求模型…')
      await request('/messages', { method: 'POST', body: JSON.stringify({ contact_id: selected, content: text, role: 'received', source }) })
      const result = await request<Analysis>('/analyze', { method: 'POST', body: JSON.stringify({ contact_id: selected, content: text }) })
      setAnalysis(result); await loadMessages(selected); setStatus('分析完成；草案仍需由你确认和发送')
    } catch (error) { setStatus(error instanceof Error ? error.message : '分析失败') } finally { setBusy(false) }
  }

  if (window.location.hash === '#overlay') return <Overlay />
  const active = contacts.find((contact) => contact.id === selected)
  return <main className="app-shell">
    <aside className="sidebar"><div className="brand-mark">e</div><nav><button className="nav-item active" title="对话工作台">◇</button><button className="nav-item" onClick={() => setShowContact(true)} title="新建联系人">◎</button><label className="nav-item file-nav" title="导入知识库">▤<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => importDocument(event.target.files?.[0])} /></label></nav><button className="nav-item settings" onClick={() => setShowSettings(true)} title="模型设置">⚙</button></aside>
    <section className="workspace">
      <header className="topbar"><div><p className="eyebrow">本地对话工作台</p><h1>先理解，再开口。</h1></div><div className="top-actions"><button className="overlay-button" onClick={() => invoke('toggle_assistant').catch(() => setStatus('悬浮窗仅在 Windows 桌面应用中可用'))}>◉ 呼出悬浮助手</button><span className="privacy-state"><i></i>{status}</span></div></header>
      <div className="content-grid">
        <section className="conversation-card">
          <div className="contact-row"><div className="avatar">{active?.name?.[0] || '+'}</div><div><strong>{active?.name || '选择一个联系人'}</strong><p>{active ? `${active.relationship || '未填写关系'} · 资料仅保存在本机` : '先创建联系人，分别管理聊天资料'}</p></div><button className="quiet-button" onClick={() => setShowContact(true)}>新建对象</button></div>
          <div className="contact-tabs">{contacts.map((contact) => <button className={contact.id === selected ? 'chosen' : ''} onClick={() => setSelected(contact.id)} key={contact.id}>{contact.name}</button>)}</div>
          <div className="thread">{messages.length ? messages.map((message) => <div className={`message ${message.role}`} key={message.id}>{message.content}<small>{message.source}</small></div>) : <div className="empty-thread">主动粘贴你有权处理的聊天片段，或从微信/QQ 导出的文本文件导入。应用不会读取它们的私有数据库。</div>}</div>
          <label className="composer-label" htmlFor="message">需要回应的内容</label><textarea id="message" value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴对方刚发来的内容…" />
          <div className="composer-footer"><div><select value={source} onChange={(event) => setSource(event.target.value)}><option>手动粘贴</option><option>微信导出文本</option><option>QQ 导出文本</option><option>剪贴板（用户触发）</option></select><button className="clipboard" onClick={captureClipboard}>读取剪贴板</button></div><button className="analyze-button" onClick={prepareAnalysis} disabled={busy}>{busy ? '处理中…' : '查看发送预览 ↗'}</button></div>
        </section>
        <aside className="insight-panel"><div className="panel-heading"><div><p className="eyebrow">本地分析</p><h2>{analysis ? '沟通线索与草案' : '先由你决定要发送什么'}</h2></div><span className="confidence">非心理诊断</span></div>{analysis ? <><article className="answer">{analysis.answer}</article><div className="references"><h3>检索到的本地参考资料</h3>{analysis.citations.length ? analysis.citations.map((citation, index) => <p key={index}><b>{citation.file_name}</b>{citation.excerpt}</p>) : <p>本次没有使用知识库片段。</p>}</div></> : <><p className="insight-copy">建立联系人后，导入聊天指南或自己的参考资料。系统会在本机分块、向量化并检索；只有你确认时才发送必要上下文给模型。</p><ol className="workflow"><li>导入聊天指南 / TXT / PDF / DOCX</li><li>粘贴当前消息并选择联系人</li><li>检查发送预览，再请求建议</li></ol></>}<div className="data-note">不会自动读取微信、QQ 窗口，不会代替你发送消息。</div></aside>
      </div>
    </section>
    {showSettings && settings && <div className="modal-backdrop"><form className="modal" onSubmit={saveSettings}><button type="button" className="close" onClick={() => setShowSettings(false)}>×</button><p className="eyebrow">模型设置</p><h2>连接你自己的模型</h2><label>Base URL<input value={settings.base_url} onChange={(event) => setSettings({ ...settings, base_url: event.target.value })} /></label><label>聊天模型<input value={settings.chat_model} onChange={(event) => setSettings({ ...settings, chat_model: event.target.value })} /></label><label>本地嵌入模型<input value={settings.embedding_model} onChange={(event) => setSettings({ ...settings, embedding_model: event.target.value })} /></label><label>API Key <small>{settings.api_key_configured ? `已保存到${settings.api_key_storage}；留空则保持不变` : '不会写入本地数据库'}</small><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" /></label><button className="analyze-button" type="submit">保存本地设置</button></form></div>}
    {showContact && <div className="modal-backdrop"><form className="modal" onSubmit={createContact}><button type="button" className="close" onClick={() => setShowContact(false)}>×</button><p className="eyebrow">联系人档案</p><h2>建立独立的对话空间</h2><label>名称<input required value={newContact.name} onChange={(event) => setNewContact({ ...newContact, name: event.target.value })} /></label><label>关系<input value={newContact.relationship} placeholder="朋友、同事、家人…" onChange={(event) => setNewContact({ ...newContact, relationship: event.target.value })} /></label><label>补充背景<textarea value={newContact.notes} onChange={(event) => setNewContact({ ...newContact, notes: event.target.value })} placeholder="仅填写你希望在分析时考虑的背景" /></label><button className="analyze-button" type="submit">创建联系人</button></form></div>}
    {showConfirm && <div className="modal-backdrop"><section className="modal confirm"><p className="eyebrow">发送预览</p><h2>确认才会调用远端模型</h2><p>将发送：当前输入、{messages.length} 条该联系人的近期本地记录，以及最多 4 个检索到的参考片段。</p><blockquote>{text}</blockquote><div className="confirm-actions"><button className="quiet-button" onClick={() => setShowConfirm(false)}>返回编辑</button><button className="analyze-button" onClick={runAnalysis}>确认并请求建议</button></div></section></div>}
  </main>
}

export default App
