import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Capability } from '@shared/capabilities'
import type { WinvmStill } from '@shared/contract-work-winvm'
import { mayWatch } from '@shared/video/access'
import type { Caller } from '../modules'

/**
 * The Windows VM's last picture, kept at sleep (docs/agents/work-winvm.md
 * "The still"): QMP's screenshot of the guest just before it hibernates, as
 * one JPEG under `<userData>/winvm/picture/`, so the Computers page shows the
 * desk as he left it, washed back, while it sleeps and wakes. Served by
 * `work.winvm.still` to whoever may watch the VM (`mayWatch`), as its video is.
 */

/** The still's long edge: enough for the stage on his largest display, washed back behind words. */
export const STILL_EDGE = 1920

export interface VmStillDeps {
  /** `<userData>/winvm/picture` */
  dir: string
  /** QMP's screenshot of the guest's screen, as PNG */
  screenshot(): Promise<Buffer>
  jpeg(png: Buffer, maxEdge: number): Promise<{ data: string; width: number; height: number }>
  now?: () => number
}

export class VmStill {
  constructor(private readonly d: VmStillDeps) {}

  private get file(): string {
    return join(this.d.dir, 'still.json')
  }

  /** Takes the screen now and keeps it in place of the last; written whole, so a read never sees half of one. */
  async keep(): Promise<void> {
    const { data, width, height } = await this.d.jpeg(await this.d.screenshot(), STILL_EDGE)
    const still: WinvmStill = { data, width, height, at: (this.d.now ?? Date.now)() }
    mkdirSync(this.d.dir, { recursive: true, mode: 0o700 })
    const part = `${this.file}.part`
    writeFileSync(part, JSON.stringify(still), { mode: 0o600 })
    renameSync(part, this.file)
  }

  /** The kept picture; null before the first sleep, or when it cannot be read. */
  read(): WinvmStill | null {
    if (!existsSync(this.file)) return null
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as WinvmStill
      return typeof s.data === 'string' && s.width > 0 && s.height > 0 ? s : null
    } catch {
      return null
    }
  }
}

/**
 * Why `by` may not have the VM's still, or null: the rule its video has (`mayWatch`). A thread never; this host's
 * own socket only where it is a person's desktop (never the box); a remote key with `approve` made for a client.
 */
export function stillRefusal(by: Caller, desktop: boolean): string | null {
  if (by.kind === 'model') return 'forbidden: work.winvm.still is not a thread\'s'
  const principal = by.kind === 'local' ? ({ kind: 'local' } as const) : ({ kind: 'remote', keyId: by.keyId ?? '', name: '', audience: by.audience ?? 'mcp', caps: by.caps as Capability[] } as const)
  if (mayWatch(principal, { desktop })) return null
  return by.kind === 'local' ? "forbidden: work.winvm.still is not served on this host's own socket" : 'forbidden: work.winvm.still needs approve'
}

let still: VmStill | null = null
/** The box's still, wired with the VM's picture (host.ts); null where there is none. */
export function configureVmStill(s: VmStill | null): void {
  still = s
}
export const vmStill = (): VmStill | null => still
