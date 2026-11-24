import type { WorkCtx } from '../modules'
import { serviceOf } from '../service/ctx'
import type { DocRevision } from '../service/wire'
import { autosaveLinks, noteLinkRevision, saveLinkRevision } from './saveAs'
import { autosaveWords, noteWordRevision, saveWordRevision, wordTiming } from './word'

const SWEEP_MS = 30_000
type Subscribe = (listener: (notice: DocRevision) => void) => () => void

interface Pending {
  rev: string
  at: number
  timer?: ReturnType<typeof setTimeout>
  saving: boolean
}

/** Each edit restarts the quiet period. If a save is in flight, the newest
 * edit waits behind it and keeps its own quiet period. */
export function startFileAutosaves(
  ctx: WorkCtx,
  subscribe: Subscribe = (listener) => serviceOf(ctx)?.onDocRevision(listener) ?? (() => {})
): () => void {
  const pending = new Map<string, Pending>()
  let stopped = false
  let sweeping = false
  const active = (): boolean => !stopped && ctx.enabled()
  const log = (err: unknown): void => ctx.log(`files: autosave failed: ${err instanceof Error ? err.message : String(err)}`)

  const arm = (doc: string, job: Pending): void => {
    clearTimeout(job.timer)
    job.timer = setTimeout(() => {
      if (!active()) return void pending.delete(doc)
      const rev = job.rev
      job.saving = true
      const now = Date.now()
      void Promise.allSettled([saveWordRevision(ctx, doc, now, active), saveLinkRevision(ctx, doc, now, active)]).then((results) => {
        for (const result of results) if (result.status === 'rejected') log(result.reason)
        job.saving = false
        if (active() && rev !== job.rev) arm(doc, job)
        else pending.delete(doc)
      })
    }, Math.max(0, job.at + wordTiming.pause - Date.now()))
    job.timer.unref?.()
  }

  const observe = (notice: DocRevision): void => {
    if (!active()) return
    try {
      const now = Date.now()
      const word = noteWordRevision(ctx, notice, now)
      const link = noteLinkRevision(ctx, notice, now)
      if (!word && !link) return
      const job = pending.get(notice.doc)
      if (job?.rev === notice.rev) return
      const next = job ?? { rev: notice.rev, at: now, saving: false }
      next.rev = notice.rev
      next.at = now
      pending.set(notice.doc, next)
      if (!next.saving) arm(notice.doc, next)
    } catch (err) {
      log(err)
    }
  }

  const off = subscribe(observe)
  const sweep = setInterval(() => {
    if (sweeping || !active()) return
    sweeping = true
    const now = Date.now()
    void Promise.allSettled([autosaveWords(ctx, now, observe), autosaveLinks(ctx, now, observe)]).then((results) => {
      for (const result of results) if (result.status === 'rejected') log(result.reason)
      sweeping = false
    })
  }, SWEEP_MS)
  sweep.unref?.()

  return () => {
    stopped = true
    off()
    clearInterval(sweep)
    for (const { timer } of pending.values()) clearTimeout(timer)
    pending.clear()
  }
}
