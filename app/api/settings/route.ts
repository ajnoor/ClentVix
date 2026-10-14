import { authed, json } from '@/lib/session'
import { getSettings, saveSettings } from '@/lib/settings'
import { settingsInput } from '@/lib/validation'

export const GET = authed(async ({ user }) => {
  return json({ settings: await getSettings(user.id) })
})

export const PUT = authed(async ({ user, request }) => {
  const input = settingsInput.parse(await request.json())
  return json({ settings: await saveSettings(user.id, input) })
})
