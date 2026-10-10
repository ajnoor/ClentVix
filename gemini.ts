import { z } from 'zod'

/**
 * Server-side Gemini client (REST). The API key is only ever sent in the x-goog-api-key header from the
 * server and is never logged, returned to the browser or embedded in error messages.
 */

export class GeminiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'GeminiError'
  }
}

const envelope = z.object({
  candidates: z
    .array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() })).optional() }).optional(), finishReason: z.string().optional() }))
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
})

export async function generateJson(
  input: { apiKey: string; model: string; system: string; prompt: string; schema: Record<string, unknown>; timeoutMs?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': input.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: input.schema },
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
    })
  } catch (error) {
    throw new GeminiError(`Could not reach Gemini: ${error instanceof Error ? error.message : 'network error'}`)
  }
  if (!response.ok) {
    let detail = ''
    try {
      detail = ((await response.json()) as { error?: { message?: string } }).error?.message ?? ''
    } catch {}
    throw new GeminiError(`Gemini returned ${response.status}${detail ? `: ${detail.replace(input.apiKey, '[redacted]')}` : ''}`, response.status)
  }
  const parsed = envelope.safeParse(await response.json())
  if (!parsed.success) throw new GeminiError('Gemini returned an unexpected response.')
  if (parsed.data.promptFeedback?.blockReason) throw new GeminiError(`Gemini blocked the request (${parsed.data.promptFeedback.blockReason}).`)
  const text = parsed.data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text.trim()) throw new GeminiError('Gemini returned no content.')
  try {
    return JSON.parse(text)
  } catch {
    throw new GeminiError('Gemini returned invalid JSON.')
  }
}
