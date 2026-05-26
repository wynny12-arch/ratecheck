import Anthropic from '@anthropic-ai/sdk'
import { createPagesServerClient } from '@supabase/auth-helpers-nextjs'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM = `You are a chartered surveyor's research assistant specialising in UK business rates.
You have been given the results of a database query against the VOA rating list for Greater Manchester.
Answer follow-up questions in plain English using only the data provided — do not invent figures.
Be specific: quote numbers, name properties, compare values from the result.
If the question cannot be answered from the data shown, say so and suggest what query would help.
No markdown, no bullet points, no hedging phrases. Write as a knowledgeable colleague, not a report.`

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const supabase = createPagesServerClient({ req, res })
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const { context, messages } = req.body
  // context: { question, rows, explanation }
  // messages: [{ role: 'user'|'assistant', content: string }]

  if (!messages?.length) return res.status(400).json({ error: 'messages required' })

  const preview = JSON.stringify((context.rows || []).slice(0, 30), null, 2)
  const contextBlock = `Original question: ${context.question}

Data returned (${(context.rows || []).length} rows):
${preview}

${context.explanation ? `Headline finding: ${context.explanation}` : ''}`

  const systemWithContext = `${SYSTEM}

---
${contextBlock}`

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: systemWithContext,
    messages,
  })

  return res.status(200).json({ reply: msg.content[0].text.trim() })
}
