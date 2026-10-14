import { authed, json } from '@/lib/session'
import { analyzeExistingProspect } from '@/lib/discovery'
import { idSchema } from '@/lib/validation'

export const POST = authed<{ id: string }>(async ({ user, params }) => {
  const id = idSchema.parse(params.id)
  const prospect = await analyzeExistingProspect(user.id, id)
  return json({ prospect })
})
