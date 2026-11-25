import { afterEach, expect, it, vi } from 'vitest'
import { BROWSER_ENDPOINT_ACK_MS, BROWSER_INPUT_PROOF_MS, OwnerBrowserEndpoints } from './ownerBrowserEndpoints'

const original = { listenerPorts: [7677], lanAddresses: ['host.local'], remoteRoutes: [] }
const moved = { listenerPorts: [8191], lanAddresses: ['host.local'], remoteRoutes: ['https://host.example:8443'] }

afterEach(() => vi.useRealTimers())

it('withdraws the old list and waits for every acknowledgement and the old proofs to expire', async () => {
  vi.useFakeTimers()
  const owner = new OwnerBrowserEndpoints()
  await owner.publish(original, false, () => [])
  const lastPeer = Promise.withResolvers<boolean>()
  const ready = owner.publish(moved, true, () => [Promise.resolve(true), lastPeer.promise])
  expect(owner.current).toBeUndefined()

  await vi.advanceTimersByTimeAsync(BROWSER_INPUT_PROOF_MS)
  expect(owner.current).toBeUndefined()
  lastPeer.resolve(true)
  await ready
  expect(owner.current).toEqual(moved)
})

it('releases after a short timeout even if a peer never acknowledges', async () => {
  vi.useFakeTimers()
  const owner = new OwnerBrowserEndpoints()
  const silentPeer = Promise.withResolvers<boolean>()
  const ready = owner.publish(moved, true, () => [silentPeer.promise])
  await vi.advanceTimersByTimeAsync(BROWSER_ENDPOINT_ACK_MS - 1)
  expect(owner.current).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  await ready
  expect(owner.current).toEqual(moved)
})
