import { errorText } from '@shared/work'
import type { WorkCtx } from '../modules'
import { dropDraft, noteDraft, recordSent, trackDraft, trackedDraft, trackedDraftIds } from './store'

/**
 * Watches the drafts this host's Work threads make, from the moment the host
 * first sees one until it is sent (docs/agents/work-rules.md "Proposals").
 * What the agent wrote is kept at first sight; what LifeOS sent is read
 * once the row says `sent`; the two make the edit. A draft discarded, or
 * one this host's threads did not make, leaves nothing behind.
 */

type Who = { name?: string; address?: string }
interface DraftRow {
  _id: string
  status: string
  sentAt?: number
  editedAt?: number
  message: { kind: string; subject?: string; text?: string; to?: Who[] }
  origin?: { app?: string; threadId?: string; host?: string }
  proposed?: { text?: string }
}

/** "Sam Ortiz", or "Sam Ortiz and 2 others". */
export function recipientOf(to: readonly Who[] | undefined): string {
  const list = to ?? []
  const first = list[0]?.name?.trim() || list[0]?.address?.trim() || 'someone'
  return list.length > 1 ? `${first} and ${list.length - 1} ${list.length === 2 ? 'other' : 'others'}` : first
}

export function watchDrafts(ctx: WorkCtx, changed: (workspaceId: string) => void): () => void {
  const follows = new Map<string, () => void>()
  let stopped = false

  const unfollow = (id: string): void => {
    const off = follows.get(id)
    follows.delete(id)
    // A subscription may answer while it is being made: let it finish before it is closed.
    if (off) queueMicrotask(off)
  }

  const onDraft = (id: string, got: { row: DraftRow } | null | undefined): void => {
    if (stopped) return
    try {
      const row = got?.row
      if (!row || row.message?.kind !== 'mail') {
        dropDraft(ctx.db, id)
        unfollow(id)
        return
      }
      if (row.status === 'draft') noteDraft(ctx.db, id, String(row.message.text ?? ''), row.proposed?.text ?? null)
      if (row.status !== 'sent') return
      const workspace = recordSent(ctx.db, {
        draftId: id,
        recipient: recipientOf(row.message.to),
        subject: String(row.message.subject ?? '').trim(),
        sentAt: Math.round(row.sentAt ?? Date.now()),
        text: String(row.message.text ?? '')
      })
      unfollow(id)
      if (workspace) changed(workspace)
    } catch (err) {
      ctx.log(`rules: draft ${id}: ${errorText(err)}`)
    }
  }

  const follow = (id: string): void => {
    if (follows.has(id) || stopped) return
    follows.set(id, () => {})
    const off = ctx.lifeos.subscribe<{ row: DraftRow } | null>('compose:get', { id }, (got) => onDraft(id, got))
    if (follows.has(id)) follows.set(id, off)
    else queueMicrotask(off)
  }

  // Drafts seen before the host last stopped: one sent meanwhile is read now.
  for (const id of trackedDraftIds(ctx.db)) follow(id)

  const offHeld = ctx.lifeos.subscribe<DraftRow[]>('outboxHeld:held', { host: ctx.host }, (rows) => {
    if (stopped) return
    for (const row of rows ?? []) {
      const threadId = row.origin?.threadId
      if (row.origin?.app !== 'tempcode' || row.origin.host !== ctx.host || !threadId || row.message?.kind !== 'mail' || row.status !== 'draft') continue
      if (!trackedDraft(ctx.db, row._id)) {
        const workspaceId = ctx.scopeOf(threadId)?.workspaceId
        // A Work Chat's draft belongs to no workspace's rules.
        if (!workspaceId) continue
        if (!trackDraft(ctx.db, { draftId: row._id, workspaceId, sessionId: threadId, agentText: String(row.message.text ?? '') })) continue
      }
      follow(row._id)
    }
  })

  return () => {
    stopped = true
    offHeld()
    for (const off of follows.values()) off()
    follows.clear()
  }
}
