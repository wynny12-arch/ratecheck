import { useEffect } from 'react'
import { useRouter } from 'next/router'
import { createBrowserClient } from '../../lib/supabase'

export default function AuthCallback() {
  const router = useRouter()

  useEffect(() => {
    const supabase = createBrowserClient()

    async function handleCallback() {
      // Handle PKCE code exchange if present in URL
      const code = new URLSearchParams(window.location.search).get('code')
      if (code) {
        await supabase.auth.exchangeCodeForSession(code)
      }

      // Check for session immediately — may already be set from URL hash
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        router.replace('/')
        return
      }

      // Fall back to event listener for slower flows
      const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN') router.replace('/')
      })
      return () => subscription.unsubscribe()
    }

    handleCallback()
  }, [router])

  return (
    <p style={{ fontFamily: 'system-ui', padding: 40, color: '#4a443d' }}>
      Signing you in…
    </p>
  )
}
