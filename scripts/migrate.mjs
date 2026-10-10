// Applies ./migrations/*.sql in filename order, once each, inside a transaction.
// Usage: pnpm db:migrate   (reads DATABASE_URL from the environment or .env.local)
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  // Serialise concurrent runs.
  await client.query('SELECT pg_advisory_lock(727274)')
  await client.query(
    'CREATE TABLE IF NOT EXISTS clentvix_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  )
  const applied = new Set((await client.query('SELECT name FROM clentvix_schema_migrations')).rows.map((r) => r.name))
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip   ${file}`)
      continue
    }
    const sql = await readFile(path.join(dir, file), 'utf8')
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO clentvix_schema_migrations (name) VALUES ($1)', [file])
      await client.query('COMMIT')
      console.log(`apply  ${file}`)
    } catch (error) {
      await client.query('ROLLBACK')
      console.error(`FAILED ${file}:`, error instanceof Error ? error.message : error)
      process.exitCode = 1
      break
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {})
  await client.end()
}
