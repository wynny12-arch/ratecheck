import { useState, useRef, useEffect } from 'react'
import { createPagesServerClient } from '@supabase/auth-helpers-nextjs'
import Head from 'next/head'

const SUGGESTED_PROMPTS = [
  'Show me how the RV is calculated for 225 Monton Road',
  'Show the full valuation breakdown for assessment reference 30773892000',
  'What properties are at postcode M30 9LF?',
  'Is 225 Monton Road\'s RV in line with peers on Monton Road?',
  'Compare the unadjusted price per sqm for CS shops in M30',
  'Find retail shops in M30 where RV per sqm is above the street median',
  'List the 20 highest RV retail properties in Stockport',
  'Which offices in M1 have a rateable value above £100,000?',
  'What scheme reference is used for 225 Monton Road?',
  'List all CS assessments on the same scheme as 225 Monton Road',
  'Find all retail shops on Deansgate Manchester with their RVs',
  'What are the top 10 highest rateable values in M41?',
  'Find warehouse properties in BL1 with rateable value above £50,000',
  'Compare Zone A rates across retail shops in Oldham town centre',
  'Which properties on Monton Road have the highest RV per sqm?',
  'What is the median RV for offices in Salford M5?',
  'Show all shop properties on Market Street Manchester',
  'Find properties in WN1 where adopted RV differs from the calculated value',
  'How many CS retail shops are there in each M postcode area?',
  'Show all play centres and leisure facilities in Greater Manchester',
]

function formatValue(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) > 100) return v.toLocaleString()
    if (!Number.isInteger(v)) return v.toFixed(2)
    return String(v)
  }
  return String(v)
}

function isNumeric(v) {
  return typeof v === 'number'
}

function ResultTable({ rows }) {
  if (!rows || rows.length === 0) return <p style={{ color: 'var(--ink-faint)', fontSize: 14 }}>No rows returned.</p>
  const cols = Object.keys(rows[0])
  return (
    <div style={{ overflowX: 'auto' }}>
    <table>
      <thead>
        <tr>
          {cols.map(c => (
            <th key={c} className={isNumeric(rows[0][c]) ? 'num' : ''}>
              {c.replace(/_/g, ' ')}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {cols.map(c => {
              const v = row[c]
              const num = isNumeric(v)
              return (
                <td key={c} className={num ? 'num' : ''}>
                  {formatValue(v)}
                </td>
              )
            })}
          </tr>
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
        body: JSON.stringify({
          context: { question: item.question, rows: item.rows, explanation: item.explanation },
          messages: next,
        }),
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
        <input
          className="followup-input"
          placeholder="Ask a follow-up about this result…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send() }}
        />
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
    await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queryLogId: item.queryLogId, thumbsUp: up, comment }),
    })
    setSubmitted(true)
  }

  const ts = new Date(item.timestamp)
  const timeStr = ts.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="exchange">
      <p className="question">{item.question}</p>
      <div className="question-meta">
        {item.elapsed ? `${item.elapsed}s · ${timeStr}` : `Running · ${timeStr}`}
      </div>

      {item.error && <div className="error-block">{item.error}</div>}

      {item.explanation && (
        <div className="finding">
          <div className="finding-label">Headline finding</div>
          <p
            className="finding-text"
            dangerouslySetInnerHTML={{
              __html: item.explanation.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'),
            }}
          />
          <div className="finding-meta">
            <span className="signal">Worth reviewing</span>
            {!submitted && (
              <div className="feedback-row">
                <button className={`feedback-btn${thumbs === true ? ' active' : ''}`} onClick={() => submitFeedback(true)} title="Useful">↑</button>
                <button className={`feedback-btn${thumbs === false ? ' active' : ''}`} onClick={() => submitFeedback(false)} title="Not useful">↓</button>
                <input
                  className="feedback-comment"
                  placeholder="What would have made this useful?"
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submitFeedback(thumbs) }}
                />
              </div>
            )}
            {submitted && <span style={{ color: 'var(--ink-faint)', fontSize: 13 }}>Thanks for the feedback.</span>}
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

