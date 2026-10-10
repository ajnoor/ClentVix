import { analyzeCandidates, type AnalysisCandidate, type Outcome } from './analysis'
import { getConfig, mapLimit } from './config'
import { dedupeKey, normalizeDomain } from './domain'
import { ConfigError, HttpError } from './errors'
import { fetchSnapshot, type PageSnapshot } from './page-content'
import { searchPlaces, ProviderError, type PlaceCandidate } from './places'
import { applyAnalysis, findExistingKeys, getProspect, insertProspects, type NewProspect } from './prospects'
import { finishDiscovery, getSettings, startDiscovery } from './settings'
import type { DiscoveryResult, EvidenceItem, Prospect } from './types'

export type DiscoveryInput = { businessType: string; location: string; focus: string; maxResults: number }

export type Deps = {
  searchPlaces: typeof searchPlaces
  fetchSnapshot: (url: string) => Promise<PageSnapshot>
  analyze: typeof analyzeCandidates
}

const defaultDeps: Deps = { searchPlaces, fetchSnapshot: (url) => fetchSnapshot(url), analyze: analyzeCandidates }

function providerEvidence(place: PlaceCandidate, domain: string, fetchedAt: string): EvidenceItem[] {
  const source = place.mapsUrl ?? ''
  if (!source) return []
  const items: EvidenceItem[] = []
  items.push({ kind: 'provider', text: `Listed on Google Maps as “${place.name}”${place.address ? ` at ${place.address}` : ''}.`, sourceUrl: source, fetchedAt })
  if (place.rating !== null) items.push({ kind: 'provider', text: `Google Maps rating ${place.rating.toFixed(1)}${place.ratingCount !== null ? ` from ${place.ratingCount} reviews` : ''}.`, sourceUrl: source, fetchedAt })
  if (!domain) items.push({ kind: 'provider', text: 'No website is listed on the Google Maps profile.', sourceUrl: source, fetchedAt })
  return items
}

function outcomeToProspect(base: NewProspect, outcome: Outcome | undefined, geminiConfigured: boolean): NewProspect {
  if (outcome?.ok) return { ...base, ...outcome.value }
  return {
    ...base,
    analysisStatus: geminiConfigured ? 'failed' : 'skipped',
    analysisError: outcome ? outcome.error : geminiConfigured ? 'Not analysed.' : 'Gemini is not configured on the server.',
  }
}

