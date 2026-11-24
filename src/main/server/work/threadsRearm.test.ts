import { describe, expect, it, vi } from 'vitest'
import { threadsPart } from './threads'

/**
 * `ctx.threads.rearm`: the registry boots a harness eagerly at a thread's create, so a pillar that narrows a fresh
 * thread (a mail chat) ends that harness and the first send boots one under the narrowing. A thread with a message
 * in it is left alone.
 */
describe('ctx.threads.rearm', () => {
  const part = (written: boolean) => {
    const restart = vi.fn(async () => undefined)
    const registry = { get: (id: string) => (id === 'gone' ? undefined : { id }), hasUserText: () => written, restart, eventsAfter: () => [] }
    const { threads } = threadsPart({ scopeOf: () => null, log: () => {} } as never, { registry, store: { getSetting: () => null } } as never)
    return { threads, restart }
  }

  it('ends the harness of a fresh thread', async () => {
    const { threads, restart } = part(false)
    await threads.rearm('chat')
    expect(restart).toHaveBeenCalledWith('chat')
  })

  it('leaves a thread with a message in it, and one this host does not have', async () => {
    const written = part(true)
    await written.threads.rearm('chat')
    expect(written.restart).not.toHaveBeenCalled()
    const none = part(false)
    await none.threads.rearm('gone')
    expect(none.restart).not.toHaveBeenCalled()
  })
})
