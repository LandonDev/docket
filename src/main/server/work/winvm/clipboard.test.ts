import { describe, expect, it } from 'vitest'
import { CLIPBOARD_TEXT_MAX_BYTES, COMPUTER_METHODS } from '@shared/computer/protocol'
import { OWNER_SESSION, TOO_LONG, VmClipboard } from './clipboard'

/**
 * The VM's clipboard over a fake service: his paste is the guest's clipboard
 * text and a Ctrl+V to the app in front, his copy comes out as text, and the
 * guest's clipboard is put back at Hand back as it was at Take over.
 */

function fake(start: string | null = null, truncated = false) {
  const calls: { method: string; params: unknown }[] = []
  let text = start
  let wakes = 0
  const service = {
    async request(method: string, params: unknown) {
      calls.push({ method, params })
      if (method === 'clipboard.read') return { text, truncated }
      if (method === 'clipboard.write') text = (params as { text: string | null }).text
      if (method === 'apps.list') return { apps: [{ pid: 7, name: 'Notepad', bundleId: 'notepad.exe', active: true, hidden: false }, { pid: 8, name: 'Edge', bundleId: 'msedge.exe', active: false, hidden: false }] }
      return {}
    }
  }
  const clip = new VmClipboard({ service: () => service as never, wake: async () => void wakes++ })
  return { clip, calls, now: () => text, wakes: () => wakes }
}

describe("the VM's clipboard", () => {
  it('pastes his text: on the guest clipboard, then Ctrl+V to the app in front at the session tier, waking it first', async () => {
    const f = fake()
    await f.clip.paste('from his Mac')
    expect(f.wakes()).toBe(1)
    expect(f.now()).toBe('from his Mac')
    expect(f.calls.map((c) => c.method)).toEqual(['clipboard.write', 'apps.list', 'session.open', 'action.run'])
    expect(f.calls[3].params).toEqual({ session: OWNER_SESSION, app: { pid: 7 }, action: { action: 'key', text: 'ctrl+v' }, tiers: ['session'] })
    // what it sends is what the wire takes
    expect(COMPUTER_METHODS['action.run'].params.safeParse(f.calls[3].params).success).toBe(true)
  })

  it('refuses a paste past 1 MB, sending nothing', async () => {
    const f = fake()
    await expect(f.clip.paste('x'.repeat(CLIPBOARD_TEXT_MAX_BYTES + 1))).rejects.toThrow(TOO_LONG)
    expect(f.calls).toEqual([])
  })

  it("hands out his copy in the guest as text", async () => {
    expect(await fake('copied there').clip.copied()).toEqual({ text: 'copied there', truncated: false })
  })

  it('puts the clipboard back at Hand back as it was at Take over, whatever he copied between', async () => {
    const f = fake('the agent\'s text')
    await f.clip.save()
    await f.clip.paste('his secret')
    await f.clip.restore()
    expect(f.now()).toBe("the agent's text")
  })

  it('empties it at Hand back when it held no text, or more than could come back whole, or nothing was saved', async () => {
    const empty = fake(null)
    await empty.clip.save()
    await empty.clip.paste('his secret')
    await empty.clip.restore()
    expect(empty.now()).toBeNull()
    const huge = fake('a long clipboard…', true)
    await huge.clip.save()
    await huge.clip.restore()
    expect(huge.now()).toBeNull()
    const none = fake('his copy')
    await none.clip.restore()
    expect(none.now()).toBeNull()
  })

  it('the wire holds the two methods to their shapes', () => {
    expect(COMPUTER_METHODS['clipboard.write'].params.safeParse({ text: null }).success).toBe(true)
    expect(COMPUTER_METHODS['clipboard.write'].params.safeParse({ text: 'é'.repeat(CLIPBOARD_TEXT_MAX_BYTES / 2 + 1) }).success).toBe(false)
    expect(COMPUTER_METHODS['clipboard.read'].result.safeParse({ text: null, truncated: false }).success).toBe(true)
  })
})
