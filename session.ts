import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { auth } from '@/auth'
import { getConfig } from './config'
import { HttpError } from './errors'
import { SsrfError } from './ssrf'

export type SessionUser = { id: string; email: string | null; name: string | null; image: string | null }

export async function getUser(): Promise<SessionUser | null> {
  const session = await auth()
  const user = session?.user
  if (!user?.id) return null
  const allowed = getConfig().allowedEmails
  if (allowed.size > 0 && !allowed.has((user.email ?? '').toLowerCase())) return null
  return { id: user.id, email: user.email ?? null, name: user.name ?? null, image: user.image ?? null }
}

/** Cookie-authenticated writes must come from our own origin (defence in depth on top of SameSite=Lax). */
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin')
  if (origin) {
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {}
    if (!host || originHost !== host) throw new HttpError('Cross-origin request blocked.', 403)
  } else if (request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError('Cross-origin request blocked.', 403)
  }
}

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

export function errorResponse(error: unknown) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status)
  if (error instanceof ZodError) {
    const issue = error.issues[0]
    return json({ error: `Invalid input${issue?.path.length ? ` (${issue.path.join('.')})` : ''}: ${issue?.message ?? 'check your values'}.` }, 400)
  }
  if (error instanceof SsrfError) return json({ error: error.message }, 400)
  const code = (error as { code?: string } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  console.error('[api] unhandled error:', message)
  if (message.includes('DATABASE_URL') || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === '57P03') {
    return json({ error: 'The database is unavailable right now. Please try again shortly.' }, 503)
  }
  return json({ error: 'Something went wrong. Please try again.' }, 500)
}

type Handler<P> = (ctx: { user: SessionUser; request: NextRequest; params: P }) => Promise<Response>

/** Wraps an API route: requires a signed-in user, checks origin on writes, and maps errors safely. */
export function authed<P = Record<string, never>>(handler: Handler<P>) {
  return async (request: NextRequest, context?: { params?: Promise<P> }) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') assertSameOrigin(request)
      const user = await getUser()
      if (!user) return json({ error: 'Please sign in.' }, 401)
      const params = (context?.params ? await context.params : {}) as P
      return await handler({ user, request, params })
    } catch (error) {
      return errorResponse(error)
    }
  }
}

/** Reads a request body as text, aborting once `maxBytes` is exceeded (Content-Length can lie or be absent). */
export async function readTextCapped(request: Request, maxBytes: number) {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new HttpError('File is too large (max 1 MB).', 413)
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new HttpError('File is too large (max 1 MB).', 413)
    }
    chunks.push(value)
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
}
