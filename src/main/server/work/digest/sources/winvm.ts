import type { WinvmState } from '@shared/contract-work-winvm'
import type { Tell } from '@shared/work/tell'
import type { Source } from './index'

/**
 * The Windows VM needs him (docs/agents/work-winvm.md): a failure only he
 * can fix waits for the digest, read from the pillar's `work.winvm.state`
 * every five minutes. A state word (asleep, waking, setting up) is not news;
 * a failure that is gone takes its row with it (`prefix`).
 *
 * The state carries one `error`, the last change's, and does not say which
 * change it was. One case is sure: no disk and an error on a host that can
 * have the VM is a setup that failed before it made one. A setup that failed
 * later, a restore point that failed and a wake that failed all leave the
 * machine asleep or awake with the same bare `error`, so they are told
 * nothing: `WinvmState` would need the failed change named (say `failed:
 * {of: 'setup' | 'point', pointId?}`) for `winvm:setup` past the disk and
 * `winvm:point:<id>`. `work.winvm.points` lists only points kept, never one
 * that failed.
 */

export const winvm: Source = {
  id: 'winvm',
  pillar: 'winvm',
  every: 5 * 60_000,
  prefix: 'winvm:',
  async read(env) {
    // A call that throws keeps what was told: the frame passes no keys on.
    const st = await env.call<WinvmState>('work.winvm.state', {})
    const tells: Tell[] = []
    if (!st.cannot && st.state === 'none' && st.error) {
      tells.push({ kind: 'winvm.failed', workspaceId: null, title: "The Windows VM's setup failed", detail: st.error, key: 'winvm:setup', open: { settings: 'work' } })
    }
    return tells
  }
}
