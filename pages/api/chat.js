import Anthropic from '@anthropic-ai/sdk'
import { createPagesServerClient } from '@supabase/auth-helpers-nextjs'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM = `You are a chartered surveyor's research assistant specialising in UK business rates.
You have been given the results of a database query against the VOA rating list for Greater Manchester.

Return ONLY valid JSON (no markdown fences):
{
  "reply": "...",
  "followup_query": "..." or null
}

RULE 1 — If you CAN answer fully from the current data:
- reply: 2–4 sentences of plain-English analysis. Quote key numbers, name standout properties,
  flag anomalies. Do NOT list or re-enumerate rows — the user can already see the table.
- followup_query: null

RULE 2 — If the user's question requires data NOT in the current results (e.g. comparables, peers,
other properties, different streets, scheme members, etc.):
- reply: one short sentence naming what you need and stating you are fetching it now.
  Example: "I need the comparable CS shops on Monton Road — fetching that now."
- followup_query: a precise natural-language question that will produce useful SQL.
  Include: the street or postcode area, the property type code (e.g. CS, CO), and the metric needed.
  Example: "Compare rateable value per sqm for CS retail shops on Monton Road M30"

ABSOLUTE RULES:
- NEVER say "I cannot answer", "I don't have", "the data doesn't include", or any variant.
- NEVER set followup_query to null when more data would let you answer the question.
- If in doubt, fetch the data. A follow-up query costs nothing; leaving the user without an answer does.
- For peer/comparable queries, followup_query must ask for ONE ROW PER PROPERTY (aggregate metrics:
  rateable value, total area, RV per sqm, unadjusted price). NEVER ask for zone breakdowns or
  smv_line_items data in a peer comparison — that produces one row per floor zone, which is unreadable.`

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const supabase = createPagesServerClient({ req, res })
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const { context, messages } = req.body
  if (!messages?.length) return res.status(400).json({ error: 'messages required' })

  const preview = JSON.stringify((context.rows || []).slice(0, 30), null, 2)
  const contextBlock = `Original question: ${context.question}

Data returned (${(context.rows || []).length} rows):
${preview}

${context.explanation ? `Headline finding: ${context.explanation}` : ''}`

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `${SYSTEM}\n\n---\n${contextBlock}`,
    messages,
  })

  const text = msg.content[0].text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()

  try {
    const parsed = JSON.parse(text)
    return res.status(200).json({
      reply: parsed.reply || text,
      followup_query: parsed.followup_query || null,
    })
  } catch {
    // JSON parse failed (usually unescaped newlines in a long reply) — extract fields with regex
    const replyMatch = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    const followupMatch = text.match(/"followup_query"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    const reply = replyMatch ? replyMatch[1].replace(/\\n/g, '\n') : 'Could not parse response.'
    const followup_query = followupMatch ? followupMatch[1] : null
    return res.status(200).json({ reply, followup_query })
  }
}
