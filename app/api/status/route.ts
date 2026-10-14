import { authed, json } from '@/lib/session'
import { providerStatus } from '@/lib/config'

export const GET = authed(async () => {
  return json({ status: providerStatus() })
})
