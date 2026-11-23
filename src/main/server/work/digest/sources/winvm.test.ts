import { describe, expect, it } from 'vitest'
import type { WinvmState } from '@shared/contract-work-winvm'
import type { SourceEnv } from './index'
import { winvm } from './winvm'

const state = (patch: Partial<WinvmState>): WinvmState => ({ state: 'asleep', step: null, error: null, cannot: null, sleepAfter: '30m', since: 0, ...patch })

function envOf(answer: WinvmState | Error): SourceEnv & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    ctx: {} as never,
    modules: [],
    async call<T>(method: string): Promise<T> {
      calls.push(method)
      if (answer instanceof Error) throw answer
      return answer as T
    },
    workspaces: () => [],
    day: '2026-11-23',
    zone: 'America/Chicago',
    since: 0
  }
}

describe('the winvm source', () => {
  it('tells a setup that failed before it made the disk, with the reason as its detail', async () => {
    const env = envOf(state({ state: 'none', error: 'The base image is not there.' }))
    expect(await winvm.read(env, 0)).toEqual([
      { kind: 'winvm.failed', workspaceId: null, title: "The Windows VM's setup failed", detail: 'The base image is not there.', key: 'winvm:setup', open: { settings: 'work' } }
    ])
    expect(env.calls).toEqual(['work.winvm.state'])
  })

  it('tells nothing for a state word, a host that cannot have the VM, or an error it cannot place', async () => {
    for (const st of [
      state({ state: 'asleep' }),
      state({ state: 'waking', step: 'Waking the Windows VM' }),
      state({ state: 'setting-up', step: 'Making the disk' }),
      state({ state: 'none' }),
      state({ state: 'none', error: 'not the box', cannot: 'This host cannot run the Windows VM.' }),
      // a wake, a later setup step or a restore point: the state does not say which
      state({ state: 'asleep', error: 'The guest did not answer.' })
    ])
      expect(await winvm.read(envOf(st), 0)).toEqual([])
  })

  it('lets a failed read throw, so the frame keeps what was told', async () => {
    await expect(winvm.read(envOf(new Error('winvm is not running on this host')), 0)).rejects.toThrow('not running')
  })

  it('is read every five minutes and owns the winvm: keys', async () => {
    expect({ every: winvm.every, prefix: winvm.prefix, pillar: winvm.pillar }).toEqual({ every: 300_000, prefix: 'winvm:', pillar: 'winvm' })
    const env = envOf(state({ state: 'none', error: 'Making the disk failed' }))
    expect(await winvm.read(env, 0)).toEqual(await winvm.read(env, 300_000))
  })
})