export async function runDiscovery(userId: string, input: DiscoveryInput, deps: Deps = defaultDeps): Promise<DiscoveryResult> {
  const config = getConfig()
  if (!config.placesApiKey) throw new ConfigError('Discovery is not available: GOOGLE_PLACES_API_KEY is not configured on the server.')
  const runId = await startDiscovery(userId, { businessType: input.businessType, location: input.location, focus: input.focus }, config.discoveryDailyLimit)
  const warnings: string[] = []
  try {
    const profile = await getSettings(userId)
    const places = await deps.searchPlaces({ businessType: input.businessType, location: input.location, maxResults: input.maxResults, apiKey: config.placesApiKey })
    const now = new Date().toISOString()

    // Build candidates and de-duplicate within this result set (by website domain, then place id).
    const byKey = new Map<string, { place: PlaceCandidate; domain: string; key: string }>()
    for (const place of places) {
      const domain = normalizeDomain(place.websiteUri) ?? ''
      const key = dedupeKey({ domain, placeId: place.placeId, name: place.name, address: place.address })
      if (!byKey.has(key)) byKey.set(key, { place, domain, key })
    }
    const existing = await findExistingKeys(userId, [...byKey.keys()])
    const fresh = [...byKey.values()].filter((c) => !existing.has(c.key))

    // Fetch real website content (SSRF-guarded) for new prospects that have a website.
    const snapshots = await mapLimit(fresh, 5, async (c) => {
      if (!c.domain || !c.place.websiteUri) return { snapshot: null as PageSnapshot | null, error: null as string | null }
      try {
        return { snapshot: await deps.fetchSnapshot(c.place.websiteUri), error: null }
      } catch (error) {
        return { snapshot: null, error: error instanceof Error ? error.message : 'Could not fetch website.' }
      }
    })

    const candidates: AnalysisCandidate[] = fresh.map((c, i) => ({
      key: `c${i + 1}`,
      name: c.place.name,
      category: c.place.category,
      address: c.place.address,
      websiteUrl: c.domain ? c.place.websiteUri : null,
      providerEvidence: providerEvidence(c.place, c.domain, now),
      snapshot: snapshots[i].snapshot,
      snapshotError: snapshots[i].error,
    }))

    let outcomes = new Map<string, Outcome>()
    if (candidates.length > 0 && config.geminiApiKey) {
      outcomes = await deps.analyze(candidates, { profile, intent: { businessType: input.businessType, location: input.location, focus: input.focus }, apiKey: config.geminiApiKey, model: config.geminiModel })
    } else if (candidates.length > 0) {
      warnings.push('GEMINI_API_KEY is not configured, so prospects were saved without analysis or ranking.')
    }

    const rows: NewProspect[] = fresh.map((c, i) => {
      const cand = candidates[i]
      const base: NewProspect = {
        name: c.place.name,
        domain: c.domain,
        websiteUrl: c.domain ? (c.place.websiteUri as string) : '',
        category: c.place.category,
        location: input.location,
        address: c.place.address,
        sourceProvider: 'google_places',
        sourceUrl: c.place.mapsUrl,
        providerPlaceId: c.place.placeId,
        dedupeKey: c.key,
        evidence: cand.snapshotError ? `Website could not be read: ${cand.snapshotError}` : '',
        evidenceItems: cand.providerEvidence,
        verificationStatus: 'unverified',
        analysisStatus: 'pending',
        discoveryId: runId,
      }
      return outcomeToProspect(base, outcomes.get(cand.key), Boolean(config.geminiApiKey))
    })

    const { inserted } = await insertProspects(userId, rows)
    const analyzed = rows.filter((r) => r.analysisStatus === 'analyzed').length
    const failed = rows.filter((r) => r.analysisStatus === 'failed').length
    if (failed > 0) {
      const firstError = rows.find((r) => r.analysisStatus === 'failed')?.analysisError
      warnings.push(`Gemini analysis failed for ${failed} prospect${failed === 1 ? '' : 's'}${firstError ? ` (${firstError})` : ''}. You can retry with “Analyse” on each prospect.`)
    }
    const noSite = snapshots.filter((s) => s.error).length
    if (noSite > 0) warnings.push(`${noSite} website${noSite === 1 ? '' : 's'} could not be read, so those prospects have no website evidence.`)
    await finishDiscovery(userId, runId, { status: 'completed', found: byKey.size, added: inserted, analyzed })
    return { discoveryId: runId, found: byKey.size, added: inserted, alreadyInList: byKey.size - fresh.length, analyzed, analysisFailed: failed, warnings }
  } catch (error) {
    const message = error instanceof ProviderError || error instanceof HttpError ? error.message : 'Discovery failed unexpectedly.'
    await finishDiscovery(userId, runId, { status: 'failed', found: 0, added: 0, analyzed: 0, error: message }).catch(() => {})
    if (error instanceof ProviderError) throw new HttpError(message, 502)
    throw error
  }
}

/** (Re-)analyses one existing prospect: fetches its website and asks Gemini. Always scoped to the owner. */
export async function analyzeExistingProspect(userId: string, id: string, deps: Pick<Deps, 'fetchSnapshot' | 'analyze'> = defaultDeps): Promise<Prospect> {
  const config = getConfig()
  if (!config.geminiApiKey) throw new ConfigError('Analysis is not available: GEMINI_API_KEY is not configured on the server.')
  const prospect = await getProspect(userId, id)
  if (!prospect) throw new HttpError('Prospect not found.', 404)
  const profile = await getSettings(userId)
  let snapshot: PageSnapshot | null = null
  let snapshotError: string | null = null
  if (prospect.websiteUrl) {
    try {
      snapshot = await deps.fetchSnapshot(prospect.websiteUrl)
    } catch (error) {
      snapshotError = error instanceof Error ? error.message : 'Could not fetch website.'
    }
  } else snapshotError = 'No website on record.'
  const candidate: AnalysisCandidate = {
    key: 'c1',
    name: prospect.name,
    category: prospect.category,
    address: prospect.address,
    websiteUrl: prospect.websiteUrl || null,
    providerEvidence: prospect.evidenceItems.filter((e) => e.kind === 'provider'),
    snapshot,
    snapshotError,
  }
  const outcome = (await deps.analyze([candidate], { profile, intent: { businessType: prospect.category, location: prospect.location, focus: 'Re-analysis of an existing prospect' }, apiKey: config.geminiApiKey, model: config.geminiModel })).get('c1')
  if (!outcome?.ok) {
    const error = outcome ? outcome.error : 'Analysis failed.'
    await applyAnalysis(userId, id, { score: prospect.score, priority: prospect.priority, reason: prospect.reason, evidence: prospect.evidence, evidenceItems: prospect.evidenceItems, nextAction: prospect.nextAction, verificationStatus: prospect.verificationStatus, analysisStatus: 'failed', analysisError: error, aiModel: null })
    throw new HttpError(`Analysis failed: ${error}`, 502)
  }
  const updated = await applyAnalysis(userId, id, outcome.value)
  if (!updated) throw new HttpError('Prospect not found.', 404)
  return updated
}
