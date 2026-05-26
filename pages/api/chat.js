import Anthropic from '@anthropic-ai/sdk'
import { createPagesServerClient } from '@supabase/auth-helpers-nextjs'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM = `You are a chartered surveyor's research assistant specialising in UK business rates.
You have been given the results of a database query against the VOA rating list for Greater Manchester.

Return ONLY valid JSON in this format (no markdown fences):
{
  "reply": "your plain-English response",
  "suggestions": []
}

Rules for reply:
- Answer using only the data provided — do not invent figures.
- Be specific: quote numbers, name properties.
- No markdown, no bullet points, no hedging phrases.
- Write as a knowledgeable colleague, not a report.
- If the question cannot be answered from the data shown, say so briefly and clearly.

Rules for suggestions:
- If the reply states the question cannot be answered from the current data and needs a new query,
  include 1–3 specific ready-to-run query strings the user can click to run immediately.
- Suggestions must be natural-language questions, specific enough to generate useful SQL
  (name properties, postcodes, or description codes where relevant).
- If the reply answers the question from the data, suggestions should be [].
- Do not suggest queries already answered by the current data.`

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
    max_tokens: 600,
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
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    })
  } catch {
    return res.status(200).json({ reply: text, suggestions: [] })
  }
}
