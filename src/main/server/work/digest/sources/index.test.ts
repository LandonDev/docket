import { describe, expect, it, vi } from 'vitest'
import type { Tell } from '@shared/work/tell'
import type { WorkModule } from '../../modules'
import { Sources, type Source } from './index'

const tell = (key: string): Tell => ({ kind: 'test.thing', workspaceId: null, title: `Thing ${key}`, key })
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function frame(sources: Source[], modules: Partial<WorkModule>[] = [{ id: 'mail' }, { id: 'winvm' }] as Partial<WorkModule>[]) {
  const told: Tell[] = []
  const only: [string, readonly string[]][] = []
  const logs: string[] = []
  const ctx = { tell: Object.assign((t: Tell) => void told.push(t), { only: (p: string, k: readonly string[]) => void only.push([p, k]) }), log: (l: string) => void logs.push(l) }
  const s = new Sources({ ctx: ctx as never, modules: () => modules as WorkModule[], sources, day: () => '2026-11-23', zone: () => 'America/Chicago', since: () => 0 })
  return { s, told, only, logs }
}

const source = (o: Partial<Source> & { id: string }): Source => ({ pillar: null, every: 0, read: () => [tell(o.id)], ...o })

describe('the sources frame', () => {
  it('skips a source whose pillar is not loaded', async () => {
    const read = vi.fn(() => [tell('x')])
    const { s, told } = frame([source({ id: 'guests', pillar: 'docs', read })])
    await s.beforeDay(0)
    expect(read).not.toHaveBeenCalled()
    expect(told).toEqual([])
  })

  it('reads a source with no beat only before a day is made', async () => {
    const read = vi.fn(() => [tell('waiting')])
    const { s, told } = frame([source({ id: 'waiting', pillar: 'mail', read })])
    s.beat(0)
    await flush()
    expect(read).not.toHaveBeenCalled()
    await s.beforeDay(0)
    expect(read).toHaveBeenCalledTimes(1)
    expect(told).toEqual([tell('waiting')])
  })

  it('reads a beat source at the first beat and again only once its beat has passed, never before a day', async () => {
    const read = vi.fn(() => [])
    const { s } = frame([source({ id: 'winvm', pillar: 'winvm', every: 1000, read })])
    s.beat(0)
    s.beat(999)
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    s.beat(1000)
    await flush()
    expect(read).toHaveBeenCalledTimes(2)
    await s.beforeDay(1500)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('logs a source that throws and reads the rest', async () => {
    const { s, told, only, logs } = frame([
      source({ id: 'broken', prefix: 'broken:', read: () => Promise.reject(new Error('it broke')) }),
      source({ id: 'fine' })
    ])
    await s.beforeDay(0)
    expect(logs).toEqual(['digest: the broken source was not read: it broke'])
    expect(told).toEqual([tell('fine')])
    // a source that threw ends nothing it told before
    expect(only).toEqual([])
  })

  it("with a prefix, passes the keys still named, its tells' own or the read's keep", async () => {
    const { s, only } = frame([
      source({ id: 'a', prefix: 'a:', read: () => [tell('a:1'), tell('a:2')] }),
      source({ id: 'b', prefix: 'b:', read: () => ({ tells: [], keep: ['b:9'] }) }),
      source({ id: 'c', read: () => [tell('c:1')] })
    ])
    await s.beforeDay(0)
    expect(only).toEqual([
      ['a:', ['a:1', 'a:2']],
      ['b:', ['b:9']]
    ])
  })

  it("asks another pillar through its own handle as this host's reader", async () => {
    const handle = vi.fn(async () => ({ handled: true as const, result: { n: 2 } }))
    let got: unknown
    let refused = ''
    const { s } = frame(
      [
        source({
          id: 'asks',
          pillar: 'mail',
          read: async (env) => {
            got = await env.call('work.mail.waiting', { workspaceId: 'ws-cosmic' })
            refused = await env.call('work.docs.find', {}).then(() => '', (e: Error) => e.message)
            return []
          }
        })
      ],
      [{ id: 'mail', handle } as unknown as Partial<WorkModule>]
    )
    await s.beforeDay(0)
    expect(got).toEqual({ n: 2 })
    expect(handle).toHaveBeenCalledWith({ id: 'digest', method: 'work.mail.waiting', params: { workspaceId: 'ws-cosmic' } }, expect.anything(), { kind: 'local', caps: ['read'] })
    expect(refused).toBe('docs is not running on this host')
  })
})
