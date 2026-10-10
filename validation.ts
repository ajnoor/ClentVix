import { z } from 'zod'
import { STAGES } from './types'

import { FOCUS_OPTIONS } from './validation-options'

export { FOCUS_OPTIONS }

// Strip control characters and collapse whitespace; the values end up in search queries and LLM prompts.
const text = (min: number, max: number) =>
  z
    .string()
    .transform((v) => v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(min, `must be at least ${min} characters`).max(max, `must be at most ${max} characters`))

export const discoveryInput = z.object({
  businessType: text(2, 120),
  location: text(2, 120),
  focus: z.enum(FOCUS_OPTIONS).default(FOCUS_OPTIONS[0]),
  maxResults: z.number().int().min(1).max(20).default(10),
})

export const idSchema = z.string().uuid()

export const prospectPatch = z
  .object({ id: idSchema, stage: z.enum(STAGES).optional(), saved: z.boolean().optional() })
  .refine((v) => v.stage !== undefined || v.saved !== undefined, { message: 'nothing to update' })

const longText = (max: number) => z.string().transform((v) => v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()).pipe(z.string().max(max))

export const settingsInput = z.object({
  serviceName: text(0, 160),
  valueProposition: longText(800),
  defaultBusinessType: text(0, 120),
  defaultLocation: text(0, 120),
})

export const auditInput = z.object({ url: z.string().url().max(2048) })