export default function Home({ user }) {
  const [question, setQuestion] = useState('')
  const [exchanges, setExchanges] = useState([])
  const [loading, setLoading] = useState(false)
  const [showMobilePrompts, setShowMobilePrompts] = useState(false)
  const textareaRef = useRef(null)
  const chatScrollRef = useRef(null)

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
    }
  }, [exchanges])

  async function runQuery(q) {
    const trimmed = q.trim()
    if (!trimmed || loading) return
    setLoading(true)
    const start = Date.now()
    const pending = {
      question: trimmed,
      timestamp: new Date().toISOString(),
      elapsed: null, sql: null, rows: null, explanation: null, error: null, queryLogId: null,
    }
    setExchanges(prev => [...prev, pending])

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      })
      const data = await res.json()
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      setExchanges(prev => [
        ...prev.slice(0, -1),
        { ...prev[prev.length - 1], elapsed, sql: data.sql, rows: data.rows || [], explanation: data.explanation || null, error: data.error || null, queryLogId: data.queryLogId || null },
      ])
    } catch (err) {
      setExchanges(prev => [
        ...prev.slice(0, -1),
        { ...prev[prev.length - 1], error: err.message, elapsed: ((Date.now() - start) / 1000).toFixed(1) },
      ])
    }
    setLoading(false)
    setQuestion('')
  }

  function handlePrompt(p) {
    setQuestion(p)
    textareaRef.current?.focus()
  }

  function handleKey(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runQuery(question)
  }

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
        <aside className="prompt-rail">
          <div className="rail-head">Example queries</div>
          <div className="rail-list">
            {SUGGESTED_PROMPTS.map(p => (
              <button key={p} className="rail-prompt" onClick={() => handlePrompt(p)}>{p}</button>
            ))}
          </div>
          <div className="rail-schema">
            <div className="rail-schema-title">Schema</div>
            <div className="rail-schema-body">
              <span className="rail-tbl">list_entries</span>
              <span className="rail-cols"> assessment_reference · postcode · street · primary_description_code · rateable_value</span>
              <br /><br />
              <span className="rail-tbl">smv_assessments</span>
              <span className="rail-cols"> total_area_or_units · unadjusted_price · unit_of_measurement · adopted_rv</span>
              <br /><br />
              <span className="rail-tbl">smv_line_items</span>
              <span className="rail-cols"> floor_description · description · area · price · value</span>
            </div>
          </div>
        </aside>

        <div className="chat-panel">
          <div className="chat-scroll" ref={chatScrollRef}>
            <div className="chat-content">
              {exchanges.length === 0 && (
                <div className="chat-empty">
                  <div className="chat-empty-title">VOA rating list research</div>
                  <p>Ask a question of the Greater Manchester business rates data.<br />Select an example from the left or type your own below.</p>
                </div>
              )}
              {exchanges.map((ex, i) => (
                <Exchange key={i} item={ex} />
              ))}
            </div>
          </div>

          <div className="chat-bar">
            {showMobilePrompts && (
              <div className="mobile-prompts">
                {SUGGESTED_PROMPTS.map(p => (
                  <button key={p} className="rail-prompt" onClick={() => { handlePrompt(p); setShowMobilePrompts(false) }}>{p}</button>
                ))}
              </div>
            )}
            <div className="chat-bar-inner">
              <textarea
                ref={textareaRef}
                className="chat-textarea"
                value={question}
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Ask a question of the rating list…"
                rows={2}
              />
              <button
                className="chat-submit"
                onClick={() => runQuery(question)}
                disabled={loading || !question.trim()}
              >
                {loading ? 'Running…' : 'Run'}
              </button>
            </div>
            <div className="chat-hint">
              <button className="hint-examples-btn" onClick={() => setShowMobilePrompts(v => !v)}>
                {showMobilePrompts ? 'Hide examples' : 'Examples'}
              </button>
              <span className="hint-sep">·</span>
              ⌘ Enter to run · read-only · evidence leads, not appeal conclusions
            </div>
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
