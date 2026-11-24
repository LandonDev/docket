import type { SectorKey } from './ids'

/**
 * The Microsoft Forms pillar's pure rules (docs/agents/work-msforms.md): the
 * hosts Forms answers on, the two addresses made from a form's id, a form's
 * link in a message, the questions as Work keeps them and the change between
 * two lists of them. No zod and no node import: the renderer, the host and
 * the hold all read these.
 */

/**
 * Sectors whose answers a thread a routine started never reads (the plan's
 * "For the owner", 1: Purdue's policy VII.A.5 keeps student answers out of an
 * AI tool unless the use was approved). His own asks are not withheld.
 * Empty this list to lift it.
 */
export const MSFORM_UNATTENDED_WITHHELD: readonly SectorKey[] = ['purdue']

/** The withhold's sentence, said to the thread and to the routine's save. */
export const MSFORM_WITHHELD_WORDS = 'refused: a routine\'s thread does not read Purdue answers: they go to no AI tool without the owner\'s press. Nothing was read.'

/** The hosts Microsoft Forms is served from, subdomains included. Only the carrier drives them. */
export const FORMS_HOSTS = ['forms.office.com', 'forms.cloud.microsoft', 'forms.microsoft.com'] as const

/** Whether a host name is Forms' own (or one of its subdomains). */
export function isFormsHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return FORMS_HOSTS.some((f) => h === f || h.endsWith(`.${f}`))
}

/** Whether an address is on a Forms host. A string that is not an https or http address is not. */
export function isFormsUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' || u.protocol === 'http:') && isFormsHost(u.hostname)
  } catch {
    return false
  }
}

/** A form's id as Forms writes it in `id=`: base64url letters, sometimes with dots, never anything else. */
export const FORM_ID = /^[A-Za-z0-9_.-]{20,200}$/
/** A tenant's short name, as in `<tenant>.sharepoint.com` and the live partition. */
export const FORM_TENANT = /^[a-z0-9-]{1,63}$/

export const isFormId = (id: string): boolean => FORM_ID.test(id)
export const isFormTenant = (tenant: string): boolean => FORM_TENANT.test(tenant)

const FORMS_ORIGIN = 'https://forms.cloud.microsoft'

/** The builder's address for a form: the only Forms page a ticket opens to edit. */
export function builderOf(formId: string): string {
  if (!isFormId(formId)) throw new Error('That is not a Microsoft form.')
  return `${FORMS_ORIGIN}/Pages/DesignPageV2.aspx?subpage=design&id=${formId}`
}

/** The response page's address: the link people answer at. */
export function respondOf(formId: string): string {
  if (!isFormId(formId)) throw new Error('That is not a Microsoft form.')
  return `${FORMS_ORIGIN}/Pages/ResponsePage.aspx?id=${formId}`
}

/** A form's id from a builder or response address on a Forms host, else null. */
export function formIdOf(url: string): string | null {
  if (!isFormsUrl(url)) return null
  const id = new URL(url).searchParams.get('id')
  return id && isFormId(id) ? id : null
}

const LINK_HOSTS = FORMS_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')
/** A response page (`ResponsePage.aspx?…id=`) on any Forms host, or a `forms.office.com/r/<code>` short link. */
const FORM_LINK = new RegExp(`(?:https?://)?(?:[a-z0-9-]+\\.)*(?:${LINK_HOSTS})/(?:Pages/ResponsePage\\.aspx\\?[^\\s"'<>]*\\bid=|r/[A-Za-z0-9]{4,})`, 'i')
const SHORT_LINK = /(?:https?:\/\/)?(?:forms\.office\.com|forms\.cloud\.microsoft)\/r\/[A-Za-z0-9]{4,}/i

/**
 * Whether a text holds a Microsoft form's link people answer at. A held act
 * whose words carry one takes no grant and earns no offer
 * (outbox/outbox.ts `notGrantable`): the link reaches people only on his press.
 */
export function hasFormLink(text: string): boolean {
  if (!text) return false
  const plain = text.replace(/&amp;/g, '&')
  return FORM_LINK.test(plain) || SHORT_LINK.test(plain)
}

/** Every string in a payload, depth first, at most `limit` of them: what `hasFormLink` looks through. */
export function payloadText(payload: unknown, limit = 400): string {
  const out: string[] = []
  const walk = (v: unknown, depth: number): void => {
    if (out.length >= limit || depth > 8) return
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1)
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1)
  }
  walk(payload, 0)
  return out.join('\n')
}

// ── questions ────────────────────────────────────────────────────────

export const MS_QUESTION_TYPES = ['text', 'choice', 'rating', 'date', 'section'] as const
export type MsQuestionType = (typeof MS_QUESTION_TYPES)[number]

/** A question as Work keeps it. `ref` is Forms' own `QuestionId_r<hex>` once a read has seen it. */
export interface MsQuestion {
  ref?: string
  title: string
  type: MsQuestionType
  long?: boolean
  multiple?: boolean
  dropdown?: boolean
  options?: string[]
  required: boolean
  scale?: 5 | 10
}

