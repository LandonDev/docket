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
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL)")
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, scope TEXT NOT NULL DEFAULT 'code')")
  db.exec("INSERT INTO workspaces (id, kind, sector) VALUES ('ws-app', 'code', NULL), ('ws-site', 'code', 'cosmic')")
  db.exec("INSERT INTO projects (id, workspace_id) VALUES ('p-app', 'ws-app')")
  // Code threads opened on a task: one in a project of an unlinked workspace, one in the Purdue-linked one, one in a Cosmic-linked one.
  // A thread moved into a project keeps its old workspace column: the project's workspace wins. One outside every workspace names none.
  db.exec("INSERT INTO sessions (id, project_id, workspace_id) VALUES ('c-app', 'p-app', 'ws-site'), ('c-purdue', NULL, 'ws-code'), ('c-cosmic', NULL, 'ws-site'), ('c-loose', NULL, NULL)")
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

  it("names a code thread opened on the task, unless its workspace is linked to another sector", async () => {
    for (const [threadId, named] of [['c-app', true], ['c-purdue', true], ['c-cosmic', false], ['c-loose', false]] as const) {
      const { ctx, calls } = ctxWith([{ host: 'env_box', threadId, title: 'Fix the bracket page' }])
      expect((await taskDone(ctx, 'ws-purdue', 'task_4')).threadId).toBe(named ? threadId : null)
      expect((calls[1]!.args as { threadLink?: unknown }).threadLink !== undefined).toBe(named)
    }
  })

  it('completes it plainly when no thread here worked it', async () => {
    const { ctx, calls } = ctxWith([{ host: 'env_mac', threadId: 't-mac', title: 'On the Mac' }, { host: 'env_box', threadId: 'gone', title: 'Deleted' }])
    expect(await taskDone(ctx, 'ws-purdue', 'task_2')).toEqual({ threadId: null, nextId: 'next_1' })
    expect(calls[1]).toEqual({ fn: 'tasks:complete', args: { id: 'task_2' } })
  })
})
