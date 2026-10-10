import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'
import { getConfig } from '@/lib/config'

/**
 * Google sign-in via Auth.js (free, no database tables required: sessions are signed, encrypted JWT cookies).
 * The stable Google account id (`sub`) is the user id that scopes every database row.
 * Env: AUTH_SECRET, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET (read automatically by Auth.js).
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google({ authorization: { params: { prompt: 'select_account' } } })],
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 14 },
  pages: { signIn: '/', error: '/' },
  callbacks: {
    signIn({ account, profile }) {
      if (account?.provider !== 'google' || !profile?.sub) return false
      if (profile.email_verified !== true) return false
      const allowed = getConfig().allowedEmails
      if (allowed.size > 0 && !allowed.has((profile.email ?? '').toLowerCase())) return false
      return true
    },
    jwt({ token, profile }) {
      if (profile?.sub) token.uid = profile.sub
      return token
    },
    session({ session, token }) {
      if (typeof token.uid === 'string') session.user.id = token.uid
      return session
    },
  },
})
