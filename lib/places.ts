import { z } from 'zod'

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'ProviderError'
  }
}

export type PlaceCandidate = {
  placeId: string
  name: string
  address: string | null
  websiteUri: string | null
  mapsUrl: string | null
  category: string
  rating: number | null
  ratingCount: number | null
  snippet?: string | null
}

const responseSchema = z.object({
  ok: z.boolean().optional(),
  results: z.array(z.unknown()).optional(),
  error: z.string().optional(),
  detail: z.string().optional(),
})

const resultSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  snippet: z.string().optional(),
})

const blockedHosts = [
  'prweb.com',
  'whatclinic.com',
  'freeindex.co.uk',
  'yell.com',
  'thomsonlocal.com',
  '192.com',
  'trustpilot.com',
  'yellowpages.com',
  'yelp.com',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'bark.com',
  'hotfrog.com',
  'cylex-uk.co.uk',
  'scoot.co.uk',
  'threebestrated.co.uk',
  'doctify.com',
  'google.com',
]

function isBlockedHost(host: string): boolean {
  return blockedHosts.some((blocked) =>
    host === blocked || host.endsWith(`.${blocked}`),
  )
}

function cleanName(title: string, host: string): string {
  const first = title
    .split(/\s+[|–—]\s+|\s+-\s+/)[0]
    ?.trim()

  return first && first.length >= 2
    ? first
    : host.replace(/^www\./, '').split('.')[0]
}

export async function searchPlaces(
  input: {
    businessType: string
    location: string
    maxResults: number
    apiKey?: string
  },
  fetchImpl: typeof fetch = fetch,
): Promise<PlaceCandidate[]> {
  const target = Math.min(Math.max(input.maxResults, 1), 20)
  const params = new URLSearchParams({
    index: 'web',
    q: `${input.businessType} ${input.location} official website`,
    size: String(Math.min(100, Math.max(20, target * 6))),
    lang: 'en',
  })

  let response: Response

  try {
    response = await fetchImpl(
      `https://freeserp.ai/api.php?${params.toString()}`,
      { signal: AbortSignal.timeout(15_000) },
    )
  } catch (error) {
    throw new ProviderError(
      `Could not reach FreeSerp: ${
        error instanceof Error ? error.message : 'network error'
      }`,
    )
  }

  if (!response.ok) {
    let detail = ''
    try {
      const body = await response.json() as {
        error?: string
        detail?: string
      }
      detail = body.detail ?? body.error ?? ''
    } catch {}

    throw new ProviderError(
      `FreeSerp returned ${response.status}${
        detail ? `: ${detail}` : ''
      }`,
      response.status,
    )
  }

  const payload = responseSchema.safeParse(await response.json())

  if (!payload.success || payload.data.ok === false) {
    throw new ProviderError('FreeSerp returned an unexpected response.')
  }

  const results: PlaceCandidate[] = []
  const seen = new Set<string>()

  for (const raw of payload.data.results ?? []) {
    const parsed = resultSchema.safeParse(raw)
    if (!parsed.success) continue

    const result = parsed.data
    let url: URL

    try {
      url = new URL(result.url)
    } catch {
      continue
    }

    if (!['https:', 'http:'].includes(url.protocol)) continue

    const host = url.hostname.toLowerCase().replace(/^www\./, '')

    if (isBlockedHost(host)) continue

    // Prefer business sites over obvious press releases and articles.
    if (
      /\/(releases?|press|news|blog|articles?|posts?)(\/|$)/i.test(
        url.pathname,
      )
    ) continue

    if (/\.(pdf|docx?|xlsx?)$/i.test(url.pathname)) continue
    if (seen.has(host)) continue

    const name = result.title?.trim()
    if (!name) continue

    seen.add(host)

    results.push({
      placeId: `${host}${url.pathname}`,
      name: cleanName(name, host),
      address: null,
      websiteUri: url.toString(),
      mapsUrl: url.toString(),
      category: input.businessType,
      rating: null,
      ratingCount: null,
      snippet: result.snippet?.trim() || null,
    })

    if (results.length >= target) break
  }

  return results
}
