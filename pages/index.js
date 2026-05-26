import { useState, useRef, useEffect } from 'react'
import { createPagesServerClient } from '@supabase/auth-helpers-nextjs'
import Head from 'next/head'

const EXAMPLE_GROUPS = [
  {
    label: 'Getting started',
    prompts: [
      'Show me how the RV is calculated for 225 Monton Road',
      'What properties are at postcode M30 9LF?',
      'Show the full valuation breakdown for assessment reference 30773892000',
      'Find all retail shops on Deansgate, Manchester',
    ],
  },
  {
    label: 'Peer comparison',
    prompts: [
      'Is 225 Monton Road\'s RV in line with peers on Monton Road?',
      'Compare the unadjusted price per sqm for CS shops in M30',
      'Which properties on Monton Road have the highest RV per sqm?',
      'Compare Zone A rates across retail shops in Oldham town centre',
    ],
  },
  {
    label: 'Investigation',
    prompts: [
      'Find retail shops in M30 where RV per sqm is above the street median',
      'List the 20 highest RV retail properties in Stockport',
      'Which offices in M1 have a rateable value above £100,000?',
      'Find warehouse properties in BL1 with rateable value above £50,000',
      'What is the median RV for offices in Salford M5?',
      'How many CS retail shops are there in each M postcode area?',
    ],
  },
  {
    label: 'Scheme analysis',
    prompts: [
      'What scheme reference is used for 225 Monton Road?',
      'List all CS assessments on the same scheme as 225 Monton Road',
      'Find properties in WN1 where adopted RV differs from the calculated value',
    ],
  },
]

const ICONS = {
  recent: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <polyline points="12 7 12 12 15 15"/>
    </svg>
  ),
  examples: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/>
      <circle cx="4" cy="6" r="1.2" fill="currentColor" stroke="none"/>
      <circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"/>
      <circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none"/>
    </svg>
  ),
  schema: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <ellipse cx="12" cy="5" rx="9" ry="3"/>
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
    </svg>
  ),
  tips: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <circle cx="12" cy="8" r="0.5" fill="currentColor" stroke="none"/>
    </svg>
  ),
}

const PANEL_TITLES = {
  recent: 'Recent queries',
  examples: 'Example queries',
  schema: 'Schema',
  tips: 'How to use',
}

// ── Panel content ────────────────────────────────────────────────────────────

function RecentPanel({ queries, onSelect }) {
  if (queries.length === 0) return (
    <p className="panel-empty">Your successful queries will appear here as you run them.</p>
  )
  return queries.map(p => (
    <button key={p} className="panel-prompt" onClick={() => onSelect(p)}>{p}</button>
  ))
}

function ExamplesPanel({ onSelect }) {
  return EXAMPLE_GROUPS.map(group => (
    <div key={group.label} className="panel-group">
      <div className="panel-group-label">{group.label}</div>
      {group.prompts.map(p => (
        <button key={p} className="panel-prompt" onClick={() => onSelect(p)}>{p}</button>
      ))}
    </div>
  ))
}

function SchemaPanel() {
  const tables = [
    {
      name: 'list_entries',
      note: 'One row per hereditament',
      cols: ['assessment_reference (PK)', 'uarn', 'number_or_name', 'street', 'town', 'postcode', 'postcode_area', 'primary_description_code', 'primary_description_text', 'rateable_value', 'firm_name'],
    },
    {
      name: 'smv_assessments',
      note: 'One per assessment — join on assessment_reference',
      cols: ['assessment_reference (PK)', 'scheme_reference', 'scat_code', 'total_area_or_units', 'unit_of_measurement', 'adopted_rv', 'unadjusted_price'],
    },
    {
      name: 'smv_line_items',
      note: 'One per floor zone — join on assessment_reference',
      cols: ['assessment_reference', 'line_number', 'floor_description', 'description', 'area', 'price', 'value'],
    },
  ]
  return (
    <div className="schema-panel">
      {tables.map(t => (
        <div key={t.name} className="schema-table">
          <div className="schema-table-name">{t.name}</div>
          <div className="schema-table-note">{t.note}</div>
          {t.cols.map(c => <div key={c} className="schema-col">{c}</div>)}
        </div>
      ))}
      <div className="schema-notes">
        <div className="schema-notes-head">Notes</div>
        <p>Use UPPER() for address matching. primary_description_code prefix: CS=shops, CO=offices, CW=warehouses, IF=industrial. unadjusted_price is Zone A equivalent £/m² for shops. ROUND() requires ::numeric cast.</p>
      </div>
    </div>
  )
}

