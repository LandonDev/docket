import { expect, it } from 'vitest'
import { writtenByOwner } from '@shared/events'
import { userTextByOf } from './userTextBy'

it("a window of this host is the owner; a client key that may approve is the owner's device; any other key, and every facade key, is not", () => {
  expect(userTextByOf({ kind: 'local' })).toEqual({ kind: 'owner' })
  const key = (audience: 'client' | 'mcp', caps: ('read' | 'operate' | 'approve' | 'admin')[]) => userTextByOf({ kind: 'remote', keyId: 'k1', name: 'Phone', audience, caps })
  expect(key('client', ['read', 'operate', 'approve'])).toEqual({ kind: 'key', keyId: 'k1', owner: true })
  expect(key('client', ['admin'])).toEqual({ kind: 'key', keyId: 'k1', owner: true })
  expect(key('client', ['read', 'operate'])).toEqual({ kind: 'key', keyId: 'k1', owner: false })
  expect(key('mcp', ['admin'])).toEqual({ kind: 'key', keyId: 'k1', owner: false })
  expect([key('client', ['approve']), key('mcp', ['approve']), { kind: 'thread', sessionId: 's' } as const, { kind: 'host', environmentId: 'e' } as const, { kind: 'app' } as const].map(writtenByOwner)).toEqual([true, false, false, false, false])
})
