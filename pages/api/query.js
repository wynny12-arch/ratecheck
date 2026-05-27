import Anthropic from '@anthropic-ai/sdk'
import { Pool } from 'pg'
import { createPagesServerClient } from '@supabase/auth-helpers-nextjs'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL_READONLY,
  max: 5,
  idleTimeoutMillis: 30000,
})

const SCHEMA = `
Tables in a UK VOA business rates database for Greater Manchester (~250k hereditaments):

list_entries
  assessment_reference BIGINT PK
  uarn                 BIGINT
  number_or_name       VARCHAR   -- house number or property name
  street               VARCHAR
  town                 VARCHAR
  postcode             VARCHAR
  postcode_area        VARCHAR   -- outward district code, e.g. M30, SK1, OL4
  primary_description_code VARCHAR -- e.g. CS=Shop & Premises, CO=Office, CF=Factory
  primary_description_text VARCHAR
  scat_code_and_suffix VARCHAR
  rateable_value       BIGINT    -- whole pounds (£)
  firm_name            VARCHAR
  full_property_identifier VARCHAR

smv_assessments  (one per assessment, join on assessment_reference)
  assessment_reference BIGINT PK FK→list_entries
  uarn                 BIGINT
  scheme_reference     BIGINT
  scat_code            VARCHAR
  total_area_or_units  DOUBLE PRECISION  -- m²
  adopted_rv           BIGINT            -- whole pounds (£)
  unit_of_measurement  VARCHAR           -- GIA, NIA, EFA, GEA, RCA, OTH
  unadjusted_price     DOUBLE PRECISION  -- £/m² Zone A equivalent

smv_line_items  (one per floor zone, join on assessment_reference)
  assessment_reference BIGINT FK→smv_assessments
  line_number          INTEGER
  floor_description    VARCHAR  -- e.g. Ground, First, Mezzanine
  description          VARCHAR  -- e.g. Zone A, Zone B, Rear
  area                 DOUBLE PRECISION  -- m²
  price                DOUBLE PRECISION  -- £/m²
  value                BIGINT            -- whole pounds (£)
  PRIMARY KEY (assessment_reference, line_number)

Notes:
- Use UPPER() for case-insensitive street/address matching
- primary_description_code prefix: CS=retail shops, CO=offices, CF=factories/warehouses
- £/m² (price, unadjusted_price) are Zone A equivalents for shops
- postcode_area examples: M1, M6, M30, M60, SK1, OL4, BL1, WN3
- Window functions (OVER, PARTITION BY, ROW_NUMBER, RANK, LAG, LEAD) are available
- ROUND(double precision, integer) does not exist in PostgreSQL. Always cast to numeric first:
    ROUND(unadjusted_price::numeric, 2)  -- correct
    ROUND(area::numeric, 2)              -- correct
    ROUND(price::numeric, 2)             -- correct
- When dividing, cast ALL operands to numeric — dividing numeric by double precision
  returns double precision, which still breaks ROUND:
    ROUND(le.rateable_value::numeric / sa.total_area_or_units::numeric, 2)  -- correct
    ROUND(le.rateable_value::numeric / sa.total_area_or_units, 2)           -- WRONG, still fails
- percentile_cont is an ordered-set aggregate, NOT a window function. Correct syntax:
    percentile_cont(0.5) WITHIN GROUP (ORDER BY column)
  For partitioned medians, use a subquery or CTE, e.g.:
    WITH medians AS (
      SELECT street, percentile_cont(0.5) WITHIN GROUP (ORDER BY rateable_value) AS median_rv
      FROM list_entries GROUP BY street
    ) SELECT ... FROM list_entries JOIN medians USING (street)
`.trim()

const SYSTEM_SQL = `You are a SQL expert generating queries for a UK VOA business rates database.

${SCHEMA}

Return a single SELECT statement only.
No markdown fences, no explanation, no other text — just raw SQL.
Never use: DROP, DELETE, INSERT, UPDATE, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, COMMENT.
Never use multiple statements (no semicolons mid-query).
Use standard PostgreSQL. Window functions are fine.

When a question names a specific property (e.g. "225 Monton Road", "43 High Street Stockport"):
- Anchor the query by looking up that property's assessment_reference, primary_description_code,
  and postcode_area from list_entries. If the question contains a full postcode (e.g. M41 9BP),
  filter primarily on postcode (exact match, uppercased) plus number_or_name — do NOT rely on
  street or town matching, as VOA street names often differ from common usage. If no postcode
  is given, use UPPER() string matching on street and number_or_name.
- Compare it only against properties sharing the same primary_description_code prefix
  (first 2 characters) and the same postcode_area — never against unrelated property types.
- Do not use numeric values mentioned in the question (m², £/m²) as filter or join criteria;
  fetch those values from the database instead.

For valuation breakdown / "how is the RV calculated" queries joining smv_line_items:
- Select ONLY: floor_description, description, area, price, value — nothing else.
  This applies whether the property is found by name, postcode, or assessment_reference.
  NEVER select property-level fields (assessment_reference, street, postcode, firm_name,
  primary_description_text, total_area_or_units, unit_of_measurement, unadjusted_price,
  adopted_rv) alongside line-item rows — they are identical on every row and waste columns.
- Never select two columns that belong together as a pair (e.g. total_area_or_units and
  unit_of_measurement, or unadjusted_price and floor_description) without an explicit
  separator or concatenation — adjacent numeric+text columns display as garbled strings.
- Order line items by line_number ASC.`

