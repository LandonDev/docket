import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DocThreadOp, DocThreadRow } from '@shared/contract-work-docs'
import type { WorkCtx } from '../modules'
import type { DocTarget } from './target'

/**
 * A document's comment threads (docs/agents/work-docs.md "Threads"): a LifeOS
 * document's live in LifeOS (`docThreads`, `docComments`, M17); a `.tcdoc`'s
 * here, in `work_docs_threads`, one JSON list per document. Either way the
 * rows are the shared editor's `ThreadRow`s, and the marks on the words are
 * in the document itself.
 */

export function ensureThreadTables(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS work_docs_threads (doc TEXT PRIMARY KEY, rows TEXT NOT NULL)')
}

/** LifeOS's `docs.threads` row (M17): a thread and its comments, authors as principals or outside names. */
interface LifeosThread {
  thread: { _id: string; quote?: string; resolved: boolean; resolvedAt?: number; resolvedBy?: string; at: number; editedAt: number; deletedAt?: number }
  comments: Array<{
    _id: string
    author?: string
    externalAuthor?: { name: string }
    body: string
    reactions?: Array<{ emoji: string; at: number; by: string[] }>
    at: number
    editedAt: number
    deletedAt?: number
  }>
}

/** M17's mapping onto the editor's rows: ids to `publicId`, an outside author's name as the author. */
export function fromLifeos(rows: readonly LifeosThread[]): DocThreadRow[] {
  return rows.map(({ thread, comments }) => ({
    thread: {
      publicId: thread._id,
      ...(thread.quote !== undefined ? { quote: thread.quote } : {}),
      resolved: thread.resolved,
      resolvedAt: thread.resolvedAt ?? null,
      resolvedByMemberId: thread.resolvedBy ?? null,
      createdAt: thread.at,
      updatedAt: thread.editedAt,
      deletedAt: thread.deletedAt ?? null
    },
    comments: comments.map((c) => ({
      publicId: c._id,
      body: c.body,
      authorMemberId: c.author ?? `external:${c.externalAuthor?.name ?? 'Someone'}`,
      reactions: (c.reactions ?? []).map((r) => ({ emoji: r.emoji, createdAt: r.at, memberIds: r.by })),
      createdAt: c.at,
      updatedAt: c.editedAt,
      deletedAt: c.deletedAt ?? null
    }))
  }))
}

export async function readThreads(ctx: WorkCtx, t: DocTarget): Promise<DocThreadRow[]> {
  if (t.at === 'lifeos') return fromLifeos(await ctx.lifeos.owner().query<LifeosThread[]>('docs:threads', { docId: t.docId }))
  return fileRows(ctx.db, t.doc)
}

function fileRows(db: DatabaseSync, doc: string): DocThreadRow[] {
  const row = db.prepare('SELECT rows FROM work_docs_threads WHERE doc = ?').get(doc) as { rows: string } | undefined
  return row ? (JSON.parse(row.rows) as DocThreadRow[]) : []
}

/** What a change answers: the editor's `createThread` wants the row, `addComment` the comment. */
export type ThreadAnswer = DocThreadRow | DocThreadRow['comments'][number] | { ok: true }

/** One of the editor's writes, by `author` (a principal). */
export async function changeThread(ctx: WorkCtx, t: DocTarget, change: DocThreadOp, author: string, now = Date.now()): Promise<ThreadAnswer> {
  if (t.at === 'lifeos') return changeLifeos(ctx, t.docId, change, author)
  return changeFile(ctx.db, t.doc, change, author, now)
}

