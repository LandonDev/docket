import { CLIPBOARD_TEXT_MAX_BYTES, type ClipboardText } from '@shared/computer/protocol'
import type { ComputerService } from '../../computer/service'

/**
 * The Windows VM's clipboard for the person at the picture (docs/agents/work-winvm.md "The clipboard"): his
 * paste goes in as the guest's clipboard text and a Ctrl+V, his copy in the guest comes out as text, and at Hand
 * back the guest's clipboard is put back as it was before he took over, so nothing he copied is left for an agent.
 * Through the VM's own service (`clipboard.read`, `clipboard.write`, §29.8), text only, 1 MB at most. The picture
 * (B7's VideoSource for `vm:windows`) calls `paste` and `copied`; his Take over and Hand back (B8) call `save` and
 * `restore`. Each wakes the machine first.
 */

/** The service session his own keys go through: no thread's, so no thread's book or lease is touched. */
export const OWNER_SESSION = 'owner:vm'

export const TOO_LONG = `The clipboard takes at most ${Math.round(CLIPBOARD_TEXT_MAX_BYTES / 1024)} KB of text.`

export interface VmClipboardDeps {
  service(): Pick<ComputerService, 'request'>
  /** wakes the machine (the keeper's `wake`) */
  wake(): Promise<unknown>
}

export class VmClipboard {
  /** the guest's text when he took over: put back at Hand back; undefined while nothing is saved */
  private saved: { text: string | null } | undefined

  constructor(private readonly d: VmClipboardDeps) {}

  /** His paste: his text on the guest's clipboard, then Ctrl+V to the app in front, at the session tier. */
  async paste(text: string): Promise<void> {
    if (new TextEncoder().encode(text).length > CLIPBOARD_TEXT_MAX_BYTES) throw new Error(TOO_LONG)
    await this.d.wake()
    const service = this.d.service()
    await service.request('clipboard.write', { text })
    const { apps } = await service.request('apps.list', {})
    const front = apps.find((a) => a.active)
    if (!front) return
    await service.request('session.open', { session: OWNER_SESSION })
    await service.request('action.run', { session: OWNER_SESSION, app: { pid: front.pid }, action: { action: 'key', text: 'ctrl+v' }, tiers: ['session'] } as never)
  }

  /** His copy in the guest, for the viewer to hand to his own clipboard: its text (cut at 1 MB), or null. */
  async copied(): Promise<ClipboardText> {
    await this.d.wake()
    return this.d.service().request('clipboard.read', {})
  }

  /** At Take over: the guest's clipboard as it is now, kept here until Hand back. */
  async save(): Promise<void> {
    await this.d.wake()
    const { text, truncated } = await this.d.service().request('clipboard.read', {})
    // a clipboard past the cap cannot come back whole: it comes back empty, never cut
    this.saved = { text: truncated ? null : text }
  }

  /** At Hand back: the guest's clipboard as it was at Take over (empty when it held no text then). */
  async restore(): Promise<void> {
    const saved = this.saved
    this.saved = undefined
    await this.d.wake()
    await this.d.service().request('clipboard.write', { text: saved ? saved.text : null })
  }
}
