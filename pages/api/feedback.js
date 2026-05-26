import { Pool } from 'pg'
import { createPagesServerClient } from '@supabase/auth-helpers-nextjs'

const pool = new Pool({ connectionString: process.env.DATABASE_URL_READONLY })

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const supabase = createPagesServerClient({ req, res })
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const { queryLogId, thumbsUp, comment } = req.body
  if (!queryLogId) return res.status(400).json({ error: 'queryLogId required' })

  await pool.query(
    'INSERT INTO query_feedback (query_log_id, thumbs_up, comment) VALUES ($1, $2, $3)',
    [queryLogId, thumbsUp ?? null, comment?.trim() || null]
  )

  return res.status(200).json({ ok: true })
}
