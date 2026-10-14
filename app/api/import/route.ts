import { authed, json, readTextCapped } from '@/lib/session'
import { HttpError } from '@/lib/errors'
import { CSV_LIMITS, CsvError, parseProspectCsv } from '@/lib/csv'
import { dedupeKey, websiteUrlForDomain } from '@/lib/domain'
import { insertProspects, type NewProspect } from '@/lib/prospects'

export const POST = authed(async ({ user, request }) => {
  const text = await readTextCapped(request, CSV_LIMITS.maxBytes)

  let parsed: ReturnType<typeof parseProspectCsv>
  try {
    parsed = parseProspectCsv(text)
  } catch (error) {
    if (error instanceof CsvError) {
      throw new HttpError(error.message, 400)
    }
    throw error
  }

  const rows: NewProspect[] = parsed.rows.map((row) => ({
    name: row.name,
    domain: row.domain,
    websiteUrl: websiteUrlForDomain(row.domain),
    category: row.category,
    location: row.location,
    sourceProvider: 'csv_import',
    sourceUrl: websiteUrlForDomain(row.domain),
    dedupeKey: dedupeKey({ domain: row.domain, name: row.name }),
  }))

  const result = await insertProspects(user.id, rows)

  return json({
    imported: result.inserted,
    skipped: result.skipped,
    errors: parsed.errors,
    totalRows: parsed.totalRows,
  })
})
