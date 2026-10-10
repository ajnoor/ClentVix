import dns from 'node:dns'
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSafeFetcher, isBlockedAddress, safeFetch, SsrfError, validatePublicUrl } from '@/lib/ssrf'

describe('isBlockedAddress', () => {
  const blocked = ['127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.17.5.5', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', 'ff02::1', '2001:db8::1', '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:ffff:0a00:0001', '::127.0.0.1', '::ffff:192.168.1.1', '::1%lo0']
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e']
  it.each(blocked)('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true))
  it.each(allowed)('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false))
  it('refuses non-IP strings', () => expect(isBlockedAddress('example.com')).toBe(true))
})

describe('safeFetch rejects dangerous URLs before connecting', () => {
  const cases: Array<[string, string]> = [
    ['http://127.0.0.1/', 'loopback v4'],
    ['http://localhost/', 'localhost'],
    ['http://foo.localhost/', '*.localhost'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://metadata.google.internal/', '*.internal'],
    ['http://[::1]/', 'loopback v6'],
    ['http://[::ffff:127.0.0.1]/', 'mapped v6'],
    ['http://2130706433/', 'decimal IP'],
    ['http://0x7f.0.0.1/', 'hex IP'],
    ['http://0177.0.0.1/', 'octal IP'],
    ['http://172.20.0.1/', '172.16/12 (old check missed this)'],
    ['http://100.64.0.1/', 'CGNAT'],
    ['http://intranet/', 'single-label host'],
    ['http://printer.local/', 'mDNS .local'],
    ['ftp://example.com/', 'ftp'],
    ['file:///etc/passwd', 'file'],
    ['http://user:pass@example.com/', 'credentials'],
    ['http://example.com:8080/', 'non-standard port'],
    ['http://example.com:22/', 'ssh port'],
    ['not a url', 'garbage'],
  ]
  it.each(cases)('%s (%s)', async (url) => {
    await expect(safeFetch(url)).rejects.toBeInstanceOf(SsrfError)
  })
})

describe('DNS rebinding / private resolution', () => {
  afterEach(() => vi.restoreAllMocks())
  const stubLookup = (address: string, family = 4) =>
    vi.spyOn(dns, 'lookup').mockImplementation(((_h: string, _o: unknown, cb: (...a: unknown[]) => void) => cb(null, [{ address, family }])) as never)

  it('rejects a public-looking name that resolves to a private address (connect-time check)', async () => {
    stubLookup('10.0.0.5')
    await expect(safeFetch('https://totally-public.example.com/')).rejects.toBeInstanceOf(SsrfError)
  })
  it('rejects when ANY returned address is private', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation(((_h: string, _o: unknown, cb: (...a: unknown[]) => void) =>
      cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }])) as never)
    await expect(safeFetch('https://mixed.example.com/')).rejects.toBeInstanceOf(SsrfError)
  })
  it('validatePublicUrl rejects private resolution', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '192.168.0.9', family: 4 }] as never)
    await expect(validatePublicUrl('https://internal-app.example.com')).rejects.toBeInstanceOf(SsrfError)
  })
})

describe('safeFetch behaviour against a real local HTTP server (private-range guard relaxed for the test only)', () => {
  let server: http.Server
  let base = ''
  // Relaxed config: only the metadata range is blocked, any port, any host name.
  const blocked = new net.BlockList()
  blocked.addSubnet('169.254.0.0', 16, 'ipv4')
  const fetcher = createSafeFetcher({ blocked, allowedPorts: null, strictHostnames: false })

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '/'
      if (url === '/html') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><title>Hi</title><body>Hello</body></html>')
      if (url === '/gzip') return void res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(zlib.gzipSync('<p>zipped</p>'))
      if (url === '/bomb') return void res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(zlib.gzipSync(Buffer.alloc(5_000_000, 'a')))
      if (url === '/big') return void res.writeHead(200, { 'content-type': 'text/html' }).end('x'.repeat(2_000_000))
      if (url === '/json') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"secret":1}')
      if (url === '/redir') return void res.writeHead(302, { location: '/html' }).end()
      if (url === '/redir-meta') return void res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end()
      if (url === '/loop') return void res.writeHead(302, { location: '/loop' }).end()
      if (url === '/slow') return void setTimeout(() => res.end('late'), 3000)
      res.writeHead(404).end('nope')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
  })
  afterAll(() => void server.close())

  it('returns html body and status', async () => {
    const r = await fetcher(`${base}/html`)
    expect(r.status).toBe(200)
    expect(r.body).toContain('Hello')
  })
  it('decodes gzip', async () => expect((await fetcher(`${base}/gzip`)).body).toBe('<p>zipped</p>'))
  it('caps decompressed size (zip bomb) and flags truncation', async () => {
    const r = await fetcher(`${base}/bomb`, { maxBytes: 100_000 })
    expect(r.truncated).toBe(true)
    expect(r.body.length).toBeLessThanOrEqual(100_000)
  })
  it('caps plain body size', async () => {
    const r = await fetcher(`${base}/big`, { maxBytes: 50_000 })
    expect(r.truncated).toBe(true)
    expect(r.body.length).toBe(50_000)
  })
  it('does not read non-HTML bodies', async () => expect((await fetcher(`${base}/json`)).body).toBe(''))
  it('follows safe redirects', async () => {
    const r = await fetcher(`${base}/redir`)
    expect(r.url).toBe(`${base}/html`)
    expect(r.redirects).toHaveLength(1)
  })
  it('re-validates every redirect hop (redirect to metadata IP is refused)', async () => {
    await expect(fetcher(`${base}/redir-meta`)).rejects.toBeInstanceOf(SsrfError)
  })
  it('stops redirect loops', async () => {
    await expect(fetcher(`${base}/loop`, { maxRedirects: 3 })).rejects.toBeInstanceOf(SsrfError)
  })
  it('times out slow servers', async () => {
    await expect(fetcher(`${base}/slow`, { timeoutMs: 400 })).rejects.toThrow(/timed out/i)
  })
})
