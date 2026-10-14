import { z } from 'zod'
import { authed, json } from '@/lib/session'
import { HttpError } from '@/lib/errors'
import {
  listProspects,
  updateProspect,
  deleteProspect,
} from '@/lib/prospects'
import { STAGES } from '@/lib/types'

export const GET = authed(async ({ user }) => {
  const prospects = await listProspects(user.id)
  return json({ prospects })
})

const updateSchema = z.object({
  id: z.string().min(1),
  stage: z.enum(STAGES).optional(),
  saved: z.boolean().optional(),
}).refine(
  (data) => data.stage !== undefined || data.saved !== undefined,
)

export const PATCH = authed(async ({ user, request }) => {
  const parsed = updateSchema.safeParse(await request.json())

  if (!parsed.success) {
    throw new HttpError('Invalid prospect update.', 400)
  }

  const { id, ...change } = parsed.data
  const prospect = await updateProspect(user.id, id, change)

  if (!prospect) {
    throw new HttpError('Prospect not found.', 404)
  }

  return json({ prospect })
})

export const DELETE = authed(async ({ user, request }) => {
  const id = new URL(request.url).searchParams.get('id')

  if (!id) {
    throw new HttpError('Prospect ID is required.', 400)
  }

  const deleted = await deleteProspect(user.id, id)

  if (!deleted) {
    throw new HttpError('Prospect not found.', 404)
  }

  return json({ deleted: true })
})
