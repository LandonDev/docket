import { z } from 'zod'
import type { DocFormatResult } from 'work-kit/collab-server'
import { docFormatFields } from './formatToolInput'
import { agentPrincipal, canvasSourcePath, workText, type CanvasSource, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { ToolCtx, WorkTool } from '../modules'
import { docsOf, modeOf, wrote } from './state'
import { attachmentDoc, ATTACHMENT_READ_ONLY, lifeosRow, othersOpen, pathOf, serviceTarget, targetOf, titleOf, type DocTarget } from './target'
import { fetchedItemOfPath } from '../canvas/fetch'
import { changeThread } from './threads'
import { revisionOf } from './revision'
import { EDITED_WITHIN, FIND_BY, FIND_KINDS, FIND_KIND_WORDS, FIND_SORTS, FIND_WHERE, FIND_WHERE_WORDS, findIn, type FindEntry, type FindFilter } from '@shared/work/docFind'

/**
 * The tools a Work thread reads and changes a document with
 * (docs/agents/work-docs.md "The tools"). The rule (architecture §6.7, §8.4):
 * a change the owner asked for, or one a routine was granted, is written at
 * once as one version; an agent's own idea on a document others share waits
 * as suggestions he steps through; on his own document it follows its mode
 * (written with Undo, unless he set "Agent suggests"). "Asked" is a verdict
 * this host makes: the quote must be in one of the owner's own messages in
 * the thread, else the write counts as the agent's own idea. The Work service
 * is told the verdict, never the model's word.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })

const target = {
  item: z.string().optional().describe("The id of a document item in this thread's canvas (from `canvas_open`)."),
  doc: z.string().optional().describe('A LifeOS document id, when it is not open in the canvas.'),
  file: z.string().optional().describe('An absolute path to a .tcdoc on this host, when it is not open in the canvas.')
}

type TargetArgs = { item?: string; doc?: string; file?: string }

/**
 * A Work thread with no Work home (work-scope.md, "A thread with no Work home"): its row names a
 * workspace or project that is not a Work workspace's. Its scope has no workspace, as a Work Chat's
 * has none, but it keeps its fence and reaches no sector.
 */
function orphaned(ctx: ToolCtx): boolean {
  if (ctx.scope.workspaceId) return false
  try {
    const row = ctx.db.prepare('SELECT workspace_id AS w, project_id AS p FROM sessions WHERE id = ?').get(ctx.sessionId) as { w?: string | null; p?: string | null } | undefined
    return !!(row?.w || row?.p)
  } catch {
    return false
  }
}

/** The sectors a thread may reach: its workspace's one; none for a workspace with no sector or a thread with no Work home; every sector for a Work Chat (which reads through its own key). */
const sectorsOf = (ctx: ToolCtx): string[] | 'all' => (ctx.scope.sector ? [ctx.scope.sector] : ctx.scope.workspaceId || orphaned(ctx) ? [] : 'all')

async function resolve(ctx: ToolCtx, a: TargetArgs, write = false): Promise<{ t: DocTarget; shared: boolean; fence: string[] | 'all'; title: string; asked: CanvasSource }> {
  let source: CanvasSource
  if (a.item) {
    const item = ctx.canvas.get(a.item)
    if (!item || item.kind !== 'document' || item.sessionId !== ctx.canvas.paneOf(ctx.sessionId)) throw new Error(`This thread has no document ${a.item} in its canvas.`)
    source = item.source
    // A mail's document is read from the copy its pane made of it (attachmentDoc), and never written.
    if (source.at === 'mail') {
      if (write) throw new Error(ATTACHMENT_READ_ONLY)
      const path = attachmentDoc(ctx, item)
      if (!path) throw new Error(`${item.title} has not been opened yet: it is read once the person opens it.`)
      source = { at: 'file', host: ctx.host, path }
    }
    // Google is the truth for a Google Doc: an agent's change goes there as a suggestion.
    if (source.at === 'google') throw new Error(`${item.title} lives in Google: read it with google_doc_read and change it with google_doc_suggest.`)
  } else if (a.doc) source = { at: 'lifeos', table: 'docs', id: a.doc }
  else if (a.file) source = { at: 'file', host: ctx.host, path: a.file }
  else throw new Error('Pass `item` (a document open in the canvas), `doc` (a LifeOS document id) or `file` (a .tcdoc path).')
  const t = await targetOf(ctx, { kind: 'model', caps: [], sessionId: ctx.sessionId }, 'doc', source)
  if (write && t.at === 'file' && fetchedItemOfPath(ctx, t.path)) throw new Error(ATTACHMENT_READ_ONLY)
  const row = await lifeosRow(ctx, t)
  const fence = sectorsOf(ctx)
  // A document of another sector is not this thread's to see, whatever id it was handed.
  if (row && fence !== 'all' && !fence.includes(row.sector)) throw new Error('LifeOS has no such document')
  // A .tcdoc in a synced library or cloud folder is shared as surely as a guest-linked LifeOS document: an agent's own idea there only suggests.
  return { t, shared: othersOpen(ctx, t, row) || ctx.scope.shared(t.source), fence, title: titleOf(t, row), asked: source }
}

function ownerSaid(ctx: ToolCtx, quote: string | undefined, about?: readonly string[]): boolean {
  if (!quote?.trim()) return false
  try {
    return ctx.threads.ownerSaid(ctx.sessionId, quote, about)
  } catch {
    return false
  }
}

/**
 * What a message of his must point at, exactly, for his words to stand for a change to this document
 * (work/threads.ts `ownerSaid`): what identifies it alone, its path (as the host and as the canvas write it) or its
 * LifeOS id, and the canvas item it was named by. A title does not: two documents may share it, and one may stand
 * inside another's.
 */
const namesOf = (t: DocTarget, asked: CanvasSource, item?: string): string[] => {
  const ids = t.at === 'lifeos' ? [t.docId] : [t.path, canvasSourcePath(asked) ?? t.path]
  return [...new Set([...ids, ...(item ? [`item:${item}`] : [])])]
}

type ServiceWrite = { mode: 'direct'; versionId?: string; beforeVersionId?: string } | { mode: 'branch'; branchId: string; versionId: string }

/** The sections a rewrite touched, for the "Wrote 2 sections" line: by heading when the text has them, else by paragraph. */
export function changedParts(before: string, after: string): { count: number; unit: 'section' | 'paragraph' } {
  const headed = /^#{1,6}\s/m.test(after)
  const parts = (md: string): string[] =>
    headed
      ? md.split(/\n(?=#{1,6}\s)/).map((s) => s.trim()).filter(Boolean)
      : md.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
  const had = new Set(parts(before))
  const now = parts(after)
  const gone = [...had].filter((p) => !now.includes(p)).length
  return { count: Math.max(now.filter((p) => !had.has(p)).length, gone), unit: headed ? 'section' : 'paragraph' }
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

type WhyWrite = { because: 'asked' | 'routine' | 'own'; quote?: string; suggest?: boolean; revision?: string }

export { revisionOf }

const READ_FIRST = 'Read the document with doc_read first and pass its `revision`: a rewrite replaces the whole text, so it must be written over the text you read.'
const CHANGED = 'The document changed since you read it (the owner or someone else edited it), so your rewrite would undo their words. Read it again with doc_read and write your change over the text as it is now.'


function writeRule(ctx: ToolCtx, a: WhyWrite & { item?: string }, t: DocTarget, shared: boolean, title: string, source: CanvasSource) {
  const item = a.item
  const said = a.because === 'asked' && ownerSaid(ctx, a.quote)
  // On a document others read, his words write at once only in a message that names this document: a request about
  // another document, quoted here, is not his ask for this one.
  const asked = said && (!shared || ownerSaid(ctx, a.quote, namesOf(t, source, item)))
  // A routine's run writes directly only where nobody else reads: on a shared document no grant covers it, so it suggests (milestone 50's hold review, finding 6).
  const routine = a.because === 'routine' && !!ctx.scope.routineRunId && !shared
  const verdict = asked ? 'asked' : routine ? 'routine' : 'own'
  const suggest = a.suggest === true || (verdict === 'own' && (shared || modeOf(ctx, t.doc) === 'suggests'))
  const note =
    a.because === 'asked' && !asked
      ? said
        ? ` Others share this document and the owner's message with that quote does not point at it ("${title}": an Ask from the document, or its path), so this counts as your own idea.`
        : " The quote was not found among the owner's words in this thread, so this counts as your own idea."
      : a.because === 'routine' && !routine
        ? ctx.scope.routineRunId
          ? ' A routine writes to what others share only under a grant he made for it, and none does, so this counts as your own idea.'
          : ' This thread runs no routine, so this counts as your own idea.'
        : ''
  return { verdict, suggest, note } as const
}

async function write(ctx: ToolCtx, a: TargetArgs & WhyWrite & { markdown: string }): Promise<WorkToolResult> {
  const { t, shared, fence, title, asked } = await resolve(ctx, a, true)
  const { verdict, suggest, note } = writeRule(ctx, a, t, shared, title, asked)
  const before = ((await ctx.service.internal('/internal/docs/read', serviceTarget(t, shared, fence))) as { markdown: string }).markdown
  // A whole-text rewrite drafted from an older read would take back what was typed since: refused, never merged by guess.
  if (!a.suggest && !a.revision) return fail(READ_FIRST)
  if (a.revision && a.revision !== revisionOf(before)) return fail(CHANGED)
  const principal = agentPrincipal(ctx.host, ctx.sessionId)
  // Checked again where the service writes, in the same tick as the edit: a word typed after this read is never written over.
  const done = (await ctx.service.internal('/internal/docs/write', { ...serviceTarget(t, shared, fence), markdown: a.markdown, because: verdict, suggest, principal, ...(a.revision ? { revision: a.revision } : {}) })) as ServiceWrite | { stale: true }
  if ('stale' in done) return fail(CHANGED)
  const parts = changedParts(before, a.markdown)
  if (done.mode === 'branch') {
    docsOf(ctx).push({ push: 'work.docs', doc: t.doc, branches: true }, pathOf(t))
    const why = a.suggest ? 'he steps through them in the document' : shared ? 'others share this document, so he accepts or rejects each one' : 'he set this document to suggest, so he accepts or rejects each one'
    return workText(`Suggested changes to ${plural(parts.count, parts.unit)}: ${why}.${note}`)
  }
  const text = `Wrote ${plural(parts.count, parts.unit)}`
  // His own document, on the agent's own idea: the bar says what was written, with Undo.
  if (verdict === 'own' && done.versionId && done.beforeVersionId) wrote(ctx, t.doc, { text, at: Date.now(), versionId: done.beforeVersionId, after: done.versionId }, pathOf(t))
  return workText(`${text}.${note}`)
}

const formatInput = z.strictObject({ ...target, ...docFormatFields })
  .refine((a) => !!a.on === !!(a.run || a.paragraph), 'Use on with run or paragraph.')
  .refine((a) => !!(a.on || a.style || a.theme || a.setup || a.header || a.footer), 'Pass a format change.')

type FormatArgs = z.infer<typeof formatInput>

async function format(ctx: ToolCtx, a: FormatArgs): Promise<WorkToolResult> {
  const { t, shared, fence, title, asked } = await resolve(ctx, a, true)
  const { verdict, suggest, note } = writeRule(ctx, a, t, shared, title, asked)
  const { on, run, paragraph, style, theme, setup, header, footer } = a
  const change = {
    ...(on ? { text: { target: on, ...(run ? { run } : {}), ...(paragraph ? { paragraph } : {}) } } : {}),
    ...(style ? { style } : {}), ...(theme ? { theme } : {}), ...(setup ? { setup } : {}),
    ...(header ? { header } : {}), ...(footer ? { footer } : {})
  }
  const done = await ctx.service.internal('/internal/docs/format', {
    ...serviceTarget(t, shared, fence), change, because: verdict, suggest, principal: agentPrincipal(ctx.host, ctx.sessionId)
  }) as DocFormatResult
  if (done.missing) return workText(`Nothing in the document matches that.${note}`)
  if (!done.changed) return workText(`The document already has that formatting.${note}`)
  const page = style || theme || setup || header || footer
  const amount = plural(done.changed, on && !page ? 'paragraph' : 'formatting change')
  if (done.mode === 'branch') {
    docsOf(ctx).push({ push: 'work.docs', doc: t.doc, branches: true }, pathOf(t))
    return workText(`Suggested formatting on ${amount}: he accepts or rejects it in the document.${note}`)
  }
  const text = `${on && !page ? 'Formatted' : 'Applied'} ${amount}`
  if (verdict === 'own' && done.versionId && done.beforeVersionId) wrote(ctx, t.doc, { text, at: Date.now(), versionId: done.beforeVersionId, after: done.versionId }, pathOf(t))
  return workText(`${text}${done.words.length ? ': ' + done.words.join(', ') : ''}.${note}`)
}

/** A date the model wrote, as ms; a bare date is the start of that day here. */
function dateOf(text: string | undefined, name: string): number | undefined {
  if (!text) return undefined
  const t = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00` : text).getTime()
  if (Number.isNaN(t)) throw new Error(`\`${name}\` is not a date: write it as 2026-10-01 or 2026-10-01T14:00`)
  return t
}

const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

const LAST_BY = { owner: 'the owner', agent: 'an agent', guest: 'a guest' } as const

/** One found entry as a line the model reads, ending with the source `canvas_open` takes. */
export function foundLine(e: FindEntry, projects: ReadonlyMap<string, string>): string {
  const facts = [FIND_KIND_WORDS[e.kind], FIND_WHERE_WORDS[e.where]]
  const project = e.projectId && projects.get(e.projectId)
  if (project) facts.push(`project ${project}`)
  facts.push(`edited ${day(e.editedAt)}${e.lastBy ? ` by ${LAST_BY[e.lastBy]}` : ''}`)
  if (e.shared || e.guest) facts.push(e.guest ? 'guest link' : 'shared')
  if (e.comments) facts.push(`${e.comments} open comment${e.comments === 1 ? '' : 's'}`)
  if (e.waiting) facts.push(`${e.waiting} suggestion${e.waiting === 1 ? '' : 's'} waiting`)
  if (e.held) facts.push(`${e.held} held`)
  return `- "${e.title}": ${facts.join(', ')}. source ${JSON.stringify(e.source)}${e.snippet ? `\n  “${e.snippet}”` : ''}`
}

const findInput = z.object({
  query: z.string().max(500).optional().describe('Words in the title or written inside. Leave it out to list by the filters alone.'),
  kinds: z.array(z.enum(FIND_KINDS)).optional().describe('document, sheet, pdf, slides (a deck), media, meeting (a recording), form, dashboard'),
  where: z.array(z.enum(FIND_WHERE)).optional().describe('lifeos, folder (the workspace folder on this host), google, microsoft, thread (made in a thread)'),
  project: z.string().max(200).optional().describe('A LifeOS project, by name or id.'),
  edited_within: z.enum(EDITED_WITHIN).optional(),
  edited_after: z.string().max(40).optional().describe('A date or time, as 2026-10-01 or 2026-10-01T14:00.'),
  edited_before: z.string().max(40).optional(),
  by: z.array(z.enum(FIND_BY)).optional().describe('Who last changed it: owner, agent or guest.'),
  shared: z.boolean().optional().describe('Only what others can see: shared, guest-linked, or in Google or Microsoft.'),
  review: z.boolean().optional().describe('Only what has open comments or suggestions waiting.'),
  held: z.boolean().optional().describe('Only what a held act in the Outbox names.'),
  sort: z.enum(FIND_SORTS).optional().describe('edited (default), created or name'),
  limit: z.number().int().min(1).max(50).optional()
})

/**
 * `doc_find`: the docs pillar's finding (find.ts) as a tool, over the folder walk Files' search uses. A workspace's thread searches that workspace,
 * and so its sector alone; a Work Chat searches every Work workspace on this host.
 */
async function find(ctx: ToolCtx, a: z.infer<typeof findInput>): Promise<WorkToolResult> {
  const { findDocs } = await import('./find')
  if (orphaned(ctx)) return fail('This thread has no Work workspace, so it has no documents to find.')
  const ids = ctx.scope.workspaceId
    ? [ctx.scope.workspaceId]
    : (ctx.db.prepare("SELECT id FROM workspaces WHERE kind = 'work'").all() as { id: string }[]).map((r) => r.id)
  const by = { kind: 'model' as const, caps: [], sessionId: ctx.sessionId }
  // One workspace that does not answer leaves the others' answers standing.
  const settled = await Promise.allSettled(ids.map((workspaceId) => findDocs(ctx, by, { workspaceId, query: a.query })))
  const answers = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  const failed = settled.flatMap((r) => (r.status === 'rejected' ? [errorText(r.reason)] : []))
  if (!answers.length && failed.length) return fail(failed[0]!)
  const projects = new Map(answers.flatMap((x) => x.projects.map((p) => [p.id, p.name] as const)))
  const filter: FindFilter = {
    ...(a.kinds ? { kinds: a.kinds } : {}),
    ...(a.where ? { where: a.where } : {}),
    ...(a.by ? { by: a.by } : {}),
    ...(a.edited_within ? { within: a.edited_within } : {}),
    ...(a.shared ? { shared: true } : {}),
    ...(a.review ? { review: true } : {}),
    ...(a.held ? { held: true } : {})
  }
  const after = dateOf(a.edited_after, 'edited_after')
  const before = dateOf(a.edited_before, 'edited_before')
  if (after !== undefined) filter.after = after
  if (before !== undefined) filter.before = before
  if (a.project) {
    const want = a.project.trim().toLowerCase()
    const matched = [...projects].filter(([id, name]) => id === a.project || name.toLowerCase() === want || name.toLowerCase().includes(want)).map(([id]) => id)
    if (!matched.length) return workText(`No project is named "${a.project}". The projects are: ${[...projects.values()].join(', ') || 'none'}.`)
    filter.projects = matched
  }
  const hits = new Map(answers.flatMap((x) => x.hits.map((h) => [h.key, h.snippet] as const)))
  const found = findIn(answers.flatMap((x) => x.entries), { query: a.query ?? '', filter, sort: a.sort ?? 'edited' }, hits)
  const limit = a.limit ?? 20
  const missing = answers.map((x) => x.lifeos).find(Boolean)
  const head = `${missing ? `LifeOS did not answer (${missing}), so its documents are not in this list.\n` : ''}${failed.length ? `${failed.length} workspace${failed.length === 1 ? '' : 's'} did not answer (${failed[0]}).\n` : ''}`
  if (!found.length) return workText(`${head}Nothing matches.`)
  const more = found.length > limit ? `\n${found.length - limit} more match; narrow the search or raise \`limit\`.` : ''
  return workText(`${head}${found.slice(0, limit).map((e) => foundLine(e, projects)).join('\n')}${more}\nOpen one with canvas_open and its source; a LifeOS document or a .tcdoc also reads with doc_read.`)
}

export const docTools: WorkTool[] = [
  {
    name: 'doc_find',
    description:
      'Finds documents, sheets, PDFs, decks, media, recordings, forms and dashboards in this workspace: by words in the title or written inside (LifeOS documents, .tcdoc and .csv files in the folder), and by kind, place, project, when and by whom it was last edited, sharing, open comments or waiting suggestions, and held acts. Each line ends with the source to open it by.',
    input: findInput,
    readOnly: true,
    run: async (args, ctx) => {
      try {
        return await find(ctx, args as z.infer<typeof findInput>)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'doc_read',
    description:
      'Reads a document as markdown, with its open comment threads after it. Use `with: "styles"` for styles and page setup. Pass `item` for a document open in the canvas, `doc` for a LifeOS document id, or `file` for a .tcdoc path.',
    input: z.object({ ...target, with: z.literal('styles').optional() }),
    readOnly: true,
    run: async (args, ctx) => {
      try {
        const a = args as TargetArgs & { with?: 'styles' }
        const { t, shared, fence } = await resolve(ctx, a)
        const got = (await ctx.service.internal('/internal/docs/read', { ...serviceTarget(t, shared, fence), ...(a.with ? { with: a.with } : {}) })) as { markdown: string; styles?: string[]; revision: string }
        const { readThreads } = await import('./threads')
        const open = (await readThreads(ctx, t)).filter((r) => !r.thread.resolved && r.thread.deletedAt === null)
        const threads = open.map((r) => `- on “${r.thread.quote ?? ''}”: ${r.comments.filter((c) => c.deletedAt === null).map((c) => plainBody(c.body)).join(' / ')}`)
        // The revision is the service's, of the very text answered here: never of a second read taken later.
        return workText(`${shared ? 'Others share this document.\n\n' : ''}${got.markdown}${got.styles ? '\n\n' + got.styles.join('\n') : ''}${threads.length ? `\n\n---\nOpen comments:\n${threads.join('\n')}` : ''}\n\n---\nRevision ${got.revision}: pass it to doc_write as \`revision\`.`)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'doc_write',
    description:
      'Rewrites a document: pass its whole new text as markdown, and the `revision` doc_read gave (a document changed since is refused: read it again); blocks you leave as they were keep their place, comments and ids. Say why: `because: "asked"` with `quote`, the owner\'s own words asking for this change, writes at once; ' +
      '`"routine"` writes at once when this thread runs a routine; `"own"` is your own idea: on a document others share, or one he set to suggest, it waits as suggestions he steps through; on his own document it is written and he can take it back.',
    input: z.object({
      ...target,
      markdown: z.string().max(900_000),
      because: z.enum(['asked', 'routine', 'own']),
      quote: z.string().max(2000).optional().describe('With "asked": the owner\'s words, as he typed them in this thread.'),
      revision: z.string().max(64).optional().describe('The revision doc_read ended with.')
    }),
    readOnly: false,
    run: async (args, ctx) => {
      try {
        return await write(ctx, args as TargetArgs & { markdown: string; because: 'asked' | 'routine' | 'own'; quote?: string; revision?: string })
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'doc_format',
    description: 'Formats text by quote, block IDs, style or all. Can set a named style, theme, page setup, header or footer. Pass item, doc or file. Give because and, when asked, quote the owner’s words. Your own changes on a shared document wait as suggestions.',
    input: formatInput,
    readOnly: false,
    run: async (args, ctx) => {
      try {
        return await format(ctx, args as FormatArgs)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'doc_suggest',
    description:
      'Proposes a rewrite of a document as suggestions: pass its whole new text as markdown. Nothing in the document changes; the owner steps through each change in the text and accepts or rejects it.',
    input: z.object({ ...target, markdown: z.string().max(900_000), revision: z.string().max(64).optional().describe('The revision doc_read ended with: a document changed since is refused.') }),
    readOnly: false,
    run: async (args, ctx) => {
      try {
        return await write(ctx, { ...(args as TargetArgs & { markdown: string; revision?: string }), because: 'own', suggest: true })
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'doc_comment',
    description:
      'Comments on words in a document only the owner sees: `quote` is the words, exactly as they stand (the first place they stand is marked); `body` is the comment, plain text. A shared document refuses it: others would read it before he did.',
    input: z.object({ ...target, quote: z.string().min(1).max(2000), body: z.string().min(1).max(20_000) }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as TargetArgs & { quote: string; body: string }
      try {
        const { t, shared, fence } = await resolve(ctx, a, true)
        // A comment on a shared document reaches its other readers at once, with no press of his (milestone 50's hold review, finding 7).
        if (shared) return fail(SHARED_COMMENT)
        const principal = agentPrincipal(ctx.host, ctx.sessionId)
        const made = (await changeThread(ctx, t, { op: 'create', body: commentBody(a.body), quote: a.quote }, principal)) as { thread?: { publicId: string } }
        const threadId = made.thread?.publicId
        if (!threadId) throw new Error('the comment was not made')
        const { marked } = (await ctx.service.internal('/internal/docs/mark', { ...serviceTarget(t, shared, fence), quote: a.quote, threadId, principal })) as { marked: boolean }
        if (!marked) {
          await changeThread(ctx, t, { op: 'deleteThread', threadId }, principal)
          return fail('Those words are not in the document. Quote them exactly as they stand.')
        }
        docsOf(ctx).push({ push: 'work.docs', doc: t.doc, threads: true }, pathOf(t))
        return workText('Commented.')
      } catch (err) {
        return fail(errorText(err))
      }
    }
  }
]

export const SHARED_COMMENT = "Others read this document's comments, so yours would reach them before the owner saw it. Tell him in the thread, or suggest the change with doc_suggest."

/** A comment's body as the editor keeps it: BlockNote block JSON. */
export const commentBody = (text: string): string =>
  JSON.stringify(text.split(/\n{2,}/).map((para) => ({ type: 'paragraph', content: [{ type: 'text', text: para, styles: {} }] })))

/** A stored comment body as plain words. */
export function plainBody(body: string): string {
  try {
    const blocks = JSON.parse(body) as Array<{ content?: Array<{ text?: string }> }>
    return blocks.map((b) => (b.content ?? []).map((c) => c.text ?? '').join('')).join(' ')
  } catch {
    return body
  }
}
