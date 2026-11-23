import { MENTION_ORDER, MENTION_PER_KIND, mentionMatches, type CanvasKind, type ChipKind, type MentionAnswer, type MentionHit, type MentionReach } from '@shared/work'
import type { Caller, MentionSource, WorkCtx, WorkModule } from '../modules'
import { canvasStoreOf } from './store'

/**
 * The composer's `@` on the host (docs/agents/work-canvas.md "Mentions"):
 * `work.canvas.mentions` asks every pillar's `mentions` for the text, each
 * within the thread's reach, and answers the hits in kind order. A code
 * thread is asked only the LifeOS kinds; a kind that fails or is slow is
 * named in `failed` and the rest still answer.
 */

/** A kind that has not answered by then is left out and named. */
const SOURCE_WAIT_MS = 4000

const rank = (kind: ChipKind): number => {
  const at = MENTION_ORDER.indexOf(kind)
  return at < 0 ? MENTION_ORDER.length : at
}

export async function searchMentions(
  ctx: WorkCtx,
  reach: MentionReach,
  text: string,
  o: { modules: readonly WorkModule[]; kinds?: readonly ChipKind[]; waitMs?: number; by?: Caller }
): Promise<MentionAnswer> {
  const sources = o.modules
    .flatMap((m) => m.mentions ?? [])
    .filter((s) => (reach.work || s.lifeos) && (!o.kinds || o.kinds.includes(s.kind)))
  const lifeosUp = sources.some((s) => s.lifeos) ? safely(() => ctx.lifeos.connected()) : false
  const failed: ChipKind[] = []
  const answers = await Promise.all(
    sources.map(async (source): Promise<MentionHit[]> => {
      if (source.lifeos && !lifeosUp) {
        failed.push(source.kind)
        return []
      }
      try {
        const hits = await within(source.search(text.trim(), reach, ctx, o.by), o.waitMs ?? SOURCE_WAIT_MS)
        return hits.slice(0, MENTION_PER_KIND)
      } catch (err) {
        ctx.log(`mentions: ${source.kind} did not answer: ${err instanceof Error ? err.message : String(err)}`)
        failed.push(source.kind)
        return []
      }
    })
  )
  // A stable sort: within a kind, the source's own order (best or newest first) stands.
  const hits = answers.flat().sort((a, b) => rank(a.chip.kind) - rank(b.chip.kind))
  return { hits, failed: [...new Set(failed)] }
}

function safely(fn: () => boolean): boolean {
  try {
    return fn()
  } catch {
    return false
  }
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** What an item is, in a row's muted fact. */
const KIND_WORDS: Partial<Record<CanvasKind, string>> = {
  mail: 'Mail draft',
  document: 'Document',
  sheet: 'Sheet',
  pdf: 'PDF',
  slides: 'Deck',
  media: 'Recording',
  meeting: 'Meeting',
  form: 'Form',
  dashboard: 'Dashboard'
}

/**
 * The canvas's own kind: the items of the thread's pane, open and closed,
 * last touched first. Only the pane's: an item of another thread cannot be
 * opened by id from this one, by the window or by the model's canvas_open.
 * A history view and a browser window are not things to talk about, and a
 * LifeOS document is the `doc` kind's, so neither is offered twice. A draft
 * has no pane yet.
 */
export const canvasMentions: MentionSource[] = [
  {
    kind: 'item',
    async search(text, reach, ctx) {
      if (!reach.sessionId) return []
      const items = canvasStoreOf(ctx.db)
        .rowsFor([ctx.canvas.paneOf(reach.sessionId)])
        .sort((a, b) => b.updatedAt - a.updatedAt)
      return items
        .filter((item) => KIND_WORDS[item.kind] && !(item.source.at === 'lifeos' && item.source.table === 'docs'))
        .filter((item) => mentionMatches(text, item.title, KIND_WORDS[item.kind]))
        .slice(0, MENTION_PER_KIND)
        .map((item) => ({ chip: { kind: 'item', label: item.title, ref: { at: 'item', id: item.id } }, detail: KIND_WORDS[item.kind] }))
    }
  }
]
