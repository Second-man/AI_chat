import { useState } from 'react'
import './App.css'

type DraftTone = '自然' | '温和' | '简洁'

const suggestions: Record<DraftTone, string> = {
  自然: '听起来你这两天真的挺忙的。别急着回复，等你缓过来我们再好好聊。',
  温和: '感觉你最近承担了不少事情。先照顾好自己的节奏，等你方便时我们再慢慢聊。',
  简洁: '最近辛苦了，先忙你的。等你有空我们再聊。',
}

function App() {
  const [tone, setTone] = useState<DraftTone>('自然')
  const [message, setMessage] = useState('我最近事情有点多，可能回得慢一点。')
  const [copied, setCopied] = useState(false)

  const copyDraft = async () => {
    await navigator.clipboard.writeText(suggestions[tone])
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand-mark" aria-label="EchoMate">e</div>
        <nav>
          <button className="nav-item active" aria-label="对话工作台">◇</button>
          <button className="nav-item" aria-label="联系人">◎</button>
          <button className="nav-item" aria-label="知识库">▤</button>
        </nav>
        <button className="nav-item settings" aria-label="设置">⚙</button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">对话工作台</p>
            <h1>给关系留一点回声</h1>
          </div>
          <div className="privacy-state"><span></span> 本次内容尚未发送</div>
        </header>

        <div className="content-grid">
          <section className="conversation-card">
            <div className="contact-row">
              <div className="avatar">林</div>
              <div><strong>林知夏</strong><p>朋友 · 最近 7 天有 12 条记录</p></div>
              <button className="quiet-button">切换对象</button>
            </div>

            <div className="thread">
              <div className="message received">最近怎么样？感觉你好像很忙。</div>
              <div className="message sent">有一点，不过还好。你呢？</div>
              <div className="message received">我最近事情有点多，可能回得慢一点。</div>
            </div>

            <label className="composer-label" htmlFor="message">粘贴想回应的内容</label>
            <textarea id="message" value={message} onChange={(event) => setMessage(event.target.value)} />
            <div className="composer-footer">
              <span>仅保存到这台设备</span>
              <button className="analyze-button">生成建议 <b>↗</b></button>
            </div>
          </section>

          <aside className="insight-panel">
            <div className="panel-heading"><div><p className="eyebrow">沟通线索</p><h2>别急着填满沉默</h2></div><span className="confidence">低置信度</span></div>
            <p className="insight-copy">这句话更像是在提前说明节奏，而不是疏远。保留余地、先表达理解，可能比追问原因更合适。</p>

            <div className="signal"><div className="signal-label"><span>回应压力</span><b>偏低</b></div><div className="meter"><i className="dot calm"></i></div></div>
            <div className="signal"><div className="signal-label"><span>需要空间</span><b>可能较高</b></div><div className="meter"><i className="dot spacious"></i></div></div>
            <p className="evidence">依据：对方主动说明“回得慢”，但没有减少互动意愿。仅基于当前片段推测。</p>

            <div className="draft-block">
              <div className="draft-head"><h3>可以这样说</h3><div className="tone-tabs">{(Object.keys(suggestions) as DraftTone[]).map((item) => <button key={item} onClick={() => setTone(item)} className={tone === item ? 'selected' : ''}>{item}</button>)}</div></div>
              <p className="draft-text">{suggestions[tone]}</p>
              <button className="copy-button" onClick={copyDraft}>{copied ? '已复制' : '复制草案'} <span>⌘C</span></button>
            </div>
          </aside>
        </div>
      </section>
    </main>
  )
}

export default App
