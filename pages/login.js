import { useState } from 'react'
import { createBrowserClient } from '../lib/supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const supabase = createBrowserClient()
    const { error: err } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    })
    setLoading(false)
    if (err) { setError(err.message); return }
    setSent(true)
  }

  return (
    <>
      <style>{`
        body { margin:0; font-family: "Inter Tight", system-ui, sans-serif;
          background: #faf7f2; color: #1a1714; }
        .wrap { max-width: 420px; margin: 120px auto; padding: 0 24px; }
        .wordmark { font-family: "Fraunces", Georgia, serif; font-size: 22px;
          font-weight: 600; margin-bottom: 40px; }
        .wordmark em { font-style: italic; font-weight: 400; color: #7a1c2c; }
        h1 { font-family: "Fraunces", Georgia, serif; font-weight: 400;
          font-size: 28px; margin: 0 0 8px; }
        p { font-size: 15px; color: #4a443d; margin: 0 0 28px; }
        label { display: block; font-size: 13px; font-weight: 500;
          margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.06em; }
        input { width: 100%; box-sizing: border-box; border: 1px solid #d8d1c4;
          border-radius: 2px; padding: 12px 14px; font: 16px "Inter Tight", sans-serif;
          color: #1a1714; background: #fff; outline: none; }
        input:focus { border-color: #7a1c2c; }
        button { margin-top: 12px; width: 100%; padding: 14px;
          background: #1a1714; color: #faf7f2; border: none; border-radius: 2px;
          font: 500 14px "Inter Tight", sans-serif; text-transform: uppercase;
          letter-spacing: 0.06em; cursor: pointer; }
        button:hover { background: #7a1c2c; }
        button:disabled { opacity: 0.5; cursor: default; }
        .sent { padding: 20px; background: #ebf2ed; border: 1px solid #2d5a3d;
          border-radius: 2px; color: #2d5a3d; font-size: 14px; line-height: 1.55; }
        .err { margin-top: 12px; color: #7a1c2c; font-size: 14px; }
      `}</style>
      <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Inter+Tight:wght@400;500&display=swap" rel="stylesheet" />
      <div className="wrap">
        <div className="wordmark">RateCheck<em> · research console</em></div>
        {sent ? (
          <div className="sent">
            Check your inbox — a sign-in link has been sent to <strong>{email}</strong>.
            The link expires in 60 minutes.
          </div>
        ) : (
          <>
            <h1>Sign in</h1>
            <p>Enter your email address and we&apos;ll send you a sign-in link.</p>
            <form onSubmit={handleSubmit}>
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
              />
              {error && <div className="err">{error}</div>}
              <button type="submit" disabled={loading}>
                {loading ? 'Sending…' : 'Send sign-in link'}
              </button>
            </form>
          </>
        )}
      </div>
    </>
  )
}
