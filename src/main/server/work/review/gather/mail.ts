import type { ReviewAnswer, ReviewSent, SlippedRow } from '@shared/work/review'
import type { LifeosClient } from '../../lifeos/ctx'
import { personName, text, type Asked } from './common'

/**
 * Mail, from LifeOS: what he sent in the week (`review:sentBetween`), which of his mails got an answer
 * (`review:answeredBetween`, kept from the day LifeOS began keeping them), and the mails still waiting past their
 * time (`mailWaits:list`, the Waiting on mailbox).
 */

type Address = { name?: string; address: string }
type SentRow = { id: string; threadId: string; subject?: string; to?: Address[]; sentAt: number; sector: string }
type AnswerRow = { threadId: string; subject?: string; sector: string; answeredAt: number; by?: string }
type WaitRow = { _id: string; subject?: string; sector?: string; waiting: { since: number; dueAt: number; to?: Address[] } }

const NAMED = 4
const WAIT_PAGES = 3
const WAIT_PAGE = 100

export async function sentBetween(owner: LifeosClient, from: number, to: number, asked: Pick<Asked, 'only'>): Promise<ReviewSent[]> {
  if (to <= from) return []
  const rows = await owner.query<SentRow[]>('review:sentBetween', { from, to })
  return (rows ?? [])
    .filter((r) => asked.only === undefined || r.sector === asked.only)
    .map((r) => ({
      id: r.id,
      threadId: r.threadId,
      subject: text(r.subject) || '(no subject)',
      to: (r.to ?? []).slice(0, NAMED).map(personName),
      addresses: (r.to ?? []).slice(0, 20).map((a) => a.address.toLowerCase().slice(0, 320)),
      at: r.sentAt,
      sector: r.sector
    }))
}

export async function answeredBetween(owner: LifeosClient, from: number, to: number, asked: Pick<Asked, 'only'>): Promise<{ rows: ReviewAnswer[]; answeredSince: number | null }> {
  const got = await owner.query<{ rows: AnswerRow[]; answeredSince: number | null }>('review:answeredBetween', { from, to })
  const rows = (got?.rows ?? [])
    .filter((r) => asked.only === undefined || r.sector === asked.only)
    .map((r) => ({ threadId: r.threadId, subject: text(r.subject) || '(no subject)', by: text(r.by, 320) || 'Someone', at: r.answeredAt, sector: r.sector }))
  return { rows, answeredSince: got?.answeredSince ?? null }
}

/** The mails that had waited past their time by `cut` and still wait. */
export async function waitingPast(owner: LifeosClient, cut: number, asked: Pick<Asked, 'only'>): Promise<SlippedRow[]> {
  const out: SlippedRow[] = []
  let cursor: string | null = null
  for (let page = 0; page < WAIT_PAGES; page++) {
    const got: { page: WaitRow[]; isDone: boolean; continueCursor: string } = await owner.query('mailWaits:list', { paginationOpts: { numItems: WAIT_PAGE, cursor } })
    for (const w of got?.page ?? []) {
      if (w.waiting.dueAt > cut || (asked.only !== undefined && (w.sector ?? null) !== asked.only)) continue
      const to = w.waiting.to ?? []
      out.push({ key: `mail:${w._id}`, ref: { kind: 'mail', threadId: w._id, since: w.waiting.since }, sector: w.sector ?? null, workspaceId: null, title: text(w.subject) || '(no subject)', at: w.waiting.since, people: to.slice(0, NAMED).map(personName), others: to.length, open: true })
    }
    if (!got || got.isDone) break
    cursor = got.continueCursor
  }
  return out
}
