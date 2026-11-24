import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { carries, carry, closeCarriers, downstreamHeaders, handshake, ownHost, ownOrigin, parseCarry, staysOn, upstreamHeaders } from './fullEditorCarry'

/** The carrier with a stand-in box behind it; the real route behind it is in work/sheets/fullEditor/fullEditor.test.ts. */
const TOKEN = 'ab'.repeat(32)
let box: Server
let boxUrl: string
let seen: { url?: string; headers: IncomingHttpHeaders }[]

beforeEach(async () => {
  seen = []
  box = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`box ${req.url}`)
  })
  await new Promise<void>((r) => box.listen(0, '127.0.0.1', () => r()))
  boxUrl = `http://127.0.0.1:${(box.address() as AddressInfo).port}`
})
afterEach(async () => {
  await closeCarriers()
  await new Promise<void>((r) => box.close(() => r()))
})

const get = (url: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    request(url, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
      .on('error', reject)
      .end()
  })

describe('the full editor carried from the box', () => {
  it('takes only a full editor page\'s address: https, or http to a loopback host, with its token and nothing else', () => {
    expect(parseCarry(`https://tempcode.example/w/full/${TOKEN}/`)).toEqual({ upstream: new URL('https://tempcode.example'), base: `/w/full/${TOKEN}/` })
    expect(parseCarry(`http://127.0.0.1:7695/w/full/${TOKEN}/`)?.base).toBe(`/w/full/${TOKEN}/`)
    expect(parseCarry(`http://tempcode.example/w/full/${TOKEN}/`)).toBeNull()
    expect(parseCarry(`https://tempcode.example/w/open`)).toBeNull()
    expect(parseCarry(`https://tempcode.example/w/full/${TOKEN}/doc`)).toBeNull()
    expect(parseCarry(`https://u:p@tempcode.example/w/full/${TOKEN}/`)).toBeNull()
    expect(parseCarry('not a url')).toBeNull()
    expect(carries(`/w/full/${TOKEN}/`, `/w/full/${TOKEN}/sdkjs/x.js?v=1`)).toBe(true)
    expect(carries(`/w/full/${TOKEN}/`, `/w/full/${'cd'.repeat(32)}/`)).toBe(false)
    expect(carries(`/w/full/${TOKEN}/`, '/api/hello')).toBe(false)
    // Nothing a hop could normalize into another path of the box.
    for (const sly of ['../../api/hello', './x', 'a/%2e%2e/b', 'a%2Fb', 'a\\b', '..']) expect(carries(`/w/full/${TOKEN}/`, `/w/full/${TOKEN}/${sly}`)).toBe(false)
    expect(carries(`/w/full/${TOKEN}/`, `/w/full/${TOKEN}/doc/k/c/?EIO=4&x=../y`)).toBe(true)
    expect(ownOrigin(undefined, 'http://127.0.0.1:5000')).toBe(true)
    expect(ownOrigin('http://127.0.0.1:5000', 'http://127.0.0.1:5000')).toBe(true)
    expect(ownOrigin('https://evil.example', 'http://127.0.0.1:5000')).toBe(false)
  })

  it('sends the box its own host and names the loopback origin, passing on no hop headers', () => {
    const h = upstreamHeaders({ host: '127.0.0.1:5000', connection: 'keep-alive', 'x-tempcode-carry': 'forged', cookie: 'other=1', authorization: 'Bearer x', accept: '*/*' }, new URL('https://tempcode.example'), 'http://127.0.0.1:5000')
    expect(h).toEqual({ accept: '*/*', host: 'tempcode.example', 'x-tempcode-carry': 'http://127.0.0.1:5000' })
    expect(ownHost('127.0.0.1:5000', 5000)).toBe(true)
    expect(ownHost('evil.example:5000', 5000)).toBe(false)
    expect(ownHost(undefined, 5000)).toBe(false)
  })

  it('keeps a redirect on its own origin and passes on no cookie and no wider service worker', () => {
    const up = new URL('https://tempcode.example')
    const own = 'http://127.0.0.1:5000'
    expect(downstreamHeaders({ location: `https://tempcode.example/w/full/${TOKEN}/x`, 'set-cookie': ['a=1'], 'service-worker-allowed': '/' }, up, own)).toEqual({ location: `${own}/w/full/${TOKEN}/x` })
    expect(downstreamHeaders({ location: 'https://elsewhere.example/' }, up, own)).toEqual({})
    expect(downstreamHeaders({ location: 'x/y' }, up, own)).toEqual({ location: 'x/y' })
    expect(downstreamHeaders({ location: '//elsewhere.example/x' }, up, own)).toEqual({})
    expect(downstreamHeaders({ location: '//tempcode.example/w/full/x' }, up, own)).toEqual({ location: `${own}/w/full/x` })
  })

  it('passes a socket\'s switch alone, with no cookie, and keeps the window on its own origin', () => {
    expect(handshake('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSet-Cookie: io=1\r\nConnection: Upgrade')).toBe('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade')
    expect(handshake('HTTP/1.1 200 OK\r\nContent-Length: 0')).toBeNull()
    expect(staysOn('http://127.0.0.1:5000', 'http://127.0.0.1:5000/w/full/x')).toBe(true)
    expect(staysOn('http://127.0.0.1:5000', 'https://tempcode.example/')).toBe(false)
    expect(staysOn('http://127.0.0.1:5000', 'not a url')).toBe(false)
  })

  it('serves the page on a loopback origin of its own and forwards the page\'s paths alone, one carrier a page', async () => {
    const page = await carry(`${boxUrl}/w/full/${TOKEN}/`)
    const at = new URL(page)
    expect(at.hostname).toBe('127.0.0.1')
    expect(at.port).not.toBe(new URL(boxUrl).port)
    expect(await carry(`${boxUrl}/w/full/${TOKEN}/`)).toBe(page)
    expect(await get(`${at.origin}/w/full/${TOKEN}/sdkjs/a.js`)).toEqual({ status: 200, body: `box /w/full/${TOKEN}/sdkjs/a.js` })
    expect(seen[0]!.headers['x-tempcode-carry']).toBe(at.origin)
    expect(seen[0]!.headers.host).toBe(new URL(boxUrl).host)
    expect((await get(`${at.origin}/w/open`)).status).toBe(404)
    expect((await get(`${at.origin}/w/full/${'cd'.repeat(32)}/`)).status).toBe(404)
    expect(seen).toHaveLength(1)
  })

  it('refuses an address that is not a full editor page', async () => {
    await expect(carry('https://tempcode.example/api/hello')).rejects.toThrow('That is not an address of the full editor.')
  })

  it('closes once nothing has come through it for its idle time', async () => {
    let now = 0
    const page = await carry(`${boxUrl}/w/full/${TOKEN}/`, { idleMs: 20, now: () => now })
    now = 1000
    await new Promise((r) => setTimeout(r, 80))
    await expect(get(page)).rejects.toThrow()
  })
})
