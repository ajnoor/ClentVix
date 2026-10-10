import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import type { Readable } from 'node:stream'

/**
 * SSRF-safe outbound fetching.
 *
 * Defences (all enforced for EVERY hop, including redirects):
 *  1. Scheme must be http/https, no URL credentials, only ports 80/443.
 *  2. Host names that are obviously internal (localhost, *.local, *.internal, single-label) are rejected.
 *  3. IP literals (including decimal/hex/octal forms, which the WHATWG URL parser normalises) are checked.
 *  4. The IP that the socket actually connects to is validated inside the `lookup` hook that Node
 *     uses to open the connection. Validating the same resolution that is used to connect closes the
 *     DNS-rebinding / TOCTOU window that a "resolve first, fetch later" check leaves open.
 *  5. Redirects are followed manually (max 4) and each target is re-validated from scratch.
 *  6. Response size (after decompression) and total time are capped.
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

function buildDefaultBlockList() {
  const list = new net.BlockList()
  const v4: Array<[string, number]> = [
    ['0.0.0.0', 8], // "this" network
    ['10.0.0.0', 8], // private
    ['100.64.0.0', 10], // carrier-grade NAT
    ['127.0.0.0', 8], // loopback
    ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
    ['172.16.0.0', 12], // private (the previous check only covered 172.16.x)
    ['192.0.0.0', 24], // IETF protocol assignments
    ['192.0.2.0', 24], // TEST-NET-1
    ['192.88.99.0', 24], // 6to4 relay
    ['192.168.0.0', 16], // private
    ['198.18.0.0', 15], // benchmarking
    ['198.51.100.0', 24], // TEST-NET-2
    ['203.0.113.0', 24], // TEST-NET-3
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved + broadcast
  ]
  for (const [addr, prefix] of v4) list.addSubnet(addr, prefix, 'ipv4')
  const v6: Array<[string, number]> = [
    ['::', 96], // unspecified, loopback and deprecated IPv4-compatible (::a.b.c.d)
    ['64:ff9b::', 96], // NAT64 (could embed a private v4)
    ['64:ff9b:1::', 48], // local-use NAT64
    ['100::', 64], // discard-only
    ['2001::', 32], // Teredo
    ['2001:db8::', 32], // documentation
    ['2002::', 16], // 6to4
    ['fc00::', 7], // unique local
    ['fe80::', 10], // link-local
    ['fec0::', 10], // deprecated site-local
    ['ff00::', 8], // multicast
  ]
  for (const [addr, prefix] of v6) list.addSubnet(addr, prefix, 'ipv6')
  return list
}

export type SafeFetchConfig = {
  blocked: net.BlockList
  /** null = any port (tests only). */
  allowedPorts: ReadonlySet<number> | null
  /** Reject single-label and reserved host names. */
  strictHostnames: boolean
}

const defaultConfig: SafeFetchConfig = {
  blocked: buildDefaultBlockList(),
  allowedPorts: new Set([80, 443]),
  strictHostnames: true,
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet', '.corp']

function stripBrackets(host: string) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * Node's BlockList evaluates IPv4 addresses as IPv4-mapped IPv6, so a ::ffff:0:0/96 rule would block every
 * public IPv4 address. IPv4-mapped IPv6 literals are therefore detected here, explicitly, from the raw bytes.
 */
export function ipv6Bytes(address: string): number[] | null {
  let a = address.toLowerCase().split('%')[0]
  let tail: [number, number] | null = null
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null
    const o = dotted[1].split('.').map(Number)
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]]
    a = `${a.slice(0, -dotted[1].length)}0:0`
  }
  const halves = a.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let groups: string[]
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length
    if (fill < 1) return null
    groups = [...head, ...Array<string>(fill).fill('0'), ...rest]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  const numbers = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN))
  if (numbers.some(Number.isNaN)) return null
  if (tail) {
    numbers[6] = tail[0]
    numbers[7] = tail[1]
  }
  return numbers.flatMap((g) => [g >> 8, g & 0xff])
}

export function isBlockedAddress(address: string, config: SafeFetchConfig = defaultConfig) {
  const family = net.isIP(address)
  if (family === 0) return true // not an IP at all: refuse
  if (family === 6) {
    const bytes = ipv6Bytes(address)
    if (!bytes) return true // unparsable: refuse
    const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff
    if (mapped) return true // IPv4-mapped IPv6 can smuggle a private IPv4; real DNS answers never need it
  }
  return config.blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

function checkUrlShape(value: string, config: SafeFetchConfig) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SsrfError('Invalid URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SsrfError('Only HTTP(S) URLs are supported.')
  if (url.username || url.password) throw new SsrfError('Credentials in URLs are not allowed.')
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (config.allowedPorts && !config.allowedPorts.has(port)) throw new SsrfError('Only ports 80 and 443 are allowed.')
  const hostname = stripBrackets(url.hostname.toLowerCase()).replace(/\.$/, '')
  if (!hostname) throw new SsrfError('Missing host name.')
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname, config)) throw new SsrfError('Private or reserved addresses are not allowed.')
  } else if (config.strictHostnames) {
    if (!hostname.includes('.') || hostname === 'localhost' || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
      throw new SsrfError('Private hosts are not allowed.')
    }
  }
  return url
}