function TipsPanel() {
  const tips = [
    { head: 'Always name the property', body: 'Each query starts fresh — the model has no memory of earlier results. Say "225 Monton Road" or "assessment reference 28114711000", not "that property".' },
    { head: 'Include a postcode for precision', body: 'VOA street names differ from common use. "225 Monton Road M30 9PS" finds the right record even if the parade name differs.' },
    { head: 'Use the assessment reference for exact matches', body: 'If you know the assessment reference, use it — "for assessment reference 30773892000" bypasses all address matching.' },
    { head: 'Follow up without re-querying', body: 'After a result arrives, use the "Ask a follow-up" input below it to discuss the findings in plain English — no need to run a new query.' },
    { head: 'Expand Generated SQL', body: 'Every result shows the SQL that produced it. Expand it to verify the logic before using findings in advice.' },
    { head: 'Results are evidence, not conclusions', body: 'Anomalies are leads for surveyor review, not appeal recommendations. Verify against market evidence before advising a client.' },
  ]
  return (
    <div className="tips-panel">
      {tips.map(t => (
        <div key={t.head} className="tip">
          <div className="tip-head">{t.head}</div>
          <p className="tip-body">{t.body}</p>
        </div>
      ))}
    </div>
  )
}

// ── Shared components ────────────────────────────────────────────────────────

function formatValue(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) > 100) return v.toLocaleString()
    if (!Number.isInteger(v)) return v.toFixed(2)
    return String(v)
  }
  return String(v)
}

function isNumeric(v) { return typeof v === 'number' }