const SYSTEM_EXPLAIN = `You are a chartered surveyor's research assistant.
Given a question and query results from a VOA business rates database, return ONLY valid JSON in this exact format:
{
  "finding": "2–3 sentences of plain-English findings. Be specific: name properties, quote numbers, state what is anomalous and by how much. Use **bold** for the key assertion. End with whether the surveyor should investigate further. No hedging phrases.",
  "signals": ["signal 1", "signal 2", "signal 3"]
}

Signals are 3–6 short evidence statements (under 10 words each) grounded strictly in the data:
- Quantitative comparisons: "+47% above street median", "£215/sqm vs £390/sqm peers"
- Sample size: "18 comparables analysed", "4-property parade"
- Anomaly flags: "Zone A depth above typical range", "Single-rate vs zoned methodology"
- Relative position: "2nd highest RV/sqm on parade", "Below lower quartile"
- Data quality: "1 comparable only — low confidence", "Strong comparable density"

Do not invent numbers not in the results. Return only the JSON object — no markdown fences, no other text.`

function friendlyError(err) {
  const msg = err.message || ''
  if (msg.includes('credit balance is too low') || err.status === 402)
    return 'Anthropic API credits exhausted — please top up at console.anthropic.com/billing.'
  if (err.status === 429 || msg.includes('rate limit'))
    return 'Too many requests — please wait a moment and try again.'
  if (err.status === 401 || msg.includes('authentication'))
    return 'Anthropic API key invalid or missing.'
  return msg
}

const BANNED = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COMMENT)\b/i
const MULTI_STMT = /;\s*\S/

function validateSql(sql) {
  if (BANNED.test(sql)) return 'SQL contains a banned keyword'
  if (MULTI_STMT.test(sql)) return 'SQL contains multiple statements'
  return null
}

async function generateSql(question, retry = null) {
  const content = retry
    ? `Question: ${question}\n\nPrevious attempt failed:\nError: ${retry.error}\nSQL: ${retry.sql}\n\nCorrect it.`
    : `Question: ${question}`

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_SQL,
    messages: [{ role: 'user', content }],
  })
  // Remove line comments, then take only the first statement (model sometimes appends
  // "-- explanation" or a second SELECT after a semicolon)
  return msg.content[0].text.trim()
    .replace(/--[^\n]*/g, '')  // strip SQL line comments
    .split(/;/)[0]             // take first statement only
    .trim()
}

async function generateExplanation(question, rows) {
  const preview = JSON.stringify(rows.slice(0, 20), null, 2)
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 768,
    system: SYSTEM_EXPLAIN,
    messages: [{
      role: 'user',
      content: `Question: ${question}\n\n${rows.length} rows returned. First 20:\n${preview}\n\nReturn JSON with finding and signals.`,
    }],
  })
  const text = msg.content[0].text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  try {
    const parsed = JSON.parse(text)
    return { explanation: parsed.finding || text, signals: Array.isArray(parsed.signals) ? parsed.signals : [] }
  } catch {
    return { explanation: text, signals: [] }
  }
}

function isAnalytical(question) {
  // Skip explanation for simple factual lookups
  const factual = /^(what is|what'?s|give me|show me the rv|show me the rateable value)\b/i
  return !factual.test(question.trim())
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  // Auth check
  const supabase = createPagesServerClient({ req, res })
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const { question } = req.body
  if (!question?.trim()) return res.status(400).json({ error: 'question required' })

  let sql = null
  let rows = []
  let explanation = null
  let signals = []
  let succeeded = false
  let errorMessage = null

  const client = await pool.connect()
  try {
    // Set query timeout at session level
    await client.query('SET statement_timeout = 10000')

    sql = await generateSql(question)
    const validErr = validateSql(sql)
    if (validErr) throw new Error(validErr)

    let result
    try {
      result = await client.query(sql)
    } catch (dbErr) {
      // One retry
      sql = await generateSql(question, { error: dbErr.message, sql })
      const retryErr = validateSql(sql)
      if (retryErr) throw new Error(retryErr)
      result = await client.query(sql)
    }

    rows = result.rows
    succeeded = true

    if (rows.length > 0 && rows.length <= 200 && isAnalytical(question)) {
      const result = await generateExplanation(question, rows)
      explanation = result.explanation
      signals = result.signals
    }

  } catch (err) {
    errorMessage = friendlyError(err)
    succeeded = false
  } finally {
    client.release()
  }

  // Log every attempt
  try {
    await pool.query(
      `INSERT INTO query_log (user_email, question, generated_sql, row_count, succeeded, error_message, explanation)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [session.user.email, question, sql, rows.length, succeeded, errorMessage, explanation || null]
    )
  } catch (logErr) {
    console.error('query_log write failed:', logErr.message)
  }

  if (!succeeded) {
    return res.status(500).json({ error: errorMessage, sql })
  }

  return res.status(200).json({ sql, rows, explanation, signals, rowCount: rows.length })
}