/** Resolve at connect time and refuse if ANY returned address is not public. */
function guardedLookup(config: SafeFetchConfig) {
  return (hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error)
      const list = addresses as dns.LookupAddress[]
      if (list.length === 0) return callback(new SsrfError('Host did not resolve.'))
      for (const { address } of list) {
        if (isBlockedAddress(address, config)) return callback(new SsrfError('Private addresses are not allowed.'))
      }
      if (options.all) return callback(null, list)
      return callback(null, list[0].address, list[0].family)
    })
  }
}

/** Syntax + DNS pre-check. Kept for callers that want an early, friendly error. */
export async function validatePublicUrl(value: string, config: SafeFetchConfig = defaultConfig) {
  const url = checkUrlShape(value, config)
  const hostname = stripBrackets(url.hostname)
  if (!net.isIP(hostname)) {
    const addresses = await dns.promises.lookup(hostname, { all: true })
    if (addresses.length === 0) throw new SsrfError('Host did not resolve.')
    for (const { address } of addresses) {
      if (isBlockedAddress(address, config)) throw new SsrfError('Private addresses are not allowed.')
    }
  }
  return url
}

export type SafeFetchOptions = {
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  headers?: Record<string, string>
  /** Only read the body for these content-type prefixes (others return an empty body). */
  readTypes?: string[]
}

export type SafeFetchResult = {
  url: string
  status: number
  contentType: string
  body: string
  truncated: boolean
  redirects: string[]
}

function decodeBody(buffer: Buffer, contentType: string) {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase()
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(buffer)
  } catch {
    return new TextDecoder('utf-8').decode(buffer)
  }
}

function requestOnce(url: URL, config: SafeFetchConfig, options: Required<Omit<SafeFetchOptions, 'readTypes' | 'headers'>> & Pick<SafeFetchOptions, 'readTypes' | 'headers'>, deadline: number) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }>((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const remaining = deadline - Date.now()
    if (remaining <= 0) return reject(new Error('Request timed out.'))
    const req = lib.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup(config) as any,
        headers: {
          'user-agent': 'ClentVix-Auditor/1.0 (+evidence-based prospect research)',
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'accept-encoding': 'gzip, deflate, br',
          ...options.headers,
        },
        timeout: remaining,
      },
      (res) => {
        const status = res.statusCode ?? 0
        const contentType = String(res.headers['content-type'] ?? '')
        const isRedirect = status >= 300 && status < 400 && res.headers.location
        const readable = options.readTypes ? options.readTypes.some((t) => contentType.toLowerCase().includes(t)) : true
        if (isRedirect || !readable || status === 204 || status === 304) {
          res.resume()
          return resolve({ status, headers: res.headers, body: Buffer.alloc(0), truncated: false })
        }
        let stream: Readable = res
        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase()
        if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip())
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate())
        else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress())
        else if (encoding && encoding !== 'identity') {
          res.resume()
          return reject(new Error('Unsupported content encoding.'))
        }
        const chunks: Buffer[] = []
        let size = 0
        let done = false
        const finish = (truncated: boolean) => {
          if (done) return
          done = true
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated })
        }
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > options.maxBytes) {
            const keep = chunk.length - (size - options.maxBytes)
            if (keep > 0) chunks.push(chunk.subarray(0, keep))
            finish(true)
            req.destroy()
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        stream.on('end', () => finish(false))
        stream.on('error', (error) => {
          if (!done) {
            done = true
            reject(error)
          }
        })
        res.on('error', (error) => {
          if (!done) {
            done = true
            reject(error)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('Request timed out.')))
    req.on('error', reject)
    req.end()
  })
}

export function createSafeFetcher(overrides: Partial<SafeFetchConfig> = {}) {
  const config: SafeFetchConfig = { ...defaultConfig, ...overrides }
  return async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
    const options = {
      timeoutMs: opts.timeoutMs ?? 8000,
      maxBytes: opts.maxBytes ?? 1_500_000,
      maxRedirects: opts.maxRedirects ?? 4,
      headers: opts.headers,
      readTypes: opts.readTypes ?? ['text/html', 'application/xhtml+xml'],
    }
    const deadline = Date.now() + options.timeoutMs
    const redirects: string[] = []
    let current = checkUrlShape(rawUrl, config)
    for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
      const result = await requestOnce(current, config, options, deadline)
      const location = result.headers.location
      if (result.status >= 300 && result.status < 400 && location) {
        if (hop === options.maxRedirects) throw new SsrfError('Too many redirects.')
        let next: string
        try {
          next = new URL(location, current).toString()
        } catch {
          throw new SsrfError('Invalid redirect target.')
        }
        current = checkUrlShape(next, config) // re-validate every hop
        redirects.push(current.toString())
        continue
      }
      const contentType = String(result.headers['content-type'] ?? '')
      return {
        url: current.toString(),
        status: result.status,
        contentType,
        body: result.body.length ? decodeBody(result.body, contentType) : '',
        truncated: result.truncated,
        redirects,
      }
    }
    throw new SsrfError('Too many redirects.')
  }
}

export const safeFetch = createSafeFetcher()
