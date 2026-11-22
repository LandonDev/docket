import { describe, expect, it } from 'vitest'
import { REFUSE_SESSION_TIER } from '../../computer/tierGate'
import { VM_TIER_GATE, vmTiers } from './gate'

const ctx = { threadId: 't1', rootId: 't1', permission: 'auto', app: { pid: 1, bundleId: 'notepad.exe', name: 'Notepad' }, window: null, classes: [], serviceSession: 's1' } as never

describe("the Windows VM's session tier", () => {
  it('admits a chord, a held key and a paste in the guest, where the headless box refuses them', async () => {
    expect(VM_TIER_GATE.admitted(ctx)).toBe(true)
    expect(VM_TIER_GATE.frontAdmitted?.(ctx)).toBe(true)
    const chord = { ...(ctx as object), step: 0, action: { action: 'key', text: 'ctrl+s' }, words: 'press ctrl+s', call: 'c1', signal: new AbortController().signal } as never
    expect(await VM_TIER_GATE.request(chord)).toEqual({ admit: true })
    expect(await REFUSE_SESSION_TIER.request(chord)).toMatchObject({ admit: false, reason: 'no-scheduler' })
    // the session tier in place of the posted ones: real input is what a Save as dialog answers to
    let sent: string[] = []
    await VM_TIER_GATE.run({ ...(ctx as object), tiers: ['ax', 'process', 'session', 'front'], actions: [], signal: new AbortController().signal } as never, async (tiers) => ((sent = tiers), {} as never))
    expect(sent).toEqual(['ax', 'session'])
    // a call that asked for no session tier goes as it asked
    await VM_TIER_GATE.run({ ...(ctx as object), tiers: ['ax'], actions: [], signal: new AbortController().signal } as never, async (tiers) => ((sent = tiers), {} as never))
    expect(sent).toEqual(['ax'])
    expect(vmTiers(['ax', 'process'])).toEqual(['ax', 'process'])
  })
})
