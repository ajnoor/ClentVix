import { z } from 'zod'

/**
 * Discovery provider: Google Places API (New) "Text Search".
 * Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
 * Every result is a real listing returned by Google; nothing here fabricates businesses.
 */

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
}

const placeSchema = z.object({
  id: z.string().min(1),
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  websiteUri: z.string().optional(),
  googleMapsUri: z.string().optional(),
  primaryTypeDisplayName: z.object({ text: z.string() }).optional(),
  types: z.array(z.string()).optional(),
  businessStatus: z.string().optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().optional(),
})
const responseSchema = z.object({ places: z.array(z.unknown()).optional() })

// websiteUri/rating are billed under the Text Search *Enterprise* SKU; the rest are Pro.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.websiteUri',
  'places.googleMapsUri',
  'places.primaryTypeDisplayName',
  'places.types',
  'places.businessStatus',
  'places.rating',
  'places.userRatingCount',
].join(',')

export async function searchPlaces(
  input: { businessType: string; location: string; maxResults: number; apiKey: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PlaceCandidate[]> {
  let response: Response
  try {
    response = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': input.apiKey, 'x-goog-fieldmask': FIELD_MASK },
      body: JSON.stringify({ textQuery: `${input.businessType} in ${input.location}`, pageSize: Math.min(Math.max(input.maxResults, 1), 20), languageCode: 'en' }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new ProviderError(`Could not reach Google Places: ${error instanceof Error ? error.message : 'network error'}`)
  }
  if (!response.ok) {
    let detail = ''
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      detail = body.error?.message ?? ''
    } catch {}
    throw new ProviderError(`Google Places returned ${response.status}${detail ? `: ${detail}` : ''}`, response.status)
  }
  const parsed = responseSchema.safeParse(await response.json())
  if (!parsed.success) throw new ProviderError('Google Places returned an unexpected response.')
  const out: PlaceCandidate[] = []
  const seen = new Set<string>()
  for (const raw of parsed.data.places ?? []) {
    const place = placeSchema.safeParse(raw)
    if (!place.success || !place.data.displayName?.text) continue
    const p = place.data
    if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue // skip permanently/temporarily closed
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push({
      placeId: p.id,
      name: p.displayName!.text,
      address: p.formattedAddress ?? null,
      websiteUri: p.websiteUri ?? null,
      mapsUrl: p.googleMapsUri ?? null,
      category: p.primaryTypeDisplayName?.text ?? p.types?.[0]?.replace(/_/g, ' ') ?? 'Business',
      rating: p.rating ?? null,
      ratingCount: p.userRatingCount ?? null,
    })
  }
  return out
}
