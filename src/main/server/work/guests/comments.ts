import type { DocThreadRow } from '@shared/contract-work-docs'
import { fileDocName } from 'work-kit/collab-server'
import { changeThread, fileRows } from '../docs/threads'
import type { WorkCtx } from '../modules'
import { canonicalPath } from '../service/ctx'
import type { GuestAsk } from '../service/wire'
import { fileUid } from './fileIdent'
import { isLive, type GuestStore, type StoredLink } from './store'

/**
 * A guest's comments on a document kept as a file (docs/agents/work-guests.md "Comments on a file's link"). A
 * `.tcdoc`'s threads are rows in the app's database (docs/threads.ts), which the Work service never opens: it asks
 * main (`GuestAsk`), and main answers here for that link's own file alone. The rules are the LifeOS document's: a
 * guest starts a comment on words and replies, in plain words the service built into the comment; a view link
 * writes nothing; and a guest learns no other guest's name.
 */

type FileDocLink = StoredLink & { source: Extract<StoredLink['source'], { at: 'file' }> }

/** The live link an ask names, when it is a document kept as a file; else the ask is refused as gone. */
function linkOf(store: GuestStore, linkId: string): FileDocLink {
  const link = store.get(linkId)
  if (!link || !isLive(link) || link.source.at !== 'file' || link.source.table !== 'docs') throw new Error('gone')
  // The file the link was made for, read again here: another file at its path is none of the guest's, nor are its comments.
  if (link.fileUid && fileUid(canonicalPath(link.source.path)) !== link.fileUid) throw new Error('gone')
  return link as FileDocLink
}

/** The document's name as the docs pillar keys its threads: its resolved path's. */
const docOf = (link: FileDocLink): { doc: string; path: string } => {
  const path = canonicalPath(link.source.path)
  return { doc: fileDocName(path), path }
}

/**
 * A document's threads as one guest may read them: the owner by name, the guest as "You", every other guest "A
 * guest", an agent as the owner's assistant. Ids are stand-ins made here, so no principal leaves the host.
 */
export function guestRows(rows: readonly DocThreadRow[], me: string, owner: string): { rows: DocThreadRow[]; names: Record<string, string> } {
  const names: Record<string, string> = { owner, [me]: 'You' }
  const ids = new Map<string, string>([
    ['owner', 'owner'],
    [me, me]
  ])
  const idOf = (author: string): string => {
    let id = ids.get(author)
    if (!id) {
      id = `p${ids.size}`
      ids.set(author, id)
      names[id] = author.startsWith('guest:') ? 'A guest' : author.startsWith('external:') ? author.slice(9).slice(0, 80) || 'Someone' : author.startsWith('agent:') ? `${owner}'s assistant` : owner
    }
    return id
  }
  const out = rows
    .filter((r) => !r.thread.deletedAt)
    .map(({ thread, comments }) => ({
      thread: { ...thread, resolvedByMemberId: null },
      // A reaction names who reacted: none is handed over.
      comments: comments.map((c) => ({ ...c, body: c.deletedAt ? '[]' : c.body, authorMemberId: idOf(c.authorMemberId), reactions: [] }))
    }))
  return { rows: out, names }
}

/** Main's answer to the service about a guest link's own file document. Throws 'gone' for a link that is none. */
export async function answerGuestAsk(ctx: WorkCtx, store: GuestStore, owner: string, ask: GuestAsk): Promise<unknown> {
  const link = linkOf(store, ask.linkId)
  const { doc, path } = docOf(link)
  const me = `guest:${link.id}`
  if (ask.what === 'threads') return guestRows(fileRows(ctx.db, doc), me, owner)
  // A view link writes nothing at all, comments included (the service refuses it first; held here too).
  if (link.role === 'view') throw new Error('This link can view, not comment.')
  const target = { at: 'file' as const, doc, path, source: { at: 'file' as const, host: ctx.host, path } }
  if (ask.threadId !== undefined) {
    // A reply goes only on a thread of this document that still stands.
    if (!fileRows(ctx.db, doc).some((r) => r.thread.publicId === ask.threadId && !r.thread.deletedAt)) throw new Error('That comment is gone.')
    const made = (await changeThread(ctx, target as never, { op: 'reply', threadId: ask.threadId, body: ask.body }, me)) as DocThreadRow['comments'][number]
    ctx.push({ push: 'work.docs', doc, threads: true }, { path })
    return { commentId: made.publicId }
  }
  const made = (await changeThread(ctx, target as never, { op: 'create', body: ask.body, ...(ask.quote ? { quote: ask.quote } : {}) }, me)) as DocThreadRow
  // His own editor on the document hears of it at once, as of his own comment.
  ctx.push({ push: 'work.docs', doc, threads: true }, { path })
  return { threadId: made.thread.publicId }
}
