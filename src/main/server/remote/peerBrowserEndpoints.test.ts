import { expect, it, vi } from 'vitest'
import { RELAY_HEARTBEAT_MS } from '@shared/contract-relay'
import { PeerBrowserEndpoints } from './peerBrowserEndpoints'

const first = {
  listenerPorts: [8191],
  lanAddresses: ['192.168.40.9'],
  remoteRoutes: ['https://peer.example']
}
const next = { ...first, listenerPorts: [8192] }

it('keeps a missing peer unknown, refreshes its set, and keeps old denials after expiry or restart', () => {
  const rows = new Map<string, string>()
  const store = {
    getSetting: (key: string) => rows.get(key) ?? null,
    setSetting: vi.fn((key: string, value: string | null) => {
      if (value !== null) rows.set(key, value)
    })
  }
  let now = 100
  const endpoints = new PeerBrowserEndpoints(store, () => now)
  expect(endpoints.snapshot(['peer'], [])).toEqual({
    linkedEndpoints: [],
    linkedEndpointsUnknown: true
  })
  endpoints.receive('outbound', 'peer', first)
  expect(endpoints.snapshot(['peer'], [])).toEqual({
    linkedEndpoints: [first],
    linkedEndpointsUnknown: false
  })
  now += 2 * RELAY_HEARTBEAT_MS
  endpoints.receive('outbound', 'peer', first)
  expect(store.setSetting).toHaveBeenCalledTimes(1)
  now += 2 * RELAY_HEARTBEAT_MS
  expect(endpoints.snapshot(['peer'], []).linkedEndpointsUnknown).toBe(false)
  endpoints.receive('outbound', 'peer', next)
  expect(endpoints.snapshot(['peer'], []).linkedEndpoints).toEqual([next])
  now += 3 * RELAY_HEARTBEAT_MS
  expect(endpoints.snapshot(['peer'], [])).toEqual({
    linkedEndpoints: [next],
    linkedEndpointsUnknown: true
  })
  expect(new PeerBrowserEndpoints(store).snapshot(['peer'], [])).toEqual({
    linkedEndpoints: [next],
    linkedEndpointsUnknown: true
  })
})

it('treats a disconnected peer as incomplete and takes saved host endpoints only from the dialed link', () => {
  const endpoints = new PeerBrowserEndpoints({ getSetting: () => null, setSetting: () => {} })
  endpoints.receive('inbound', 'peer', first)
  expect(endpoints.snapshot([], ['peer']).linkedEndpointsUnknown).toBe(false)
  expect(endpoints.snapshot(['peer'], ['peer'])).toEqual({
    linkedEndpoints: [],
    linkedEndpointsUnknown: true
  })
  endpoints.disconnect('inbound', 'peer')
  expect(endpoints.snapshot([], ['peer'])).toEqual({
    linkedEndpoints: [first],
    linkedEndpointsUnknown: true
  })
  expect(endpoints.snapshot([], [])).toEqual({ linkedEndpoints: [], linkedEndpointsUnknown: false })
})