function ResultTable({ rows }) {
  if (!rows || rows.length === 0) return <p style={{ color: 'var(--ink-faint)', fontSize: 14 }}>No rows returned.</p>
  const cols = Object.keys(rows[0])
  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>{cols.map(c => <th key={c} className={isNumeric(rows[0][c]) ? 'num' : ''}>{c.replace(/_/g, ' ')}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>{cols.map(c => <td key={c} className={isNumeric(row[c]) ? 'num' : ''}>{formatValue(row[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FollowUpThread({ item }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  async function send() {
    const text = input.trim()
    if (!text || loading) return
    const next = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setLoading(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { question: item.question, rows: item.rows, explanation: item.explanation }, messages: next }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Something went wrong.' }])
    }
    setLoading(false)
  }

  if (!item.rows?.length && !item.explanation) return null

  return (
    <div className="followup">
      {messages.map((m, i) => (
        <div key={i} className={`followup-msg followup-${m.role}`}>{m.content}</div>
      ))}
      {loading && <div className="followup-msg followup-assistant followup-loading">Thinking…</div>}
      <div className="followup-row">
        <input className="followup-input" placeholder="Ask a follow-up about this result…" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send() }} />
        <button className="followup-send" onClick={send} disabled={loading || !input.trim()}>Ask</button>
      </div>
    </div>
  )
}

function Exchange({ item }) {
  const [thumbs, setThumbs] = useState(null)
  const [comment, setComment] = useState('')
  const [submitted, setSubmitted] = useState(false)

  async function submitFeedback(up) {
    setThumbs(up)
    await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queryLogId: item.queryLogId, thumbsUp: up, comment }) })
    setSubmitted(true)
  }

  const ts = new Date(item.timestamp)
  const timeStr = ts.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="exchange">
      <p className="question">{item.question}</p>
      <div className="question-meta">{item.elapsed ? `${item.elapsed}s · ${timeStr}` : `Running · ${timeStr}`}</div>

      {item.error && <div className="error-block">{item.error}</div>}

      {item.explanation && (
        <div className="finding">
          <div className="finding-label">Headline finding</div>
          <p className="finding-text" dangerouslySetInnerHTML={{ __html: item.explanation.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') }} />
          {item.signals && item.signals.length > 0 && (
            <div className="evidence-strip">
              {item.signals.map((s, i) => <span key={i} className="evidence-chip">{s}</span>)}
            </div>
          )}
          <div className="finding-meta">
            <span className="signal">Worth reviewing</span>
            {!submitted && (
              <div className="feedback-row">
                <button className={`feedback-btn${thumbs === true ? ' active' : ''}`} onClick={() => submitFeedback(true)}>↑</button>
                <button className={`feedback-btn${thumbs === false ? ' active' : ''}`} onClick={() => submitFeedback(false)}>↓</button>
                <input className="feedback-comment" placeholder="What would have made this useful?" value={comment} onChange={e => setComment(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submitFeedback(thumbs) }} />
              </div>
            )}
            {submitted && <span style={{ color: 'var(--ink-faint)', fontSize: 13 }}>Thanks.</span>}
          </div>
        </div>
      )}

      {item.rows && item.rows.length > 0 && (
        <div className="results">
          <div className="results-label">Results · {item.rows.length} row{item.rows.length !== 1 ? 's' : ''}</div>
          <ResultTable rows={item.rows} />
        </div>
      )}

      {item.sql && (
        <details className="sql">
          <summary>Generated SQL</summary>
          <pre>{item.sql}</pre>
        </details>
      )}

      <FollowUpThread item={item} />
    </div>
  )
}

// ── Recent queries hook ──────────────────────────────────────────────────────

function useRecentQueries() {
  const [recent, setRecent] = useState([])
  useEffect(() => {
    try { setRecent(JSON.parse(localStorage.getItem('ratecheck_recent') || '[]')) } catch {}
  }, [])
  function add(q) {
    try {
      const next = [q, ...recent.filter(x => x !== q)].slice(0, 12)
      localStorage.setItem('ratecheck_recent', JSON.stringify(next))
      setRecent(next)
    } catch {}
  }
  return [recent, add]
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Home({ user }) {
  const [question, setQuestion] = useState('')
  const [exchanges, setExchanges] = useState([])
  const [loading, setLoading] = useState(false)
  const [activePanel, setActivePanel] = useState(null)
  const [recentQueries, addToRecent] = useRecentQueries()
  const textareaRef = useRef(null)
  const chatScrollRef = useRef(null)

  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
  }, [exchanges])

  async function runQuery(q) {
    const trimmed = q.trim()
    if (!trimmed || loading) return
    setLoading(true)
    const start = Date.now()
    setExchanges(prev => [...prev, { question: trimmed, timestamp: new Date().toISOString(), elapsed: null, sql: null, rows: null, explanation: null, error: null, queryLogId: null }])

    try {
      const res = await fetch('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: trimmed }) })
      const data = await res.json()
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      if (!data.error) addToRecent(trimmed)
      setExchanges(prev => [...prev.slice(0, -1), { ...prev[prev.length - 1], elapsed, sql: data.sql, rows: data.rows || [], explanation: data.explanation || null, signals: data.signals || [], error: data.error || null, queryLogId: data.queryLogId || null }])
    } catch (err) {
      setExchanges(prev => [...prev.slice(0, -1), { ...prev[prev.length - 1], error: err.message, elapsed: ((Date.now() - start) / 1000).toFixed(1) }])
    }
    setLoading(false)
    setQuestion('')
  }

  function handlePrompt(p) {
    setQuestion(p)
    setActivePanel(null)
    textareaRef.current?.focus()
  }

  function handleKey(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runQuery(question)
  }

  function togglePanel(id) {
    setActivePanel(p => p === id ? null : id)
  }

  const initial = (user?.email?.[0] || 'U').toUpperCase()

  return (
    <>
      <Head>
        <title>RateCheck — Research Console</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <header className="masthead">
        <div className="masthead-inner">
          <div className="wordmark">RateCheck<em> · research console</em></div>
          <div className="masthead-meta">
            <span>Greater Manchester pilot</span>
            <span>123,719 hereditaments</span>
          </div>
        </div>
      </header>

      <div className="app-shell">
        {/* Icon rail */}
        <nav className="icon-rail">
          <div className="icon-rail-top">
            {['recent', 'examples', 'schema', 'tips'].map(id => (
              <button
                key={id}
                className={`icon-btn${activePanel === id ? ' active' : ''}`}
                onClick={() => togglePanel(id)}
                title={PANEL_TITLES[id]}
              >
                {ICONS[id]}
              </button>
            ))}
          </div>
          <div className="icon-rail-bottom">
            <div className="user-avatar" title={user?.email}>{initial}</div>
          </div>
        </nav>

        {/* Slide-in panel */}
        {activePanel && (
          <>
            <div className="side-panel">
              <div className="side-panel-head">
                {PANEL_TITLES[activePanel]}
                <button className="side-panel-close" onClick={() => setActivePanel(null)} title="Close">✕</button>
              </div>
              <div className="side-panel-body">
                {activePanel === 'recent'   && <RecentPanel queries={recentQueries} onSelect={handlePrompt} />}
                {activePanel === 'examples' && <ExamplesPanel onSelect={handlePrompt} />}
                {activePanel === 'schema'   && <SchemaPanel />}
                {activePanel === 'tips'     && <TipsPanel />}
              </div>
            </div>
            <div className="panel-backdrop" onClick={() => setActivePanel(null)} />
          </>
        )}

        {/* Chat */}
        <div className="chat-panel">
          <div className="chat-scroll" ref={chatScrollRef}>
            <div className="chat-content">
              {exchanges.length === 0 && (
                <div className="chat-empty">
                  <div className="chat-empty-title">VOA rating list research</div>
                  <p>Ask a question of the Greater Manchester business rates data.<br />Use the icons on the left to browse examples or check the schema.</p>
                </div>
              )}
              {exchanges.map((ex, i) => <Exchange key={i} item={ex} />)}
            </div>
          </div>

          <div className="chat-bar">
            <div className="chat-bar-inner">
              <textarea ref={textareaRef} className="chat-textarea" value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={handleKey} placeholder="Ask a question of the rating list…" rows={2} />
              <button className="chat-submit" onClick={() => runQuery(question)} disabled={loading || !question.trim()}>
                {loading ? 'Running…' : 'Run'}
              </button>
            </div>
            <div className="chat-hint">⌘ Enter to run · read-only · evidence leads, not appeal conclusions</div>
          </div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps({ req, res }) {
  const supabase = createPagesServerClient({ req, res })
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { redirect: { destination: '/login', permanent: false } }
  return { props: { user: session.user } }
}
