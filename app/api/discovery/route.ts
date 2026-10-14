import { NextRequest } from 'next/server'
import { runDiscovery } from '@/lib/discovery'
import { authed, json } from '@/lib/session'
import { discoveryInput } from '@/lib/validation'

export const POST = authed(async ({ user, request }) => {
  const body = await request.json()
  const input = discoveryInput.parse(body)
  const result = await runDiscovery(user.id, input)
  return json({ result })
})