/** A question Forms offers that no tool changes (Ranking, Likert, Upload File, Net Promoter Score): shown, never changed. */
export interface MsOtherQuestion {
  ref?: string
  title: string
  type: 'other'
  kind: string
}

export type MsAnyQuestion = MsQuestion | MsOtherQuestion

export const isOther = (q: MsAnyQuestion): q is MsOtherQuestion => q.type === 'other'

/** Our forms' types (contract-work-forms.ts) as a Microsoft form's. */
export function fromOurType(type: 'short' | 'long' | 'choice' | 'dropdown' | 'section'): Pick<MsQuestion, 'type' | 'long' | 'dropdown'> {
  switch (type) {
    case 'short':
      return { type: 'text' }
    case 'long':
      return { type: 'text', long: true }
    case 'choice':
      return { type: 'choice' }
    case 'dropdown':
      return { type: 'choice', dropdown: true }
    case 'section':
      return { type: 'section' }
  }
}

/** One of our form's questions as a Microsoft form's. */
export function fromOurQuestion(q: { label: string; type: 'short' | 'long' | 'choice' | 'dropdown' | 'section'; required?: boolean; options?: string[] }): MsQuestion {
  const typed = fromOurType(q.type)
  const out: MsQuestion = { title: q.label, ...typed, required: q.type === 'section' ? false : Boolean(q.required) }
  if (typed.type === 'choice') out.options = [...(q.options ?? [])]
  return out
}

/** A question in his words, as the stepper, the Outbox card and `msform_read` say it. */
export function questionWords(q: MsAnyQuestion): string {
  if (isOther(q)) return `${q.kind} question "${q.title}"`
  const kind =
    q.type === 'text'
      ? q.long
        ? 'Text (long answer)'
        : 'Text'
      : q.type === 'choice'
        ? q.dropdown
          ? 'Choice (drop-down)'
          : q.multiple
            ? 'Choice (several answers)'
            : 'Choice'
        : q.type === 'rating'
          ? `Rating (1 to ${q.scale ?? 5})`
          : q.type === 'date'
            ? 'Date'
            : 'Section'
  const options = q.type === 'choice' && q.options?.length ? ` with ${q.options.join(', ')}` : ''
  const required = q.type !== 'section' && q.required ? ', required' : ''
  return `${kind} "${q.title}"${options}${required}`
}

/** A change to the question list, as an agent asks for it and the carrier's `write` runs it. */
export type MsChange =
  | { op: 'add'; question: MsQuestion; after?: number | null }
  | { op: 'change'; at: number; question: MsQuestion }
  | { op: 'remove'; at: number }
  | { op: 'move'; at: number; to: number }

/** A change in his words, for the stepper's sheet and the held card. `list` is the form as it stands. */
export function changeWords(change: MsChange, list: readonly MsAnyQuestion[]): string {
  const titleAt = (i: number): string => list[i]?.title ?? `question ${i + 1}`
  switch (change.op) {
    case 'add':
      return `Add a ${questionWords(change.question)}`
    case 'remove':
      return `Remove "${titleAt(change.at)}"`
    case 'move':
      return `Move "${titleAt(change.at)}" to place ${change.to + 1}`
    case 'change': {
      const old = list[change.at]
      if (old && !isOther(old) && old.title !== change.question.title && sameShape(old, change.question)) return `Rename "${old.title}" to "${change.question.title}"`
      return `Change "${titleAt(change.at)}" to ${questionWords(change.question)}`
    }
  }
}

/** Two questions alike in all but their title. */
function sameShape(a: MsQuestion, b: MsQuestion): boolean {
  return (
    a.type === b.type &&
    Boolean(a.long) === Boolean(b.long) &&
    Boolean(a.multiple) === Boolean(b.multiple) &&
    Boolean(a.dropdown) === Boolean(b.dropdown) &&
    a.required === b.required &&
    (a.scale ?? 5) === (b.scale ?? 5) &&
    JSON.stringify(a.options ?? []) === JSON.stringify(b.options ?? [])
  )
}

/** Two questions the same in every part Work keeps, ref aside. */
export function sameQuestion(a: MsAnyQuestion, b: MsAnyQuestion): boolean {
  if (isOther(a) || isOther(b)) return isOther(a) && isOther(b) && a.title === b.title && a.kind === b.kind
  return a.title === b.title && sameShape(a, b)
}

/** Apply one change to a list; throws in his words when it names no question. */
export function applyChange(list: readonly MsAnyQuestion[], change: MsChange): MsAnyQuestion[] {
  const next = [...list]
  const at = (i: number): void => {
    if (!Number.isInteger(i) || i < 0 || i >= next.length) throw new Error(`The form has no question ${i + 1}.`)
  }
  switch (change.op) {
    case 'add': {
      const after = change.after ?? next.length - 1
      if (after < -1 || after >= next.length) throw new Error(`The form has no question ${after + 1} to add after.`)
      next.splice(after + 1, 0, change.question)
      return next
    }
    case 'change':
      at(change.at)
      if (isOther(next[change.at])) throw new Error(`"${next[change.at].title}" is a kind of question only the Forms page changes.`)
      next[change.at] = { ...change.question, ref: next[change.at].ref }
      return next
    case 'remove':
      at(change.at)
      next.splice(change.at, 1)
      return next
    case 'move': {
      at(change.at)
      if (!Number.isInteger(change.to) || change.to < 0 || change.to >= next.length) throw new Error(`The form has no place ${change.to + 1}.`)
      const [q] = next.splice(change.at, 1)
      next.splice(change.to, 0, q)
      return next
    }
  }
}

