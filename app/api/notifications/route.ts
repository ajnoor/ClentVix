import { authed, json } from '@/lib/session'
import { listDiscoveries, markNotificationsSeen } from '@/lib/settings'

export const GET = authed(async ({ user }) => {
  return json({ notifications: await listDiscoveries(user.id) })
})

export const POST = authed(async ({ user }) => {
  await markNotificationsSeen(user.id)
  return json({ success: true })
})
