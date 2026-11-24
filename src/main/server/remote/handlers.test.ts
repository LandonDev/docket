import { describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import { openDb } from '../db'
import { RemoteAuth } from './auth'
import { handleRemote, type RemoteContext } from './handlers'

describe("revoking a given computer's key", () => {
  it('is refused on the socket and over HTTP alike (one guard in RemoteAuth); any other key revokes, and the box itself still can', async () => {
    const auth = new RemoteAuth(openDb(':memory:'))
    const pc = (await auth.createKey({ name: 'PC', audience: 'client', caps: ['read'], createdBy: 'test' })).key
    const phone = (await auth.createKey({ name: 'Phone', audience: 'client', caps: ['read'], createdBy: 'test' })).key
    auth.setRevokeGuard((id) => (id === pc.id ? 'refused: Remove it under Computers' : null))
    const ctx = { auth } as unknown as RemoteContext
    const revoke = (id: string) => handleRemote({ id: '1', method: 'remote.keys.revoke', params: { id } } as ClientRequest, ctx)
    await expect(revoke(pc.id)).rejects.toThrow(/Remove it under Computers/)
    expect(() => auth.revokeByOwner(pc.id)).toThrow(/Remove it under Computers/)
    expect(auth.getKey(pc.id)!.revokedAt).toBeNull()
    await expect(revoke(phone.id)).resolves.toEqual({ handled: true, result: true })
    expect(auth.revokeKey(pc.id)).toBe(true)
  })
})