/**
 * What changed from `before` to `after`, in his words: questions matched by
 * `ref` where both have one, else by place and title. Question history and
 * the carrier's drift check read this.
 */
export function diffQuestions(before: readonly MsAnyQuestion[], after: readonly MsAnyQuestion[]): string[] {
  const out: string[] = []
  const used = new Set<number>()
  const matchOf = (q: MsAnyQuestion, i: number): number => {
    if (q.ref) {
      const j = after.findIndex((b, k) => !used.has(k) && b.ref === q.ref)
      if (j >= 0) return j
    }
    const byTitle = after.findIndex((b, k) => !used.has(k) && !b.ref && b.title === q.title)
    if (byTitle >= 0) return byTitle
    const same = after.findIndex((b, k) => !used.has(k) && b.title === q.title)
    if (same >= 0) return same
    return !q.ref && i < after.length && !used.has(i) && !after[i].ref && after.length === before.length ? i : -1
  }
  const pairs: [number, number][] = []
  before.forEach((q, i) => {
    const j = matchOf(q, i)
    if (j < 0) out.push(`Removed "${q.title}"`)
    else {
      used.add(j)
      pairs.push([i, j])
    }
  })
  for (const [i, j] of pairs) {
    const a = before[i]
    const b = after[j]
    if (sameQuestion(a, b)) continue
    if (!isOther(a) && !isOther(b) && a.title !== b.title && sameShape(a, b)) out.push(`Renamed "${a.title}" to "${b.title}"`)
    else out.push(`Changed "${a.title}" to ${questionWords(b)}`)
  }
  after.forEach((q, j) => {
    if (!used.has(j)) out.push(`Added a ${questionWords(q)}`)
  })
  const order = pairs.map(([, j]) => j)
  if (order.some((j, k) => k > 0 && j < order[k - 1])) out.push('Moved questions')
  return out
}

// ── settings and answers ─────────────────────────────────────────────

/** Who may answer and when, as the last page read saw it. */
export interface MsFormSettings {
  accepting: boolean
  orgOnly: boolean
  recordName: boolean
  onePerPerson: boolean
  startDate?: string
  endDate?: string
}

/** The settings a new form is made with: his tenant's sign-in rule, names kept, one answer each. */
export const MSFORM_NEW_SETTINGS: MsFormSettings = { accepting: false, orgOnly: true, recordName: true, onePerPerson: true }

/** Whether `next` lets more people answer than `now`: who-can-answer widened. */
export function widens(now: Pick<MsFormSettings, 'orgOnly'>, next: Partial<Pick<MsFormSettings, 'orgOnly'>>): boolean {
  return now.orgOnly && next.orgOnly === false
}

/** Settings in his words, for the held card and `msform_read`. */
export function settingsWords(s: MsFormSettings): string {
  const parts = [s.orgOnly ? 'Only people in the organization can answer, signed in' : 'Anyone with the link can answer']
  if (s.orgOnly) parts.push(s.recordName ? 'their names are recorded' : 'their names are not recorded')
  parts.push(s.onePerPerson ? 'one answer each' : 'more than one answer each allowed')
  if (s.startDate) parts.push(`opens ${s.startDate}`)
  if (s.endDate) parts.push(`closes ${s.endDate}`)
  return parts.join('; ')
}

/** The fixed columns of Forms' answers table, before one column per question. */
export const ANSWER_FIXED_COLUMNS = ['Id', 'Start time', 'Completion time', 'Email', 'Name'] as const
/** The table Forms keeps answers in. */
export const ANSWERS_TABLE = 'OfficeForms.Table'
/** Past this many answers the newest are kept and the summary line says so. */
export const ANSWERS_MOST = 5000

/** How often a collecting form is checked for answers. */
export const MSFORM_CHECKS = ['hour', 'quarter', 'look'] as const
export type MsFormCheck = (typeof MSFORM_CHECKS)[number]
export const CHECK_MS: Record<MsFormCheck, number | null> = { hour: 60 * 60_000, quarter: 15 * 60_000, look: null }
export const CHECK_WORDS: Record<MsFormCheck, string> = { hour: 'Every hour', quarter: 'Every 15 minutes', look: 'Only when I look' }

/** A read of answers this new is used as it is; older, a read runs first. */
export const ANSWERS_FRESH_MS = 2 * 60_000

/** The workbook's name in the form's folder: the form's title then, as Forms names it. */
export function workbookNameOf(title: string): string {
  return `${title.replace(/[\\/:*?"<>|#%]/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled form'}.xlsx`
}
