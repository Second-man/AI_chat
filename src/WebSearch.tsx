export type WebSource = { id: string; title: string; url: string; excerpt: string; published_at?: string | null }
export type WebSearchResult = { search_id: string; retrieved_at: string; sources: WebSource[] }

export function WebSearchOptions({ enabled, query, onEnabled, onQuery }: {
  enabled: boolean; query: string; onEnabled: (value: boolean) => void; onQuery: (value: string) => void
}) {
  return <div className="web-search-options"><label><input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} /> 本次联网检索</label>{enabled && <><input aria-label="确认搜索关键词" maxLength={500} value={query} onChange={(event) => onQuery(event.target.value)} placeholder="自行填写搜索关键词，不会自动复制聊天" /><small>仅关键词发给 Tavily，可能产生费用。请去掉姓名、联系方式等敏感信息。</small></>}</div>
}

export function WebSources({ sources = [], retrievedAt }: { sources?: WebSource[]; retrievedAt?: string | null }) {
  if (!sources.length) return null
  return <section className="web-sources"><h3>联网引用来源</h3>{retrievedAt && <small>检索时间：{new Date(retrievedAt).toLocaleString()}</small>}{sources.map((source) => <p key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer">[{source.id}] {source.title}</a><small>发布时间：{source.published_at || '来源未提供'}</small><span>{source.excerpt}</span></p>)}</section>
}
