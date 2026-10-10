import { Sparkles } from 'lucide-react'
import { auth } from '@/auth'
import { AppShell } from '@/components/app-shell'
import { signInWithGoogle } from './actions'

export const dynamic = 'force-dynamic'

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await auth()
  if (session?.user?.id) {
    return <AppShell user={{ name: session.user.name ?? null, email: session.user.email ?? null }} />
  }
  const { error } = await searchParams
  const configured = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET && process.env.AUTH_SECRET)
  return (
    <main className="signin-wrap">
      <div className="signin-card">
        <div className="brand"><div className="brand-mark"><Sparkles size={17} /></div><span>clentvix</span></div>
        <h1>Find clients worth approaching.</h1>
        <p>Sign in to discover real local businesses, backed by evidence from their own websites.</p>
        {error && <div className="error-box" role="alert">Sign-in failed or this Google account is not allowed. Please try again.</div>}
        {!configured && <div className="error-box" role="alert">Google sign-in is not configured on the server (AUTH_SECRET, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET).</div>}
        <form action={signInWithGoogle}>
          <button type="submit" className="google-btn" disabled={!configured}>Continue with Google</button>
        </form>
      </div>
    </main>
  )
}
