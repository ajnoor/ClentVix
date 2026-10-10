import { randomUUID } from 'node:crypto'
import { query, withTransaction } from './db'
import { HttpError } from './errors'
import type { DiscoveryRun, UserSettings } from './types'

// ---- Settings (one row per user) ----------------------------------------------------------------

const EMPTY: UserSettings = { serviceName: '', valueProposition: '', defaultBusinessType: '', defaultLocation: '' }

type SettingsRow = { service_name: string; value_proposition: string; default_business_type: string; default_location: string }

export async function getSettings(userId: string): Promise<UserSettings> {
  const result = await query<SettingsRow>(
    `SELECT service_name, value_proposition, default_business_type, default_location FROM clentvix_user_settings WHERE user_id = $1`,
    [userId],
  )
  const row = result.rows[0]
  if (!row) return { ...EMPTY }
  return {
    serviceName: row.service_name,
    valueProposition: row.value_proposition,
    defaultBusinessType: row.default_business_type,
    defaultLocation: row.default_location,
  }
}

export async function saveSettings(userId: string, s: UserSettings): Promise<UserSettings> {
  await query(
    `INSERT INTO clentvix_user_settings (user_id, service_name, value_proposition, default_business_type, default_location)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE SET service_name = EXCLUDED.service_name, value_proposition = EXCLUDED.value_proposition,
       default_business_type = EXCLUDED.default_business_type, default_location = EXCLUDED.default_location, updated_at = now()`,
    [userId, s.serviceName, s.valueProposition, s.defaultBusinessType, s.defaultLocation],
  )
  return getSettings(userId)
}

// ---- Discovery runs (also the source of truth for notifications) --------------------------------

type RunRow = {
  id: string
  business_type: string
  location: string
  focus: string
  status: string
  found_count: number
  new_count: number
  analyzed_count: number
  error: string | null
  created_at: Date
  completed_at: Date | null
  unread: boolean
}

export async function listDiscoveries(userId: string, limit = 10): Promise<DiscoveryRun[]> {
  const result = await query<RunRow>(
    `SELECT d.id, d.business_type, d.location, d.focus, d.status, d.found_count, d.new_count, d.analyzed_count, d.error,
            d.created_at, d.completed_at,
            (d.status <> 'running' AND d.created_at > COALESCE(s.notifications_seen_at, 'epoch'::timestamptz)) AS unread
       FROM clentvix_discoveries d
       LEFT JOIN clentvix_user_settings s ON s.user_id = d.user_id
      WHERE d.user_id = $1
      ORDER BY d.created_at DESC
      LIMIT $2`,
    [userId, limit],
  )
  return result.rows.map((r) => ({
    id: r.id,
    businessType: r.business_type,
    location: r.location,
    focus: r.focus,
    status: r.status as DiscoveryRun['status'],
    foundCount: r.found_count,
    newCount: r.new_count,
    analyzedCount: r.analyzed_count,
    error: r.error,
    createdAt: r.created_at.toISOString(),
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    unread: r.unread,
  }))
}

export async function markNotificationsSeen(userId: string) {
  await query(
    `INSERT INTO clentvix_user_settings (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET notifications_seen_at = now()`,
    [userId],
  )
}

export class DiscoveryLimitError extends HttpError {
  constructor(message: string) {
    super(message, 429)
    this.name = 'DiscoveryLimitError'
  }
}

/**
 * Atomically enforces: one running discovery per user (stale after 5 min) and a rolling 24h quota,
 * then records the new run. A per-user advisory lock makes check-and-insert race-free.
 */
export async function startDiscovery(userId: string, input: { businessType: string; location: string; focus: string }, dailyLimit: number) {
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`discovery:${userId}`])
    const running = await client.query(
      `SELECT 1 FROM clentvix_discoveries WHERE user_id = $1 AND status = 'running' AND created_at > now() - interval '5 minutes' LIMIT 1`,
      [userId],
    )
    if (running.rowCount) throw new DiscoveryLimitError('A discovery is already running. Please wait for it to finish.')
    const recent = await client.query(
      `SELECT count(*)::int AS n FROM clentvix_discoveries WHERE user_id = $1 AND created_at > now() - interval '24 hours'`,
      [userId],
    )
    if (recent.rows[0].n >= dailyLimit) throw new DiscoveryLimitError(`Daily discovery limit reached (${dailyLimit} per 24 hours).`)
    const id = randomUUID()
    await client.query(
      `INSERT INTO clentvix_discoveries (id, user_id, business_type, location, focus, status) VALUES ($1,$2,$3,$4,$5,'running')`,
      [id, userId, input.businessType, input.location, input.focus],
    )
    return id
  })
}

export async function finishDiscovery(
  userId: string,
  id: string,
  result: { status: 'completed' | 'failed'; found: number; added: number; analyzed: number; error?: string | null },
) {
  await query(
    `UPDATE clentvix_discoveries
        SET status = $3, found_count = $4, new_count = $5, analyzed_count = $6, error = $7, completed_at = now()
      WHERE id = $1 AND user_id = $2`,
    [id, userId, result.status, result.found, result.added, result.analyzed, result.error ?? null],
  )
}
