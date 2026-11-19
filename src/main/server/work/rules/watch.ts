import { errorText } from '@shared/work'
import type { WorkCtx } from '../modules'
import { dropDraft, noteDraft, recordSent, staleDrafts, trackDraft, trackedDraft, trackedDraftIds, TRACK_DAYS } from './store'

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
  _creationTime?: number
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

export interface DraftWatch {
  stop(): void
  /** Stops following these drafts (their thread or workspace was deleted). */
  forget(draftIds: readonly string[]): void
}

export function watchDrafts(ctx: WorkCtx, changed: (workspaceId: string) => void, now = Date.now): DraftWatch {
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

  // Drafts seen before the host last stopped: one sent meanwhile is read now. One older than a month is let go.
  staleDrafts(ctx.db, now() - TRACK_DAYS * 86_400_000)
  for (const id of trackedDraftIds(ctx.db)) follow(id)

  const offHeld = ctx.lifeos.subscribe<DraftRow[]>('outboxHeld:held', { host: ctx.host }, (rows) => {
    if (stopped) return
    const since = now() - TRACK_DAYS * 86_400_000
    for (const id of staleDrafts(ctx.db, since)) unfollow(id)
    for (const row of rows ?? []) {
      const threadId = row.origin?.threadId
      if (row.origin?.app !== 'tempcode' || row.origin.host !== ctx.host || !threadId || row.message?.kind !== 'mail' || row.status !== 'draft') continue
      // A draft older than the watch's month is not taken up again with today's words as the agent's.
      if ((row._creationTime ?? now()) < since) continue
      if (!trackedDraft(ctx.db, row._id)) {
        const workspaceId = ctx.scopeOf(threadId)?.workspaceId
        // A Work Chat's draft belongs to no workspace's rules.
        if (!workspaceId) continue
        if (!trackDraft(ctx.db, { draftId: row._id, workspaceId, sessionId: threadId, agentText: String(row.message.text ?? '') })) continue
      }
      follow(row._id)
    }
  })

  return {
    stop() {
      stopped = true
      offHeld()
      for (const off of follows.values()) off()
      follows.clear()
    },
    forget(draftIds) {
      for (const id of draftIds) unfollow(id)
    }
  }
}
