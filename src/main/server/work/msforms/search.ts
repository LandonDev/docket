import { MENTION_PER_KIND } from '@shared/work/mentions'
import type { SearchHit } from '@shared/work/search'
import type { Caller, MentionSource, WorkCtx } from '../modules'
import type { SearchSource } from '../search/source'
import { cachedAnswers } from './answers/cache'
import { MsformsStore, type MsFormRow } from './store'
import { answersWithheld } from './withhold'
import { formAdmitted, librariesFor } from './reach'

/**
 * Microsoft forms in Work search (docs/agents/work-msforms.md "Search and
 * `@`"): forms by title, from the table, at once; answers by a word or a name,
 * from what was read into memory alone (a form not read since restart is
 * said in one quiet line, never read here). A thread is narrowed to its own
 * job before anything is read, and a Work Chat finds forms by title only,
 * never an answer. Each hit's workspace and opener come from the row itself.
 */

const FIXED = new Set(['id', 'start time', 'completion time', 'email', 'name'])
const SNIPPET = 160

const openOf = (ctx: Pick<WorkCtx, 'host'>, row: MsFormRow) =>
  ({ to: 'file', ref: { at: 'msform', host: ctx.host, workspaceId: row.workspaceId, formId: row.formId, tenant: row.tenant }, name: row.title }) as const

export const msformSearch: SearchSource = {
  kind: 'msform',
  label: 'Microsoft forms',
  // Titles from the table and answers from memory: no network, never the box browser.
  tier: 'instant',
  async search(ask, ctx) {
    const words = ask.text.toLowerCase().split(/\s+/).filter(Boolean)
    const holds = (s: string): boolean => {
      const l = s.toLowerCase()
      return words.every((w) => l.includes(w))
    }
    // A thread reaches its own job alone; a Work Chat (no job) reaches forms by title, never their answers.
    const scope = ask.by.kind === 'model' && ask.by.sessionId ? ctx.scopeOf(ask.by.sessionId) : null
    const model = ask.by.kind === 'model'
    const jobs = model ? ask.reach.workspaces.filter((w) => !scope?.workspaceId || w.id === scope.workspaceId) : ask.reach.workspaces
    const answers = !model || !!scope?.workspaceId
    const store = new MsformsStore(ctx.db)
    // A form `formReach` would refuse now (its library left reach) gives no title and no cached answer.
    const reached = new Set(librariesFor(ctx, ask.by).map((l) => l.id))
    const hits: SearchHit[] = []
    let unread = 0
    for (const job of jobs) {
      for (const row of store.list(job.id)) {
        // A form made in another sector than the job's now is not the job's, nor one in a library no longer reached.
        if ((row.sector ?? null) !== (job.sector ?? null) || !reached.has(row.folder.libraryId)) continue
        if (holds(row.title)) hits.push({ key: `msform:${row.workspaceId}:${row.formId}`, kind: 'msform', title: row.title, detail: row.state === 'draft' ? 'Microsoft form, draft' : `Microsoft form, ${row.count} response${row.count === 1 ? '' : 's'}`, at: row.updatedAt, workspaceId: row.workspaceId, open: openOf(ctx, row) })
        if (!answers || row.state === 'draft' || answersWithheld(ctx, ask.by, row.sector)) continue
        const kept = cachedAnswers(row.workspaceId, row.formId)
        if (!kept) {
          // Answers there are, or never looked for: either way not searched here.
          if (row.count || row.answersReadAt === null) unread++
          continue
        }
        const { columns, rows } = kept.answers
        const who = columns.findIndex((c) => c.label.trim().toLowerCase() === 'name')
        for (const r of rows) {
          const at = r.findIndex((cell, i) => !FIXED.has(columns[i]?.label.trim().toLowerCase() ?? '') && holds(cell))
          const byName = who >= 0 && holds(r[who] ?? '')
          if (at < 0 && !byName) continue
          const shown = at >= 0 ? `${columns[at]!.label}: ${r[at]}` : `${r[who]} answered`
          hits.push({ key: `msform:${row.workspaceId}:${row.formId}:${r[0]}`, kind: 'msform', title: row.title, snippet: shown.slice(0, SNIPPET), ...(who >= 0 && r[who] ? { detail: r[who] } : {}), workspaceId: row.workspaceId, open: openOf(ctx, row) })
          if (hits.length > ask.limit) break
        }
      }
    }
    if (unread) ask.note?.({ cause: 'msforms-unread', line: `Answers to ${unread} form${unread === 1 ? ' are' : 's are'} not read yet.` })
    return hits.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, ask.limit + 1)
  }
}

/**
 * `@` in a Work thread's composer: the job's Microsoft forms by title (never their answers), each a chip whose
 * reference is the form's own source, as a file chip's is. A Work Chat and a code thread are offered none.
 */
export const msformMentions: MentionSource = {
  kind: 'msform',
  async search(text, reach, ctx) {
    if (!reach.work || !reach.workspaceId) return []
    const job = ctx.db.prepare('SELECT sector FROM workspaces WHERE id = ?').get(reach.workspaceId) as { sector: string | null } | undefined
    const words = text.toLowerCase().split(/\s+/).filter(Boolean)
    // as the thread would reach it (a draft with no thread yet: as its job's threads do, no VM)
    const by = { kind: 'model', caps: [], sessionId: reach.sessionId ?? undefined } as Caller
    return new MsformsStore(ctx.db)
      .list(reach.workspaceId)
      .filter((r) => formAdmitted(ctx, r, job?.sector ?? null, by) && words.every((w) => r.title.toLowerCase().includes(w)))
      .slice(0, MENTION_PER_KIND)
      .map((r) => ({ chip: { kind: 'msform', label: r.title, ref: { at: 'msform', host: ctx.host, workspaceId: r.workspaceId, formId: r.formId, tenant: r.tenant } }, detail: 'Microsoft form', at: r.updatedAt }))
  }
}
