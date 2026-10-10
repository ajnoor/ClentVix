import { describe, expect, it } from 'vitest'
import { CsvError, parseCsv, parseProspectCsv } from '@/lib/csv'
import { dedupeKey, normalizeDomain } from '@/lib/domain'

describe('normalizeDomain', () => {
  it.each([
    ['https://www.Example.co.uk/path?x=1', 'example.co.uk'],
    ['example.com', 'example.com'],
    ['HTTP://Sub.Example.com:8080/a', 'sub.example.com'],
    ['  www.foo-bar.io.  ', 'foo-bar.io'],
  ])('%s -> %s', (input, expected) => expect(normalizeDomain(input)).toBe(expected))
  it.each(['', 'localhost', '127.0.0.1', '[::1]', 'http://10.0.0.1', 'intranet', 'javascript:alert(1)', 'ftp://example.com', 'exa mple.com', 'a..com', '-bad.com', 'foo.c', 'user:pw@example.com', 'x'.repeat(300) + '.com'])('rejects %j', (input) => expect(normalizeDomain(input)).toBeNull())
})

describe('dedupeKey', () => {
  it('prefers domain, then place id, then name+address', () => {
    expect(dedupeKey({ domain: 'a.com', placeId: 'p', name: 'A' })).toBe('d:a.com')
    expect(dedupeKey({ domain: '', placeId: 'p1', name: 'A' })).toBe('p:p1')
    expect(dedupeKey({ domain: '', name: 'Café  Röse!', address: '1 Main St.' })).toBe('n:cafe rose|1 main st')
  })
})

describe('parseCsv (RFC 4180)', () => {
  it('handles quoted commas, escaped quotes, embedded newlines, CRLF and BOM', () => {
    const rows = parseCsv('﻿name,domain,note\r\n"Smith, Jones & Co","smith.com","He said ""hi""\nsecond line"\r\nPlain,plain.com,\r\n')
    expect(rows).toEqual([
      ['name', 'domain', 'note'],
      ['Smith, Jones & Co', 'smith.com', 'He said "hi"\nsecond line'],
      ['Plain', 'plain.com', ''],
    ])
  })
  it('rejects unterminated quotes, binary and oversized structures', () => {
    expect(() => parseCsv('a,b\n"oops,1')).toThrow(CsvError)
    expect(() => parseCsv('a,b\n\u0000,1')).toThrow(CsvError)
    expect(() => parseCsv('a\n' + 'x\n'.repeat(1100))).toThrow(/Too many rows/)
    expect(() => parseCsv(Array.from({ length: 40 }, (_, i) => `c${i}`).join(','))).toThrow(/Too many columns/)
    expect(() => parseCsv('a\n' + 'x'.repeat(2500))).toThrow(/cell exceeds/)
  })
})

describe('parseProspectCsv', () => {
  it('maps header aliases, normalises domains, reports bad rows and in-file duplicates', () => {
    const r = parseProspectCsv('Business Name,Website,Industry,City\n"Acme, Ltd",https://www.acme.com/x,Plumbing,Leeds\nBad,not a domain,,\n,nonamed.com,,\nDup,ACME.com,,\nLocal,http://127.0.0.1,,\nOk,ok.org,,')
    expect(r.rows).toEqual([
      { name: 'Acme, Ltd', domain: 'acme.com', category: 'Plumbing', location: 'Leeds' },
      { name: 'Ok', domain: 'ok.org', category: 'Unknown', location: 'Unknown' },
    ])
    expect(r.errors).toHaveLength(4)
    expect(r.totalRows).toBe(6)
  })
  it('requires name and domain columns', () => {
    expect(() => parseProspectCsv('foo,bar\n1,2')).toThrow(/Required columns/)
    expect(() => parseProspectCsv('name,domain')).toThrow(/at least one data row/)
  })
  it('strips control characters from text cells', () => {
    const r = parseProspectCsv('name,domain\n"Evil\u0007\tName",evil.com')
    expect(r.rows[0].name).toBe('Evil Name')
  })
})
