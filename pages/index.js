import { useState, useRef } from 'react'
import { createPagesServerClient } from '@supabase/auth-helpers-nextjs'
import Head from 'next/head'

const SUGGESTED_PROMPTS = [
  'Show me parades where the tariff looks anomalous against comparable peers',
  'Compare Monton Road\'s tariff to other secondary parades in Salford',
  'Find properties paying significantly more per sqm than their parade median',
  'What\'s the tariff range across all parades with 10+ properties in M30?',
  'Show the full valuation breakdown for 225 Monton Road',
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
  )
}

function Exchange({ item, onFeedback }) {
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
        Run · {timeStr} · {item.elapsed ? `${item.elapsed}s` : '…'}
      </div>

      {item.error && (
        <div className="error-block">{item.error}</div>
      )}

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
                <button
                  className={`feedback-btn${thumbs === true ? ' active' : ''}`}
                  onClick={() => submitFeedback(true)}
                  title="Useful"
                >↑</button>
                <button
                  className={`feedback-btn${thumbs === false ? ' active' : ''}`}
                  onClick={() => submitFeedback(false)}
                  title="Not useful"
                >↓</button>
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
    </div>
  )
}

export default function Home({ user, hereditamentCount }) {
  const [question, setQuestion] = useState('')
  const [exchanges, setExchanges] = useState([])
  const [loading, setLoading] = useState(false)
  const textareaRef = useRef(null)

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
    setExchanges(prev => [pending, ...prev])

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      })
      const data = await res.json()
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      setExchanges(prev => [{
        ...prev[0],
        elapsed,
        sql: data.sql,
        rows: data.rows || [],
        explanation: data.explanation || null,
        error: data.error || null,
        queryLogId: data.queryLogId || null,
      }, ...prev.slice(1)])
    } catch (err) {
      setExchanges(prev => [{ ...prev[0], error: err.message, elapsed: ((Date.now() - start) / 1000).toFixed(1) }, ...prev.slice(1)])
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

  const count = hereditamentCount ? hereditamentCount.toLocaleString() : '—'

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
            <span>{count} hereditaments loaded</span>
            <a href="#schema">Schema</a>
          </div>
        </div>
      </header>

      <div className="shell">
        <section className="banner">
          <div>
            <div className="banner-eyebrow">VOA business rates intelligence · prototype</div>
            <h1>Ask in English. <em>See the evidence.</em></h1>
            <p className="banner-lede">
              A research tool for chartered surveyors. Plain questions become SQL against
              the published rating list; the answer comes with the working shown.
            </p>
          </div>
          <div className="banner-stats">
            <div className="stat">
              <div className="stat-label">Hereditaments</div>
              <div className="stat-figure">{count}</div>
              <div className="stat-note">Greater Manchester corpus</div>
            </div>
            <div className="stat">
              <div className="stat-label">Postcode areas</div>
              <div className="stat-figure">5</div>
              <div className="stat-note">M · SK · OL · BL · WN</div>
            </div>
            <div className="stat">
              <div className="stat-label">Tables</div>
              <div className="stat-figure">3</div>
              <div className="stat-note">VOA rating list schema</div>
            </div>
          </div>
        </section>

        <main className="workspace">
          <section>
            <div className="console-head">
              <h2 className="console-title">Research console</h2>
              <div className="console-meta">Read-only · evidence leads, not appeal conclusions</div>
            </div>

            <div className="composer">
              <div className="composer-label">Ask a question of the rating list.</div>
              <div className="composer-row">
                <textarea
                  ref={textareaRef}
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  onKeyDown={handleKey}
                  placeholder="e.g. Find properties paying significantly more per sqm than their parade median"
                />
                <button
                  className="submit"
                  onClick={() => runQuery(question)}
                  disabled={loading || !question.trim()}
                >
                  {loading ? 'Running…' : 'Run query'}
                </button>
              </div>
            </div>

            <div className="prompts">
              {SUGGESTED_PROMPTS.map(p => (
                <button key={p} className="prompt" onClick={() => handlePrompt(p)}>{p}</button>
              ))}
            </div>

            {exchanges.map((ex, i) => (
              <Exchange key={i} item={ex} />
            ))}
          </section>

          <aside className="sidebar">
            <div className="side-section">
              <h3>What the AI checks</h3>
              <p>Every answer is grounded in the rating-list tables. The SQL is exposed so the working can be inspected.</p>
              <ul className="side-list">
                <li>
                  <b>Comparable context</b>
                  <span>Neighbours, parade peers, postcode and scheme references.</span>
                </li>
                <li>
                  <b>£/sqm pressure</b>
                  <span>Outliers against street and scheme medians.</span>
                </li>
                <li>
                  <b>Zoning evidence</b>
                  <span>Zone A / B / C breakdowns from summary valuation line items.</span>
                </li>
              </ul>
            </div>

            <div className="side-section">
              <h3>What this is not</h3>
              <ul className="side-list">
                <li>
                  <b>Not an appeal recommendation</b>
                  <span>Anomalies are leads for surveyor review.</span>
                </li>
                <li>
                  <b>Not rental evidence</b>
                  <span>The platform sees the list, not the market.</span>
                </li>
                <li>
                  <b>Not measurement</b>
                  <span>Floor areas come from VOA records, not site survey.</span>
                </li>
              </ul>
            </div>

            <div id="schema" className="side-section">
              <h3>Schema</h3>
              <div className="schema">
                <span className="tbl">list_entries</span>{'\n'}
                {'  '}<span className="col">assessment_reference</span>{'\n'}
                {'  '}<span className="col">uarn</span>{'\n'}
                {'  '}<span className="col">postcode · street</span>{'\n'}
                {'  '}<span className="col">primary_description_code</span>{'\n'}
                {'  '}<span className="col">rateable_value</span>{'\n'}
                {'\n'}
                <span className="tbl">smv_assessments</span>{'\n'}
                {'  '}<span className="col">assessment_reference</span>{'\n'}
                {'  '}<span className="col">total_area_or_units</span>{'\n'}
                {'  '}<span className="col">unadjusted_price</span>{'\n'}
                {'  '}<span className="col">scheme_reference</span>{'\n'}
                {'\n'}
                <span className="tbl">smv_line_items</span>{'\n'}
                {'  '}<span className="col">assessment_reference</span>{'\n'}
                {'  '}<span className="col">floor_description</span>{'\n'}
                {'  '}<span className="col">description · area · price</span>
              </div>
            </div>
          </aside>
        </main>

        <footer className="colophon">
          <strong>Prototype note</strong>
          Figures are drawn directly from the VOA compiled rating list for Greater Manchester.
          The AI generates SQL only — answers come from the database, not the model.
          All outputs are intended for review by a qualified rating surveyor before any appeal action.
        </footer>
      </div>
    </>
  )
}

export async function getServerSideProps({ req, res }) {
  const supabase = createPagesServerClient({ req, res })
  const { data: { session } } = await supabase.auth.getSession()

  if (!session) {
    return { redirect: { destination: '/login', permanent: false } }
  }

  return { props: { user: session.user, hereditamentCount: null } }
}
