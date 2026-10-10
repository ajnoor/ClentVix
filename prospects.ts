import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { query, withTransaction } from './db'
import type { EvidenceItem, Priority, Prospect, Stage } from './types'

/**
 * Data access for prospects. SECURITY INVARIANT: every function takes the authenticated user's id
 * and every statement filters / inserts on user_id. There is no code path that reads or writes a
 * prospect without it, and SQL is always parameterised (no identifiers are built from input).
 */

const COLUMNS = `id, name, domain, website_url, category, location, address, score, priority, stage, saved, reason, evidence,
  evidence_items, next_action, source_provider, source_url, verification_status, analysis_status, analysis_error,
  analyzed_at, created_at, updated_at`

type Row = {
  id: string
  name: string
  domain: string
  website_url: string
  category: string
  location: string
  address: string | null
  score: number | null
  priority: string | null
  stage: string
  saved: boolean
  reason: string
  evidence: string
  evidence_items: EvidenceItem[] | null
  next_action: string
  source_provider: string
  source_url: string | null
  verification_status: string
  analysis_status: string
  analysis_error: string | null
  analyzed_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : new Date(value).toISOString())

export function mapRow(row: Row): Prospect {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    websiteUrl: row.website_url,
    category: row.category,
    location: row.location,
    address: row.address,
    score: row.score,
    priority: (row.priority as Priority | null) ?? null,
    stage: row.stage as Stage,
    saved: row.saved,
    reason: row.reason,
    evidence: row.evidence,
    evidenceItems: Array.isArray(row.evidence_items) ? row.evidence_items : [],
    nextAction: row.next_action,
    sourceProvider: row.source_provider,
    sourceUrl: row.source_url,
    verificationStatus: row.verification_status === 'verified' ? 'verified' : 'unverified',
    analysisStatus: (['pending', 'analyzed', 'failed', 'skipped'].includes(row.analysis_status) ? row.analysis_status : 'pending') as Prospect['analysisStatus'],
    analysisError: row.analysis_error,
    analyzedAt: row.analyzed_at ? iso(row.analyzed_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export async function listProspects(userId: string, limit = 1000): Promise<Prospect[]> {
  const result = await query<Row>(
    `SELECT ${COLUMNS} FROM clentvix_prospects
     WHERE user_id = $1 AND is_demo = false
     ORDER BY score DESC NULLS LAST, created_at DESC
     LIMIT $2`,
    [userId, limit],
  )
  return result.rows.map(mapRow)
}

export async function getProspect(userId: string, id: string): Promise<Prospect | null> {
  const result = await query<Row>(`SELECT ${COLUMNS} FROM clentvix_prospects WHERE id = $1 AND user_id = $2 AND is_demo = false`, [id, userId])
  return result.rows[0] ? mapRow(result.rows[0]) : null
}

export async function updateProspect(userId: string, id: string, patch: { stage?: Stage; saved?: boolean }): Promise<Prospect | null> {
  const result = await query<Row>(
    `UPDATE clentvix_prospects
        SET stage = COALESCE($3, stage), saved = COALESCE($4, saved), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND is_demo = false
      RETURNING ${COLUMNS}`,
    [id, userId, patch.stage ?? null, patch.saved ?? null],
  )
  return result.rows[0] ? mapRow(result.rows[0]) : null
}

export async function deleteProspect(userId: string, id: string): Promise<boolean> {
  const result = await query(`DELETE FROM clentvix_prospects WHERE id = $1 AND user_id = $2`, [id, userId])
  return (result.rowCount ?? 0) > 0
}

export async function findExistingKeys(userId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set()
  const result = await query<{ dedupe_key: string }>(
    `SELECT dedupe_key FROM clentvix_prospects WHERE user_id = $1 AND dedupe_key = ANY($2::text[])`,
    [userId, keys],
  )
  return new Set(result.rows.map((r) => r.dedupe_key))
}

export type NewProspect = {
  name: string
  domain: string
  websiteUrl: string
  category: string
  location: string
  address?: string | null
  sourceProvider: string
  sourceUrl?: string | null
  providerPlaceId?: string | null
  dedupeKey: string
  score?: number | null
  priority?: Priority | null
  reason?: string
  evidence?: string
  evidenceItems?: EvidenceItem[]
  nextAction?: string
  verificationStatus?: 'verified' | 'unverified'
  analysisStatus?: Prospect['analysisStatus']
  analysisError?: string | null
  aiModel?: string | null
  discoveryId?: string | null
}

async function insertOne(client: PoolClient, userId: string, p: NewProspect) {
  const result = await client.query(
    `INSERT INTO clentvix_prospects
       (id, user_id, name, domain, website_url, category, location, address, source_provider, source_url, provider_place_id,
        dedupe_key, score, priority, reason, evidence, evidence_items, next_action, verification_status, analysis_status,
        analysis_error, analyzed_at, ai_model, discovery_id, is_demo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,
             CASE WHEN $20 = 'analyzed' THEN now() ELSE NULL END, $22, $23, false)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
    [
      randomUUID(),
      userId,
      p.name.slice(0, 200),
      p.domain,
      p.websiteUrl,
      p.category.slice(0, 160),
      p.location.slice(0, 160),
      p.address ?? null,
      p.sourceProvider,
      p.sourceUrl ?? null,
      p.providerPlaceId ?? null,
      p.dedupeKey,
      p.score ?? null,
      p.priority ?? null,
      p.reason ?? '',
      p.evidence ?? '',
      JSON.stringify(p.evidenceItems ?? []),
      p.nextAction ?? '',
      p.verificationStatus ?? 'unverified',
      p.analysisStatus ?? 'pending',
      p.analysisError ?? null,
      p.aiModel ?? null,
      p.discoveryId ?? null,
    ],
  )
  return (result.rowCount ?? 0) > 0
}

/** Inserts new prospects for this user; rows whose dedupe key already exists are left untouched. */
export async function insertProspects(userId: string, items: NewProspect[]): Promise<{ inserted: number; skipped: number }> {
  return withTransaction(async (client) => {
    let inserted = 0
    for (const item of items) if (await insertOne(client, userId, item)) inserted += 1
    return { inserted, skipped: items.length - inserted }
  })
}

export type AnalysisUpdate = {
  score: number | null
  priority: Priority | null
  reason: string
  evidence: string
  evidenceItems: EvidenceItem[]
  nextAction: string
  verificationStatus: 'verified' | 'unverified'
  analysisStatus: 'analyzed' | 'failed' | 'skipped'
  analysisError: string | null
  aiModel: string | null
}

export async function applyAnalysis(userId: string, id: string, a: AnalysisUpdate): Promise<Prospect | null> {
  const result = await query<Row>(
    `UPDATE clentvix_prospects
        SET score = $3, priority = $4, reason = $5, evidence = $6, evidence_items = $7::jsonb, next_action = $8,
            verification_status = $9, analysis_status = $10, analysis_error = $11, ai_model = $12,
            analyzed_at = CASE WHEN $10 = 'analyzed' THEN now() ELSE analyzed_at END, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND is_demo = false
      RETURNING ${COLUMNS}`,
    [id, userId, a.score, a.priority, a.reason, a.evidence, JSON.stringify(a.evidenceItems), a.nextAction, a.verificationStatus, a.analysisStatus, a.analysisError, a.aiModel],
  )
  return result.rows[0] ? mapRow(result.rows[0]) : null
}
