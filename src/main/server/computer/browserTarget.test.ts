import { describe, expect, it, vi } from 'vitest'

// Names resolve to addresses of their own, so only a matching name can refuse.
const ADDRESSES: Record<string, string> = {
  'tempcode.landonhale.com': '104.21.0.1',
  'docket.landonhale.com': '172.67.0.2',
  'share.landonhale.com': '172.67.0.3',
  'ordinary.test': '93.184.216.34'
}
vi.mock('node:dns/promises', () => ({
  lookup: async (name: string) => [{ address: ADDRESSES[name] ?? '93.184.216.99', family: 4 }]
}))

const { refusedBrowserTarget } = await import('./policy')
const { TEMPCODE_ORIGIN_REFUSAL } = await import('../remote/tempcodeOrigins')

/** The box as its settings say: one public origin saved, the old name or the new. */
const box = (origin: string) => ({ listenerPorts: [7677], lanAddresses: [], tunnelHosts: [new URL(origin).hostname], remoteRoutes: [origin] })

describe('the computer tools refuse the app’s own web routes on both public names', () => {
  it.each(['https://tempcode.landonhale.com', 'https://docket.landonhale.com'])('saved as %s', async (saved) => {
    for (const url of ['https://tempcode.landonhale.com/ui', 'https://docket.landonhale.com/ui', 'https://docket.landonhale.com/w/doc/x', 'https://docket.landonhale.com/pair', 'https://tempcode.landonhale.com/pair', 'wss://tempcode.landonhale.com/ws']) {
      expect(await refusedBrowserTarget({ browser: true, url }, box(saved))).toBe(TEMPCODE_ORIGIN_REFUSAL)
    }
  })

  it('leaves another site, the guest origin among them, alone', async () => {
    expect(await refusedBrowserTarget({ browser: true, url: 'https://ordinary.test/' }, box('https://tempcode.landonhale.com'))).toBeNull()
    expect(await refusedBrowserTarget({ browser: true, url: 'https://share.landonhale.com/g/x' }, box('https://tempcode.landonhale.com'))).toBeNull()
  })
})

describe('an old native service that cannot read an address keeps every known browser off limits', () => {
  it.each([
    ['at.studio.AsideBrowser', 'Aside'],
    ['com.google.Chrome', 'Google Chrome'],
    ['com.apple.Safari', 'Safari']
  ])('%s', async (bundleId, name) => {
    const { knownBrowser } = await import('./policy')
    expect(knownBrowser({ bundleId, name })).toBe(true)
  })

  it('leaves an app that only has the word in a longer name alone', async () => {
    const { knownBrowser } = await import('./policy')
    expect(knownBrowser({ bundleId: 'com.example.Asides', name: 'Asides' })).toBe(false)
    expect(knownBrowser({ bundleId: 'com.apple.TextEdit', name: 'TextEdit' })).toBe(false)
  })
})
