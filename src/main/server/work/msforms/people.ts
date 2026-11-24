import type { Caller } from '../modules'
import { cachedAnswers } from './answers/cache'
import { readAnswers } from './answers/read'
import type { MsCtx } from './forms'
import { formsReached, librariesFor } from './reach'
import type { MsFormRow } from './store'
import { answersWithheld } from './withhold'

/**
 * Who answered which form (docs/agents/work-msforms.md "Around the rest of
 * Work", People): with Record name on each answer carries an address, and a
 * person's page lists the forms of its job they answered. Read from the
 * answers in memory; a form not read since this host started is read first,
 * three at a time. Matched by lower-cased address. Only the job's own forms,
 * in its own sector (`formsReached`), and none for a routine's thread in a
 * withheld sector.
 */

export interface Answered {
  formId: string
  title: string
  /** what a Files tab opens the form with */
  tenant: string
  /** the newest answer's Completion time, as this host's clock reads its wall time; null when the workbook has none */
  at: number | null
}

/** How many forms not yet in memory are read at once for a page. */
export const READ_AT_ONCE = 3

const norm = (email: string): string => email.trim().toLowerCase()

/** "2026-11-24 10:16" as written in the answers, read as wall time here. */
function timeOf(text: string | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(text ?? '')
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime()
}

export async function byPerson(ctx: MsCtx, by: Caller, ask: { workspaceId?: string | null; emails: readonly string[] }): Promise<{ email: string; forms: Answered[] }[]> {
  const emails = [...new Set(ask.emails.map(norm).filter(Boolean))]
  const { workspace, rows } = formsReached(ctx, by, ask.workspaceId)
  if (answersWithheld(ctx, by, workspace.sector)) return emails.map((email) => ({ email, forms: [] }))
  const answered = rows.filter((r) => r.count > 0)
  // what is not in memory is read first, a few at a time
  const missing = answered.filter((r) => !cachedAnswers(r.workspaceId, r.formId))
  const libraries = librariesFor(ctx, by)
  for (let i = 0; i < missing.length; i += READ_AT_ONCE)
    await Promise.all(
      missing.slice(i, i + READ_AT_ONCE).map(async (row) => {
        const library = libraries.find((l) => l.id === row.folder.libraryId)
        if (!library) return
        await readAnswers(ctx, { workspace, row, library }, { by: by.kind === 'model' ? 'poller' : 'owner', rows: true }).catch(() => {})
      })
    )
  const found = new Map<string, Answered[]>(emails.map((e) => [e, []]))
  for (const row of answered) for (const [email, at] of answersBy(row)) found.get(email)?.push({ formId: row.formId, title: row.title, tenant: row.tenant, at })
  return emails.map((email) => ({ email, forms: found.get(email)!.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)) }))
}

/** Each address that answered a form, with its newest answer's time, from the answers in memory. */
function answersBy(row: MsFormRow): Map<string, number | null> {
  const out = new Map<string, number | null>()
  const kept = cachedAnswers(row.workspaceId, row.formId)
  if (!kept) return out
  const cols = kept.answers.columns
  const email = cols.findIndex((c) => c.id === 'email')
  const end = cols.findIndex((c) => c.id === 'end')
  if (email < 0) return out
  // rows are newest first: the first seen is the newest
  for (const r of kept.answers.rows) {
    const who = norm(r[email] ?? '')
    if (who && !out.has(who)) out.set(who, end < 0 ? null : timeOf(r[end]))
  }
  return out
}
