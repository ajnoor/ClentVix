import { normalizeDomain } from './domain'

export const CSV_LIMITS = { maxBytes: 1_000_000, maxRows: 1000, maxColumns: 30, maxCell: 2000 }

export class CsvError extends Error {}

/** RFC 4180 parser: quoted fields, escaped quotes (""), embedded commas and newlines, CRLF/LF/CR, BOM. */
export function parseCsv(input: string): string[][] {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  if (text.includes('\u0000')) throw new CsvError('CSV contains binary data.')
  text = text.replace(/\r\n?/g, '\n')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let cellWasQuoted = false
  const pushCell = () => {
    if (cell.length > CSV_LIMITS.maxCell) throw new CsvError(`A cell exceeds ${CSV_LIMITS.maxCell} characters.`)
    row.push(cellWasQuoted ? cell : cell.trim())
    cell = ''
    cellWasQuoted = false
    if (row.length > CSV_LIMITS.maxColumns) throw new CsvError(`Too many columns (max ${CSV_LIMITS.maxColumns}).`)
  }
  const pushRow = () => {
    pushCell()
    if (!(row.length === 1 && row[0] === '')) rows.push(row) // skip blank lines
    row = []
    if (rows.length > CSV_LIMITS.maxRows + 1) throw new CsvError(`Too many rows (max ${CSV_LIMITS.maxRows}).`)
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else inQuotes = false
      } else cell += ch
    } else if (ch === '"' && cell.trim() === '') {
      inQuotes = true
      cellWasQuoted = true
      cell = ''
    } else if (ch === ',') pushCell()
    else if (ch === '\n') pushRow()
    else cell += ch
  }
  if (inQuotes) throw new CsvError('Unterminated quoted field.')
  if (cell !== '' || row.length > 0) pushRow()
  return rows
}

const ALIASES: Record<'name' | 'domain' | 'category' | 'location', string[]> = {
  name: ['name', 'business', 'business name', 'company', 'company name'],
  domain: ['domain', 'website', 'url', 'site', 'web', 'website url'],
  category: ['category', 'type', 'industry', 'business type'],
  location: ['location', 'city', 'address', 'region'],
}

export type ImportRow = { name: string; domain: string; category: string; location: string }
export type ImportParse = { rows: ImportRow[]; errors: string[]; totalRows: number }

function clean(value: string, max: number) {
  // Strip control characters; keep text as data (rendered escaped by React, never as HTML).
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function parseProspectCsv(text: string): ImportParse {
  const table = parseCsv(text)
  if (table.length < 2) throw new CsvError('CSV needs a header row and at least one data row.')
  const headers = table[0].map((h) => h.toLowerCase().trim())
  const index: Partial<Record<keyof typeof ALIASES, number>> = {}
  for (const key of Object.keys(ALIASES) as Array<keyof typeof ALIASES>) {
    const found = headers.findIndex((h) => ALIASES[key].includes(h))
    if (found >= 0) index[key] = found
  }
  if (index.name === undefined || index.domain === undefined) {
    throw new CsvError('Required columns: name and domain (or website / url).')
  }
  const rows: ImportRow[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  table.slice(1).forEach((cells, i) => {
    const line = i + 2
    const name = clean(cells[index.name!] ?? '', 200)
    const domain = normalizeDomain(cells[index.domain!] ?? '')
    if (!name) return void errors.push(`Row ${line}: missing name.`)
    if (!domain) return void errors.push(`Row ${line}: "${clean(cells[index.domain!] ?? '', 60)}" is not a valid public domain.`)
    if (seen.has(domain)) return void errors.push(`Row ${line}: duplicate domain ${domain} in this file.`)
    seen.add(domain)
    rows.push({
      name,
      domain,
      category: clean(index.category === undefined ? '' : (cells[index.category] ?? ''), 160) || 'Unknown',
      location: clean(index.location === undefined ? '' : (cells[index.location] ?? ''), 160) || 'Unknown',
    })
  })
  return { rows, errors: errors.slice(0, 50), totalRows: table.length - 1 }
}
