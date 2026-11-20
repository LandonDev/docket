import { describe, expect, it } from 'vitest'
import type { ServiceState } from '../service/supervisor'
import { guestOrigin, guestsRows } from './health'
import { guests } from './index'

const on = { enabled: () => true }
const signal = new AbortController().signal
const BOX = { platform: 'linux' as const, env: {} }
const MAC = { platform: 'darwin' as const, env: {} }

const service = (state: ServiceState, port: number | null = state === 'running' ? 7695 : null) => ({ state: () => state, port: () => port })

/** A fetch that answers each address from `table`, as the service would (its headers) or as something else. */
function fetcher(table: Record<string, 'service' | number | 'down'>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    const how = table[url] ?? 'down'
    if (how === 'down') throw new TypeError('fetch failed')
    if (how === 'service') return new Response('ok', { status: 200, headers: { 'X-Frame-Options': 'DENY' } })
    return new Response('bad gateway', { status: how })
  }) as typeof fetch
}

describe('the Work service connections', () => {
  it('a Mac: the service answers on its port, and no public rows', async () => {
    const seen: string[] = []
    const rows = await guestsRows(on, signal, { service: service('running'), fetch: fetcher({ 'http://127.0.0.1:7695/w/hosted/': 404 }, seen), ...MAC })
    expect(rows).toEqual([{ id: 'guests.service', pillar: 'guests', group: 'Work service', title: 'Work service', state: 'working', line: 'Answers on port 7695' }])
    expect(seen).toEqual(['http://127.0.0.1:7695/w/hosted/'])
  })

  it('the box: the hosted pages and a guest page through the tunnel', async () => {
    const seen: string[] = []
    const rows = await guestsRows(on, signal, {
      service: service('running'),
      fetch: fetcher({ 'http://127.0.0.1:7695/w/hosted/': 'service', 'https://tempcode.landonhale.com/w/hosted/': 'service', 'https://tempcode.landonhale.com/g/health-check': 'service' }, seen),
      ...BOX
    })
    expect(rows.map((r) => [r.id, r.state, r.line])).toEqual([
      ['guests.service', 'working', 'Answers on port 7695'],
      ['guests.hosted', 'working', 'Reached at tempcode.landonhale.com'],
      ['guests.links', 'working', 'Reached at tempcode.landonhale.com']
    ])
    expect(seen).toHaveLength(3)
  })

  it('a tunnel that does not answer, or answers with something other than the service, is broken', async () => {
    const rows = await guestsRows(on, signal, { service: service('running'), fetch: fetcher({ 'http://127.0.0.1:7695/w/hosted/': 'service', 'https://tempcode.landonhale.com/w/hosted/': 502 }), ...BOX })
    expect(rows.slice(1).map((r) => [r.id, r.state, r.line])).toEqual([
      ['guests.hosted', 'broken', 'The tunnel answered 502, not the Work service'],
      ['guests.links', 'broken', 'No answer: fetch failed']
    ])
  })

  it('a service that is down is one broken row, with no public rows that hang on it', async () => {
    const seen: string[] = []
    expect(await guestsRows(on, signal, { service: service('waiting'), fetch: fetcher({}, seen), ...BOX })).toEqual([{ id: 'guests.service', pillar: 'guests', group: 'Work service', title: 'Work service', state: 'broken', line: 'It stopped; it restarts by itself' }])
    expect(await guestsRows(on, signal, { service: service('starting'), fetch: fetcher({}, seen), ...BOX })).toMatchObject([{ state: 'broken', line: 'Still starting' }])
    expect(await guestsRows(on, signal, { service: service('off'), fetch: fetcher({}, seen), canFork: true, ...BOX })).toMatchObject([{ state: 'broken', line: 'Not running' }])
    expect(seen).toEqual([])
    expect(await guestsRows(on, signal, { service: service('running'), fetch: fetcher({}), ...BOX })).toMatchObject([{ state: 'broken', line: 'Does not answer on port 7695' }])
  })

  it('leaves out what this host does not have: Work off, no service, or no Electron to run it', async () => {
    expect(await guestsRows({ enabled: () => false }, signal, { service: service('running'), fetch: fetcher({}), ...BOX })).toEqual([])
    expect(await guestsRows(on, signal, { service: null, fetch: fetcher({}), ...BOX })).toEqual([])
    expect(await guestsRows(on, signal, { service: service('off'), fetch: fetcher({}), canFork: false, ...BOX })).toEqual([])
  })

  it('serves guest links on the installed box, or where a public origin is named', () => {
    expect(guestOrigin({}, 'linux')).toBe('https://tempcode.landonhale.com')
    expect(guestOrigin({ TEMP_CODE_USER_DATA: '/tmp/dev' }, 'linux')).toBeNull()
    expect(guestOrigin({}, 'darwin')).toBeNull()
    expect(guestOrigin({ TEMP_CODE_WORK_PUBLIC_ORIGIN: 'https://x.trycloudflare.com/' }, 'darwin')).toBe('https://x.trycloudflare.com')
  })

  it('no row carries the service secret or a guest secret', async () => {
    const rows = await guestsRows(on, signal, { service: service('running'), fetch: fetcher({ 'http://127.0.0.1:7695/w/hosted/': 'service' }), ...BOX })
    expect(JSON.stringify(rows)).not.toMatch(/#k=|Bearer|secret/)
  })

  it('is the module’s health, and nothing on a ctx with no service', async () => {
    expect(guests.health?.lapses).toBeUndefined()
    expect(await guests.health!.check({ enabled: () => true } as never, signal)).toEqual([])
  })
})
