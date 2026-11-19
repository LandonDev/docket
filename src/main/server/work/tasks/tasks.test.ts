import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { WorkCtx } from '../modules'
import { taskDone } from './index'

/** Done on a task in TempCode is the owner accepting the work of the thread here that worked it, inside the workspace's sector. */
function ctxWith(links: { host: string; threadId: string; title: string }[], sector = 'purdue') {
  const calls: { fn: string; args: unknown }[] = []
  const owner = {
    query: async (fn: string, args: unknown) => (fn === 'tasks:get' ? { task: { sector } } : (calls.push({ fn, args }), links)),
    mutation: async (fn: string, args: unknown) => (calls.push({ fn, args }), { nextId: 'next_1' })
  }
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'code', sector TEXT)")
  db.exec("INSERT INTO workspaces (id, kind, sector) VALUES ('ws-purdue', 'work', 'purdue'), ('ws-life', 'work', 'life'), ('ws-code', 'code', 'purdue')")
  const ctx = { db, host: 'env_box', scopeOf: (id: string) => (id.startsWith('t-life') ? { sector: 'life' } : id.startsWith('t-') ? { sector: 'purdue' } : null), lifeos: { owner: () => owner } } as unknown as WorkCtx
  return { ctx, calls }
}

describe('work.tasks.done', () => {
  it("completes the task with the reason and the link of this host's newest thread on it", async () => {
    const { ctx, calls } = ctxWith([
      { host: 'env_box', threadId: 't-old', title: 'First look' },
      { host: 'env_box', threadId: 't-new', title: 'Book the ballroom' },
      { host: 'env_mac', threadId: 't-mac', title: 'On the Mac' }
    ])
    expect(await taskDone(ctx, 'ws-purdue', 'task_1')).toEqual({ threadId: 't-new', nextId: 'next_1' })
    expect(calls).toEqual([
      { fn: 'workLinks:byEntity', args: { entity: { table: 'tasks', id: 'task_1' } } },
      { fn: 'tasks:complete', args: { id: 'task_1', reason: 'Accepted the work of "Book the ballroom"', threadLink: { host: 'env_box', threadId: 't-new', title: 'Book the ballroom' } } }
    ])
  })

  it("refuses a task of another sector than the workspace's, and completes nothing", async () => {
    const { ctx, calls } = ctxWith([], 'cosmic')
    await expect(taskDone(ctx, 'ws-purdue', 'task_x')).rejects.toThrow("not in this workspace's sector")
    // a code workspace, or one that is not here, has no sector to complete in
    await expect(taskDone(ctx, 'ws-code', 'task_x')).rejects.toThrow('not linked')
    await expect(taskDone(ctx, 'ws-gone', 'task_x')).rejects.toThrow('not linked')
    expect(calls.filter((c) => c.fn === 'tasks:complete')).toEqual([])
  })

  it("never links a thread of another sector than the task's", async () => {
    const { ctx, calls } = ctxWith([{ host: 'env_box', threadId: 't-life-1', title: 'A Life thread' }])
    expect(await taskDone(ctx, 'ws-purdue', 'task_3')).toEqual({ threadId: null, nextId: 'next_1' })
    expect(calls[1]).toEqual({ fn: 'tasks:complete', args: { id: 'task_3' } })
  })

  it('completes it plainly when no thread here worked it', async () => {
    const { ctx, calls } = ctxWith([{ host: 'env_mac', threadId: 't-mac', title: 'On the Mac' }, { host: 'env_box', threadId: 'gone', title: 'Deleted' }])
    expect(await taskDone(ctx, 'ws-purdue', 'task_2')).toEqual({ threadId: null, nextId: 'next_1' })
    expect(calls[1]).toEqual({ fn: 'tasks:complete', args: { id: 'task_2' } })
  })
})
