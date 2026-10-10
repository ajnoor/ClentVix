import type { ProviderStatus } from './types'

/** Server-side configuration. None of these values may ever be sent to the browser. */
export function getConfig() {
  const dailyLimit = Number.parseInt(process.env.DISCOVERY_DAILY_LIMIT ?? '', 10)
  return {
    placesApiKey: process.env.GOOGLE_PLACES_API_KEY?.trim() || null,
    geminiApiKey: process.env.GEMINI_API_KEY?.trim() || null,
    geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash',
    discoveryDailyLimit: Number.isFinite(dailyLimit) && dailyLimit > 0 ? dailyLimit : 20,
    allowedEmails: new Set(
      (process.env.ALLOWED_EMAILS ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  }
}

export function providerStatus(): ProviderStatus {
  const c = getConfig()
  return { places: Boolean(c.placesApiKey), gemini: Boolean(c.geminiApiKey), geminiModel: c.geminiModel, database: Boolean(process.env.DATABASE_URL) }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next
      next += 1
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}
