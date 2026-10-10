import { Pool, type PoolClient, type QueryResultRow } from 'pg'

const globalForDb = globalThis as unknown as { clentvixPool?: Pool }

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL)
}

/** Lazily created so `next build` (which imports route modules) does not need DATABASE_URL. */
export function getPool(): Pool {
  if (globalForDb.clentvixPool) return globalForDb.clentvixPool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is not configured.')
  const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 })
  pool.on('error', (error) => console.error('[db] idle client error', error.message))
  globalForDb.clentvixPool = pool
  return pool
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
  return getPool().query<T>(text, params)
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function closePool() {
  if (globalForDb.clentvixPool) {
    await globalForDb.clentvixPool.end()
    globalForDb.clentvixPool = undefined
  }
}
