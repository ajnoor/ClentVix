import * as cheerio from 'cheerio'
import { safeFetch, type SafeFetchResult } from './ssrf'

export type PageSignals = {
  isHttps: boolean
  hasViewportMeta: boolean
  hasMetaDescription: boolean
  phoneLinks: number
  emailLinks: number
  forms: number
  actionLinkTexts: string[]
}

export type PageSnapshot = {
  url: string
  status: number
  fetchedAt: string
  title: string
  description: string
  headings: string[]
  text: string
  signals: PageSignals
  truncated: boolean
}

const ACTION = /\b(book|appointment|schedule|reserve|enquir|inquir|contact|quote|get started|call us|request)\b/i
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

export function extractSnapshot(result: Pick<SafeFetchResult, 'url' | 'status' | 'body' | 'truncated'>): PageSnapshot {
  const $ = cheerio.load(result.body)
  const title = collapse($('title').first().text()).slice(0, 200)
  const description = collapse($('meta[name="description"]').attr('content') ?? $('meta[property="og:description"]').attr('content') ?? '').slice(0, 400)
  const signals: PageSignals = {
    isHttps: result.url.startsWith('https://'),
    hasViewportMeta: $('meta[name="viewport"]').length > 0,
    hasMetaDescription: description.length > 0,
    phoneLinks: $('a[href^="tel:"]').length,
    emailLinks: $('a[href^="mailto:"]').length,
    forms: $('form').length,
    actionLinkTexts: [],
  }
  const actions = new Set<string>()
  $('a,button').each((_, el) => {
    const t = collapse($(el).text()).slice(0, 60)
    if (t && ACTION.test(t)) actions.add(t)
  })
  signals.actionLinkTexts = [...actions].slice(0, 8)
  $('script,style,noscript,svg,iframe,template,nav[aria-hidden="true"]').remove()
  const headings = $('h1,h2,h3')
    .map((_, el) => collapse($(el).text()).slice(0, 160))
    .get()
    .filter(Boolean)
    .slice(0, 25)
  const text = collapse($('body').text()).slice(0, 8000)
  return { url: result.url, status: result.status, fetchedAt: new Date().toISOString(), title, description, headings, text, signals, truncated: result.truncated }
}

export class PageFetchError extends Error {}

export async function fetchSnapshot(url: string, fetcher: typeof safeFetch = safeFetch): Promise<PageSnapshot> {
  let result: SafeFetchResult
  try {
    result = await fetcher(url, { timeoutMs: 8000, maxBytes: 1_500_000 })
  } catch (error) {
    throw new PageFetchError(error instanceof Error ? error.message : 'Could not fetch website.')
  }
  if (result.status < 200 || result.status >= 300) throw new PageFetchError(`Website returned HTTP ${result.status}.`)
  if (!result.body) throw new PageFetchError('Website did not return an HTML page.')
  return extractSnapshot(result)
}

/** Everything a quote may legitimately be copied from, as one string. */
export function snapshotHaystack(s: PageSnapshot) {
  return [s.title, s.description, ...s.headings, s.text, ...s.signals.actionLinkTexts].join('\n')
}
