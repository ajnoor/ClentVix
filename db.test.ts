import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('database layer against real PostgreSQL (providers stubbed, DB real)', () => {
  const A = `user-a-${randomUUID()}`
  const B = `user-b-${randomUUID()}`
  let P: typeof import('@/lib/prospects')
  let S: typeof import('@/lib/settings')
  let D: typeof import('@/lib/discovery')
  let db: typeof import('@/lib/db')

  beforeAll(async () => {
    process.env.DATABASE_URL = url
    process.env.GOOGLE_PLACES_API_KEY = 'test-places'
    process.env.GEMINI_API_KEY = 'test-gemini'
    process.env.DISCOVERY_DAILY_LIMIT = '3'
    db = await import('@/lib/db'); P = await import('@/lib/prospects'); S = await import('@/lib/settings'); D = await import('@/lib/discovery')
  })
  afterAll(async () => {
    await db.query('DELETE FROM clentvix_prospects WHERE user_id = ANY($1)', [[A, B]])
    await db.query('DELETE FROM clentvix_discoveries WHERE user_id = ANY($1)', [[A, B]])
    await db.query('DELETE FROM clentvix_user_settings WHERE user_id = ANY($1)', [[A, B]])
    await db.closePool()
  })

  const mk = (domain: string, name = domain) => ({ name, domain, websiteUrl: `https://${domain}`, category: 'c', location: 'l', sourceProvider: 'csv_import', dedupeKey: `d:${domain}` })

  it('isolates prospects between users for list/get/update/delete/analysis', async () => {
    await P.insertProspects(A, [mk('alpha.com')])
    await P.insertProspects(B, [mk('beta.com')])
    const [a] = await P.listProspects(A)
    const [b] = await P.listProspects(B)
    expect(a.domain).toBe('alpha.com'); expect(b.domain).toBe('beta.com')
    expect(await P.getProspect(B, a.id)).toBeNull()
    expect(await P.updateProspect(B, a.id, { stage: 'Converted' })).toBeNull()
    expect(await P.deleteProspect(B, a.id)).toBe(false)
    expect(await P.applyAnalysis(B, a.id, { score: 99, priority: 'High', reason: 'x', evidence: 'x', evidenceItems: [], nextAction: 'x', verificationStatus: 'verified', analysisStatus: 'analyzed', analysisError: null, aiModel: 'm' })).toBeNull()
    const still = await P.getProspect(A, a.id)
    expect(still).toMatchObject({ stage: 'New', score: null })
    expect((await P.listProspects(B)).map((p) => p.domain)).toEqual(['beta.com'])
  })
  it('SQL-injection-shaped ids/keys are inert', async () => {
    expect(await P.getProspect(A, "' OR 1=1 --")).toBeNull()
    expect((await P.findExistingKeys(A, ["d:x' OR '1'='1"])).size).toBe(0)
    await P.insertProspects(A, [mk('inj.com', "Robert'); DROP TABLE clentvix_prospects;--")])
    expect((await P.listProspects(A)).some((p) => p.name.startsWith('Robert'))).toBe(true)
  })
  it('deduplicates per user but allows the same domain for different users', async () => {
    const r1 = await P.insertProspects(A, [mk('dup.com')])
    const r2 = await P.insertProspects(A, [mk('dup.com')])
    const r3 = await P.insertProspects(B, [mk('dup.com')])
    expect([r1.inserted, r2.inserted, r2.skipped, r3.inserted]).toEqual([1, 0, 1, 1])
  })
  it('stage/saved updates and delete work for the owner', async () => {
    const p = (await P.listProspects(A)).find((x) => x.domain === 'dup.com')!
    expect(await P.updateProspect(A, p.id, { stage: 'Contacted', saved: true })).toMatchObject({ stage: 'Contacted', saved: true })
    expect(await P.deleteProspect(A, p.id)).toBe(true)
  })
  it('legacy rows (user_id NULL, default-workspace) are invisible to every user', async () => {
    await db.query(`INSERT INTO clentvix_prospects (id, user_id, name, source_provider) VALUES ($1, NULL, 'legacy', 'demo')`, [`legacy-${A}`]).catch(() => {})
    expect((await P.listProspects(A)).some((p) => p.name === 'legacy')).toBe(false)
    expect((await P.listProspects('default-workspace')).length).toBe(0)
  })
  it('DB refuses a new row without user_id', async () => {
    await expect(db.query(`INSERT INTO clentvix_prospects (id, name, domain, website_url, category, location, source_provider, verification_status) VALUES ('nouser','n','d','w','c','l','p','unverified')`)).rejects.toThrow(/user_required|violates check/)
  })
  it('settings are per user', async () => {
    await S.saveSettings(A, { serviceName: 'A-svc', valueProposition: 'v', defaultBusinessType: '', defaultLocation: '' })
    expect((await S.getSettings(A)).serviceName).toBe('A-svc')
    expect((await S.getSettings(B)).serviceName).toBe('')
  })

  const place = (n: number, site = true) => ({ placeId: `pid-${n}`, name: `Biz ${n}`, address: `${n} High St`, websiteUri: site ? `https://biz${n}.example.com/` : null, mapsUrl: `https://maps.google.com/?cid=${n}`, category: 'Dentist', rating: 4.2, ratingCount: 10 })
  const snap = (url: string) => ({ url, status: 200, fetchedAt: new Date().toISOString(), title: 'T', description: '', headings: [], text: 'We offer family dentistry in town', signals: { isHttps: true, hasViewportMeta: true, hasMetaDescription: false, phoneLinks: 0, emailLinks: 0, forms: 0, actionLinkTexts: [] }, truncated: false })
  it('end-to-end discovery (stubbed providers) persists, dedupes, scopes and records runs', async () => {
    const calls = { analyzed: 0 }
    const deps: Parameters<typeof D.runDiscovery>[2] = {
      searchPlaces: async () => [place(1), place(2), place(3, false), place(1)],
      fetchSnapshot: async (u) => { if (u.includes('biz2')) throw new Error('Website returned HTTP 500.'); return snap(u) },
      analyze: async (cands) => { calls.analyzed += cands.length; return new Map(cands.map((c) => [c.key, { ok: true as const, value: { score: 80, priority: 'High' as const, reason: 'r', evidence: 'e', evidenceItems: c.providerEvidence, nextAction: 'n', verificationStatus: 'unverified' as const, analysisStatus: 'analyzed' as const, analysisError: null, aiModel: 'm' } }])) },
    }
    const r1 = await D.runDiscovery(A, { businessType: 'dentist', location: 'Town', focus: 'x', maxResults: 10 }, deps)
    expect(r1).toMatchObject({ found: 3, added: 3, alreadyInList: 0, analyzed: 3 })
    expect(r1.warnings.join(' ')).toMatch(/1 website could not be read/)
    const list = await P.listProspects(A)
    const biz = list.filter((p) => p.sourceProvider === 'google_places')
    expect(biz).toHaveLength(3)
    expect(biz.find((p) => p.name === 'Biz 3')).toMatchObject({ domain: '', websiteUrl: '' })
    expect(biz.find((p) => p.name === 'Biz 1')!.evidenceItems[0]).toMatchObject({ kind: 'provider', sourceUrl: 'https://maps.google.com/?cid=1' })
    // second run: everything already known -> no re-analysis, nothing duplicated
    const before = calls.analyzed
    const r2 = await D.runDiscovery(A, { businessType: 'dentist', location: 'Town', focus: 'x', maxResults: 10 }, deps)
    expect(r2).toMatchObject({ added: 0, alreadyInList: 3 }); expect(calls.analyzed).toBe(before)
    // user B has none of A's data and gets their own copy
    expect((await P.listProspects(B)).filter((p) => p.sourceProvider === 'google_places')).toHaveLength(0)
    const rb = await D.runDiscovery(B, { businessType: 'dentist', location: 'Town', focus: 'x', maxResults: 10 }, deps)
    expect(rb.added).toBe(3)
    const runs = await S.listDiscoveries(A)
    expect(runs).toHaveLength(2); expect(runs.every((r) => r.status === 'completed')).toBe(true)
  })
  it('enforces the daily quota and records provider failures as failed runs', async () => {
    const deps: Parameters<typeof D.runDiscovery>[2] = { searchPlaces: async () => { const { ProviderError } = await import('@/lib/places'); throw new ProviderError('Google Places returned 403: key invalid', 403) }, fetchSnapshot: async () => { throw new Error('x') }, analyze: async () => new Map() }
    await expect(D.runDiscovery(A, { businessType: 'x', location: 'y', focus: 'z', maxResults: 5 }, deps)).rejects.toMatchObject({ status: 502 })
    await expect(D.runDiscovery(A, { businessType: 'x', location: 'y', focus: 'z', maxResults: 5 }, deps)).rejects.toMatchObject({ status: 429 })
    const runs = await S.listDiscoveries(A)
    expect(runs[0]).toMatchObject({ status: 'failed' }); expect(runs[0].error).toContain('403')
  })
  it('unread notification flag clears after markNotificationsSeen', async () => {
    expect((await S.listDiscoveries(B)).some((r) => r.unread)).toBe(true)
    await S.markNotificationsSeen(B)
    expect((await S.listDiscoveries(B)).some((r) => r.unread)).toBe(false)
  })
  it('analyzeExistingProspect only touches the owner\'s prospect', async () => {
    const mine = (await P.listProspects(A))[0]
    const deps = { fetchSnapshot: async (u: string) => snap(u), analyze: async (c: { key: string }[]) => new Map(c.map((x) => [x.key, { ok: true as const, value: { score: 70, priority: 'Medium' as const, reason: 'rr', evidence: 'ee', evidenceItems: [], nextAction: 'nn', verificationStatus: 'unverified' as const, analysisStatus: 'analyzed' as const, analysisError: null, aiModel: 'm' } }])) }
    await expect(D.analyzeExistingProspect(B, mine.id, deps as never)).rejects.toMatchObject({ status: 404 })
    expect(await D.analyzeExistingProspect(A, mine.id, deps as never)).toMatchObject({ score: 70, reason: 'rr' })
  })
})
