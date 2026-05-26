import { useEffect } from 'react'
import { useRouter } from 'next/router'
import { createBrowserClient } from '../../lib/supabase'

export default function AuthCallback() {
  const router = useRouter()

  useEffect(() => {
    const supabase = createBrowserClient()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') router.replace('/')
    })
    return () => subscription.unsubscribe()
  }, [router])

  return (
    <p style={{ fontFamily: 'system-ui', padding: 40, color: '#4a443d' }}>
      Signing you in…
    </p>
  )
}
