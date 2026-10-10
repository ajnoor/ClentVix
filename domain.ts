import net from 'node:net'

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/

/**
 * Normalises user/provider input ("https://www.Example.co.uk/path?x") to a bare registrable-looking
 * host ("example.co.uk"). Returns null for anything that is not a plausible public domain
 * (IP literals, single labels, localhost, bad characters).
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null
  let value = input.trim()
  if (!value || value.length > 2048) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`
  let host: string
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    host = url.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
  if (host.startsWith('www.')) host = host.slice(4)
  if (!host || host.length > 253 || net.isIP(host) || host.startsWith('[')) return null
  const labels = host.split('.')
  if (labels.length < 2) return null
  if (!labels.every((l) => LABEL.test(l))) return null
  if (!TLD.test(labels[labels.length - 1])) return null
  return host
}

export function websiteUrlForDomain(domain: string) {
  return `https://${domain}`
}

function slug(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Stable per-user identity of a prospect: website domain first, then provider place id, then name+address. */
export function dedupeKey(input: { domain?: string | null; placeId?: string | null; name: string; address?: string | null }) {
  if (input.domain) return `d:${input.domain}`
  if (input.placeId) return `p:${input.placeId}`
  return `n:${slug(input.name)}|${slug(input.address ?? '')}`
}
