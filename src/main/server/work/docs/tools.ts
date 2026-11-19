import { z } from 'zod'
import { agentPrincipal, workText, type CanvasSource, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { ToolCtx, WorkTool } from '../modules'
import { docsOf, modeOf, wrote } from './state'
import { lifeosRow, pathOf, serviceTarget, targetOf, type DocTarget } from './target'
import { changeThread } from './threads'

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

async function resolve(ctx: ToolCtx, a: TargetArgs): Promise<{ t: DocTarget; shared: boolean }> {
  let source: CanvasSource
  if (a.item) {
    const item = ctx.canvas.get(a.item)
    if (!item || item.kind !== 'document' || item.sessionId !== ctx.canvas.paneOf(ctx.sessionId)) throw new Error(`This thread has no document ${a.item} in its canvas.`)
    source = item.source
  } else if (a.doc) source = { at: 'lifeos', table: 'docs', id: a.doc }
  else if (a.file) source = { at: 'file', host: ctx.host, path: a.file }
  else throw new Error('Pass `item` (a document open in the canvas), `doc` (a LifeOS document id) or `file` (a .tcdoc path).')
  const t = await targetOf(ctx, { kind: 'model', caps: [], sessionId: ctx.sessionId }, 'doc', source)
  const row = await lifeosRow(ctx, t)
  return { t, shared: !!row?.shared || ctx.scope.shared(t.source) }
}

function ownerSaid(ctx: ToolCtx, quote: string | undefined): boolean {
  if (!quote?.trim()) return false
  try {
    return ctx.threads.ownerSaid(ctx.sessionId, quote)
  } catch {
    return false
  }
}

type ServiceWrite = { mode: 'direct'; versionId?: string } | { mode: 'branch'; branchId: string; versionId: string }

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

async function write(ctx: ToolCtx, a: TargetArgs & { markdown: string; because: 'asked' | 'routine' | 'own'; quote?: string; suggest?: boolean }): Promise<WorkToolResult> {
  const { t, shared } = await resolve(ctx, a)
  const asked = a.because === 'asked' && ownerSaid(ctx, a.quote)
  const routine = a.because === 'routine' && !!ctx.scope.routineRunId
  const verdict = asked ? 'asked' : routine ? 'routine' : 'own'
  const suggest = a.suggest === true || (verdict === 'own' && (shared || modeOf(ctx, t.doc) === 'suggests'))
  const before = ((await ctx.service.internal('/internal/docs/read', serviceTarget(t, shared))) as { markdown: string }).markdown
  const principal = agentPrincipal(ctx.host, ctx.sessionId)
  const done = (await ctx.service.internal('/internal/docs/write', { ...serviceTarget(t, shared), markdown: a.markdown, because: verdict, suggest, principal })) as ServiceWrite
  const note =
    a.because === 'asked' && !asked
      ? " The quote was not found among the owner's words in this thread, so this counts as your own idea."
      : a.because === 'routine' && !routine
        ? ' This thread runs no routine, so this counts as your own idea.'
        : ''
  const parts = changedParts(before, a.markdown)
  if (done.mode === 'branch') {
    docsOf(ctx).push({ push: 'work.docs', doc: t.doc, branches: true }, pathOf(t))
    const why = a.suggest ? 'he steps through them in the document' : shared ? 'others share this document, so he accepts or rejects each one' : 'he set this document to suggest, so he accepts or rejects each one'
    return workText(`Suggested changes to ${plural(parts.count, parts.unit)}: ${why}.${note}`)
  }
  const text = `Wrote ${plural(parts.count, parts.unit)}`
  // His own document, on the agent's own idea: the bar says what was written, with Undo.
  if (verdict === 'own' && done.versionId) wrote(ctx, t.doc, { text, at: Date.now(), versionId: done.versionId }, pathOf(t))
  return workText(`${text}.${note}`)
}

export const docTools: WorkTool[] = [
  {
    name: 'doc_read',
    description:
      'Reads a document as markdown, with its open comment threads after it. Pass `item` for a document open in the canvas, `doc` for a LifeOS document id, or `file` for a .tcdoc path.',
    input: z.object(target),
    readOnly: true,
    run: async (args, ctx) => {
      try {
        const { t, shared } = await resolve(ctx, args as TargetArgs)
        const got = (await ctx.service.internal('/internal/docs/read', serviceTarget(t, shared))) as { markdown: string }
        const { readThreads } = await import('./threads')
        const open = (await readThreads(ctx, t)).filter((r) => !r.thread.resolved && r.thread.deletedAt === null)
        const threads = open.map((r) => `- on “${r.thread.quote ?? ''}”: ${r.comments.filter((c) => c.deletedAt === null).map((c) => plainBody(c.body)).join(' / ')}`)
        return workText(`${shared ? 'Others share this document.\n\n' : ''}${got.markdown}${threads.length ? `\n\n---\nOpen comments:\n${threads.join('\n')}` : ''}`)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'doc_write',
    description:
      'Rewrites a document: pass its whole new text as markdown; blocks you leave as they were keep their place, comments and ids. Say why: `because: "asked"` with `quote`, the owner\'s own words asking for this change, writes at once; ' +
      '`"routine"` writes at once when this thread runs a routine; `"own"` is your own idea: on a document others share, or one he set to suggest, it waits as suggestions he steps through; on his own document it is written and he can take it back.',
    input: z.object({
      ...target,
      markdown: z.string().max(900_000),
      because: z.enum(['asked', 'routine', 'own']),
      quote: z.string().max(2000).optional().describe('With "asked": the owner\'s words, as he typed them in this thread.')
    }),
    readOnly: false,
    run: async (args, ctx) => {
      try {
        return await write(ctx, args as TargetArgs & { markdown: string; because: 'asked' | 'routine' | 'own'; quote?: string })
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'doc_suggest',
    description:
      'Proposes a rewrite of a document as suggestions: pass its whole new text as markdown. Nothing in the document changes; the owner steps through each change in the text and accepts or rejects it.',
    input: z.object({ ...target, markdown: z.string().max(900_000) }),
    readOnly: false,
    run: async (args, ctx) => {
      try {
        return await write(ctx, { ...(args as TargetArgs & { markdown: string }), because: 'own', suggest: true })
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'doc_comment',
    description: 'Comments on words in a document: `quote` is the words, exactly as they stand (the first place they stand is marked); `body` is the comment, plain text.',
    input: z.object({ ...target, quote: z.string().min(1).max(2000), body: z.string().min(1).max(20_000) }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as TargetArgs & { quote: string; body: string }
      try {
        const { t, shared } = await resolve(ctx, a)
        const principal = agentPrincipal(ctx.host, ctx.sessionId)
        const made = (await changeThread(ctx, t, { op: 'create', body: commentBody(a.body), quote: a.quote }, principal)) as { thread?: { publicId: string } }
        const threadId = made.thread?.publicId
        if (!threadId) throw new Error('the comment was not made')
        const { marked } = (await ctx.service.internal('/internal/docs/mark', { ...serviceTarget(t, shared), quote: a.quote, threadId, principal })) as { marked: boolean }
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
