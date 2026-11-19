import { describe, expect, it } from 'vitest'
import type { WorkCtx } from '../modules'
import { taskDone } from './index'

/** Done on a task in TempCode is the owner accepting the work of the thread here that worked it. */
function ctxWith(links: { host: string; threadId: string; title: string }[], sector = 'purdue') {
  const calls: { fn: string; args: unknown }[] = []
  const owner = {
    query: async (fn: string, args: unknown) => (fn === 'tasks:get' ? { task: { sector } } : (calls.push({ fn, args }), links)),
    mutation: async (fn: string, args: unknown) => (calls.push({ fn, args }), { nextId: 'next_1' })
  }
  const ctx = { host: 'env_box', scopeOf: (id: string) => (id.startsWith('t-life') ? { sector: 'life' } : id.startsWith('t-') ? { sector: 'purdue' } : null), lifeos: { owner: () => owner } } as unknown as WorkCtx
  return { ctx, calls }
}

describe('work.tasks.done', () => {
  it("completes the task with the reason and the link of this host's newest thread on it", async () => {
    const { ctx, calls } = ctxWith([
      { host: 'env_box', threadId: 't-old', title: 'First look' },
      { host: 'env_box', threadId: 't-new', title: 'Book the ballroom' },
      { host: 'env_mac', threadId: 't-mac', title: 'On the Mac' }
    ])
    expect(await taskDone(ctx, 'task_1')).toEqual({ threadId: 't-new', nextId: 'next_1' })
    expect(calls).toEqual([
      { fn: 'workLinks:byEntity', args: { entity: { table: 'tasks', id: 'task_1' } } },
      { fn: 'tasks:complete', args: { id: 'task_1', reason: 'Accepted the work of "Book the ballroom"', threadLink: { host: 'env_box', threadId: 't-new', title: 'Book the ballroom' } } }
    ])
  })

  it("never links a thread of another sector than the task's", async () => {
    const { ctx, calls } = ctxWith([{ host: 'env_box', threadId: 't-life-1', title: 'A Life thread' }])
    expect(await taskDone(ctx, 'task_3')).toEqual({ threadId: null, nextId: 'next_1' })
    expect(calls[1]).toEqual({ fn: 'tasks:complete', args: { id: 'task_3' } })
  })

  it('completes it plainly when no thread here worked it', async () => {
    const { ctx, calls } = ctxWith([{ host: 'env_mac', threadId: 't-mac', title: 'On the Mac' }, { host: 'env_box', threadId: 'gone', title: 'Deleted' }])
    expect(await taskDone(ctx, 'task_2')).toEqual({ threadId: null, nextId: 'next_1' })
    expect(calls[1]).toEqual({ fn: 'tasks:complete', args: { id: 'task_2' } })
  })
})
