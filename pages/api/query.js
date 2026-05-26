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
- Window functions (percentile_cont, OVER, PARTITION BY) are available
`.trim()

const SYSTEM_SQL = `You are a SQL expert generating queries for a UK VOA business rates database.

${SCHEMA}

Return a single SELECT statement only.
No markdown fences, no explanation, no other text — just raw SQL.
Never use: DROP, DELETE, INSERT, UPDATE, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, COMMENT.
Never use multiple statements (no semicolons mid-query).
Use standard PostgreSQL. Window functions are fine.`

const SYSTEM_EXPLAIN = `You are a chartered surveyor's research assistant.
Given a question and query results from a VOA business rates database, write 2–3 sentences of plain-English findings.
Be specific: name properties, quote numbers, state what is anomalous and by how much.
Put the key assertion in bold. End with whether the surveyor should investigate further.
Plain text only — no markdown, no hedging phrases like "it's worth noting"."Worth reviewing" means a genuine anomaly exists in the data.`

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
  return msg.content[0].text.trim()
}

async function generateExplanation(question, rows) {
  const preview = JSON.stringify(rows.slice(0, 20), null, 2)
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: SYSTEM_EXPLAIN,
    messages: [{
      role: 'user',
      content: `Question: ${question}\n\n${rows.length} rows returned. First 20:\n${preview}\n\nWrite the headline finding.`,
    }],
  })
  return msg.content[0].text.trim()
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

    if (rows.length > 0 && rows.length <= 50 && isAnalytical(question)) {
      explanation = await generateExplanation(question, rows)
    }

  } catch (err) {
    errorMessage = err.message
    succeeded = false
  } finally {
    client.release()
  }

  // Log every attempt
  try {
    await pool.query(
      `INSERT INTO query_log (user_email, question, generated_sql, row_count, succeeded, error_message, explanation)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [session.user.email, question, sql, rows.length, succeeded, errorMessage, explanation]
    )
  } catch (logErr) {
    console.error('query_log write failed:', logErr.message)
  }

  if (!succeeded) {
    return res.status(500).json({ error: errorMessage, sql })
  }

  return res.status(200).json({ sql, rows, explanation, rowCount: rows.length })
}
