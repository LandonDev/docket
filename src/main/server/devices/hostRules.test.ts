import { afterEach, describe, expect, it } from 'vitest'
import type { Principal } from '@shared/capabilities'
import { givenHost, givenHostRefusal, relayedRefusal } from './hostRules'

const remote = (via?: string): Principal => ({ kind: 'remote', keyId: 'k', name: 'phone', audience: 'client', caps: ['admin', 'read'], ...(via ? { via } : {}) })

afterEach(() => {
  givenHost.current = () => false
})

describe('the destination host checks a relayed lane itself', () => {
  it('runs a relayed request only when RELAY_METHODS carries it, whatever caps the carrier named', () => {
    expect(relayedRefusal(remote('env_box'), 'workspace.list')).toBeNull()
    expect(relayedRefusal(remote('env_box'), 'work.lifeos.setToken')).toMatch(/not carried/)
    expect(relayedRefusal(remote('env_box'), 'accounts.push')).toMatch(/not carried/)
    expect(relayedRefusal(remote('env_box'), 'remote.keys.create')).toMatch(/not carried/)
    // a direct key, and the local window, are judged by their caps alone
    expect(relayedRefusal(remote(), 'accounts.push')).toBeNull()
    expect(relayedRefusal({ kind: 'local' }, 'work.lifeos.setToken')).toBeNull()
  })
})

describe('a given computer keeps its credentials to itself', () => {
  it('refuses the LifeOS session and credential methods to every remote principal, never to its own window', () => {
    givenHost.current = () => true
    for (const m of ['work.lifeos.jwt', 'accounts.pull', 'accounts.push', 'addons.grant.refresh']) {
      expect(givenHostRefusal(remote(), m), m).toMatch(/own/)
      expect(givenHostRefusal(remote('env_box'), m), m).toMatch(/own/)
      expect(givenHostRefusal({ kind: 'local' }, m), m).toBeNull()
    }
    expect(givenHostRefusal(remote(), 'session.list')).toBeNull()
  })

  it('changes nothing on a host that is not a given computer', () => {
    expect(givenHostRefusal(remote(), 'work.lifeos.jwt')).toBeNull()
  })
})
