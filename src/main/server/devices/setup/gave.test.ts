import { describe, expect, it, vi } from 'vitest'
import { clearGivenWork, gaveOf, noteGave, tokenDigest } from './gave'

const memStore = () => {
  const m = new Map<string, string>()
  return { getSetting: (k: string) => m.get(k) ?? null, setSetting: (k: string, v: string | null) => void (v === null ? m.delete(k) : m.set(k, v)) }
}

describe("Remove's Work step (F16)", () => {
  it('signs out only the session setup made, never one that was here before or came later', async () => {
    const store = memStore()
    const signOut = vi.fn(async () => {})
    // Setup gave nothing: his own session stays.
    expect(await clearGivenWork({ store, current: () => 'lo_his', signOut })).toBe(false)
    noteGave(store, { work: tokenDigest('lo_setup') })
    noteGave(store, { reader: true })
    expect(gaveOf(store)).toEqual({ work: tokenDigest('lo_setup'), reader: true })
    // He signed in by hand since: another token, left alone.
    expect(await clearGivenWork({ store, current: () => 'lo_later', signOut })).toBe(false)
    expect(signOut).not.toHaveBeenCalled()
    expect(await clearGivenWork({ store, current: () => 'lo_setup', signOut })).toBe(true)
    expect(signOut).toHaveBeenCalledOnce()
  })
})
