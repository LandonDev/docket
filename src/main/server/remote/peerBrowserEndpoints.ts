import { BrowserEndpointsSchema, type BrowserEndpoints } from '@shared/browserEndpoints'
import { RELAY_HEARTBEAT_MS } from '@shared/contract-relay'
import type { Store } from '../db'

type Direction = 'inbound' | 'outbound'

/** Three missed heartbeats invalidate the snapshot. A new snapshot replaces the old: the peer's listener refuses a Host it no longer publishes. */
const MAX_AGE_MS = 3 * RELAY_HEARTBEAT_MS
const setting = (direction: Direction, id: string): string =>
  `remote.browserEndpoints.${direction}.${id}`

export class PeerBrowserEndpoints {
  private readonly seen = new Map<string, number>()
  private readonly saved = new Map<string, BrowserEndpoints | undefined>()

  constructor(
    private readonly store: Pick<Store, 'getSetting' | 'setSetting'>,
    private readonly now: () => number = Date.now
  ) {}

  receive(direction: Direction, id: string, endpoints: BrowserEndpoints): void {
    const key = setting(direction, id)
    const value = JSON.stringify(endpoints)
    if (value !== JSON.stringify(this.read(key))) {
      this.store.setSetting(key, value)
      this.saved.set(key, endpoints)
    }
    this.seen.set(key, this.now())
  }

  disconnect(direction: Direction, id: string): void {
    this.seen.delete(setting(direction, id))
  }

  snapshot(
    outbound: readonly string[],
    inbound: readonly string[]
  ): { linkedEndpoints: BrowserEndpoints[]; linkedEndpointsUnknown: boolean } {
    const keys = new Set(outbound.map((id) => setting('outbound', id)))
    for (const id of inbound) {
      // Only the link we dialed and whose hello we checked can answer for a saved host.
      if (!outbound.includes(id)) keys.add(setting('inbound', id))
    }
    const linkedEndpoints: BrowserEndpoints[] = []
    let linkedEndpointsUnknown = false
    const oldest = this.now() - MAX_AGE_MS
    for (const key of keys) {
      const endpoints = this.read(key)
      if (endpoints) linkedEndpoints.push(endpoints)
      if (!endpoints || (this.seen.get(key) ?? -Infinity) <= oldest) linkedEndpointsUnknown = true
    }
    return { linkedEndpoints, linkedEndpointsUnknown }
  }

  private read(key: string): BrowserEndpoints | undefined {
    if (!this.saved.has(key)) {
      const raw = this.store.getSetting(key)
      let endpoints: BrowserEndpoints | undefined
      if (raw) {
        try {
          const parsed = BrowserEndpointsSchema.safeParse(JSON.parse(raw))
          if (parsed.success) endpoints = parsed.data
        } catch {
          // A bad stored row is an unknown peer, just as a missing row is.
        }
      }
      this.saved.set(key, endpoints)
    }
    return this.saved.get(key)
  }
}