async function changeLifeos(ctx: WorkCtx, docId: string, change: DocThreadOp, author: string): Promise<ThreadAnswer> {
  const lifeos = ctx.lifeos.owner()
  const reread = async (pick: (rows: DocThreadRow[]) => ThreadAnswer | undefined): Promise<ThreadAnswer> =>
    pick(fromLifeos(await lifeos.query<LifeosThread[]>('docs:threads', { docId }))) ?? { ok: true }
  switch (change.op) {
    case 'create': {
      const made = await lifeos.mutation<{ threadId: string }>('docs:createThread', { docId, body: change.body, ...(change.quote ? { quote: change.quote } : {}), author })
      return reread((rows) => rows.find((r) => r.thread.publicId === made.threadId))
    }
    case 'reply': {
      const id = await lifeos.mutation<string | { commentId: string }>('docs:addComment', { threadId: change.threadId, body: change.body, author })
      const commentId = typeof id === 'string' ? id : id.commentId
      return reread((rows) => rows.flatMap((r) => r.comments).find((c) => c.publicId === commentId))
    }
    case 'edit':
      await lifeos.mutation('docs:updateComment', { id: change.commentId, body: change.body })
      return { ok: true }
    case 'deleteComment':
      await lifeos.mutation('docs:deleteComment', { id: change.commentId })
      return { ok: true }
    case 'deleteThread':
      await lifeos.mutation('docs:deleteThread', { id: change.threadId })
      return { ok: true }
    case 'resolve':
      await lifeos.mutation('docs:setResolved', { id: change.threadId, resolved: change.resolved, by: author })
      return { ok: true }
    case 'react':
      await lifeos.mutation('docs:setReaction', { id: change.commentId, emoji: change.emoji, reacted: change.reacted, by: author })
      return { ok: true }
  }
}

function changeFile(db: DatabaseSync, doc: string, change: DocThreadOp, author: string, now: number): ThreadAnswer {
  const rows = fileRows(db, doc)
  const thread = (id: string) => {
    const found = rows.find((r) => r.thread.publicId === id)
    if (!found) throw new Error('that thread is not on this document')
    return found
  }
  const comment = (id: string) => {
    for (const r of rows) {
      const c = r.comments.find((x) => x.publicId === id)
      if (c) return { row: r, c }
    }
    throw new Error('that comment is not on this document')
  }
  let answer: ThreadAnswer = { ok: true }
  switch (change.op) {
    case 'create': {
      const made: DocThreadRow = {
        thread: { publicId: randomUUID(), ...(change.quote ? { quote: change.quote } : {}), resolved: false, resolvedAt: null, resolvedByMemberId: null, createdAt: now, updatedAt: now, deletedAt: null },
        comments: [{ publicId: randomUUID(), body: change.body, authorMemberId: author, reactions: [], createdAt: now, updatedAt: now, deletedAt: null }]
      }
      rows.push(made)
      answer = made
      break
    }
    case 'reply': {
      const r = thread(change.threadId)
      const c = { publicId: randomUUID(), body: change.body, authorMemberId: author, reactions: [], createdAt: now, updatedAt: now, deletedAt: null }
      r.comments.push(c)
      r.thread.updatedAt = now
      answer = c
      break
    }
    case 'edit': {
      const { c } = comment(change.commentId)
      c.body = change.body
      c.updatedAt = now
      break
    }
    case 'deleteComment': {
      // Kept, words gone, as LifeOS keeps it: a reply under it still reads in place.
      const { c } = comment(change.commentId)
      c.body = '[]'
      c.deletedAt = now
      break
    }
    case 'deleteThread':
      thread(change.threadId).thread.deletedAt = now
      break
    case 'resolve': {
      const r = thread(change.threadId)
      r.thread.resolved = change.resolved
      r.thread.resolvedAt = change.resolved ? now : null
      r.thread.resolvedByMemberId = change.resolved ? author : null
      break
    }
    case 'react': {
      const { c } = comment(change.commentId)
      const at = c.reactions.find((x) => x.emoji === change.emoji)
      if (change.reacted) {
        if (!at) c.reactions.push({ emoji: change.emoji, createdAt: now, memberIds: [author] })
        else if (!at.memberIds.includes(author)) at.memberIds.push(author)
      } else if (at) {
        at.memberIds = at.memberIds.filter((m) => m !== author)
        if (at.memberIds.length === 0) c.reactions = c.reactions.filter((x) => x !== at)
      }
      break
    }
  }
  db.prepare('INSERT INTO work_docs_threads (doc, rows) VALUES (?, ?) ON CONFLICT(doc) DO UPDATE SET rows = excluded.rows').run(doc, JSON.stringify(rows))
  return answer
}
