import { randomUUID } from 'node:crypto'
import { z, type ZodType } from 'zod'
import { OfficeCellSchema, type OfficeCell } from '@shared/contract-work-office'
import { workText, type Principal, type WorkToolResult } from '@shared/work'
import { judgeWrite, WriteReasonSchema, type WriteReason } from '@shared/work/because'
import { errorText } from '@shared/work/ids'
import type { ToolCtx, WorkCtx, WorkTool } from '../modules'
import { parseA1, rangeCells } from '../sheets/a1'
import type { SuggestionStore } from '../sheets/suggestions'
import type { OfficeCarrier } from './carrier'
import { cellOf, EXCEL_MAX_CELLS, excelStore, type ExcelHelper } from './excel'

/**
 * The one Office tool set (architecture §10; docs/agents/work-office.md "The
 * tools"). Each tool runs on the host that has the app: here when this host
 * has a carrier, else on the first host the thread's workspace may use
 * ("May use this Mac"), through `ctx.peer`, which runs the same tool there.
 *
 * The rule for a file others can open (a workbook or document in OneDrive,
 * SharePoint or Teams, named by its URL): a change he asked for in so many
 * words is written; the agent's own idea waits for him (a suggestion in the
 * grid, a tracked change in Word). Sends, replies, forwards, invitations and
 * answers to invitations are held acts: the tool answers what waits for his
 * press, and nothing goes before it.
 */

/** What a tool's `run` gets wherever it runs. */
export interface Env {
  ctx: WorkCtx
  carrier: OfficeCarrier
  excel: ExcelHelper
  suggestions: SuggestionStore
  /** who writes: the calling thread */
  by: Principal
  /** the calling thread, when it is on this host (a held act names it) */
  sessionId: string | null
  /** the calling host found the owner's own words for this change (`ctx.threads.ownerSaid`) */
  asked: boolean
}

export interface OfficeTool {
  name: string
  description: string
  input: z.ZodObject<z.ZodRawShape>
  readOnly: boolean
  run(args: never, env: Env): Promise<WorkToolResult>
}

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const json = (v: unknown): WorkToolResult => workText(JSON.stringify(v, null, 1))
/** others can open it: it lives in OneDrive, SharePoint or Teams */
export const sharedKey = (key: string): boolean => /^https?:\/\//i.test(key)
const judged = (reason: WriteReason, key: string, env: Env) => judgeWrite(reason, { shared: sharedKey(key), ownerSaid: () => env.asked })

const Reason = WriteReasonSchema.shape
const Addresses = z.array(z.string().max(320)).max(100)
const MailFields = {
  to: Addresses.describe('Recipients.'),
  cc: Addresses.optional(),
  bcc: Addresses.optional(),
  subject: z.string().max(998),
  html: z.string().max(2_000_000).describe('The body as HTML (bold, links, lists and tables keep their look in Outlook).'),
  account: z.string().max(320).optional().describe("The Outlook account it goes from, by address; absent: Outlook's default.")
}

const tool = <S extends z.ZodRawShape>(t: { name: string; description: string; input: S; readOnly: boolean; run(a: z.infer<z.ZodObject<S>>, env: Env): Promise<WorkToolResult> }): OfficeTool =>
  ({ ...t, input: z.object(t.input) }) as unknown as OfficeTool

/** `'Q1 Budget'!B2:D9` as its sheet and its address. The sheet is required: Excel has no "first sheet" by id. */
function rangeOf(text: string): { sheet: string; range: NonNullable<ReturnType<typeof parseA1>> } {
  const r = parseA1(text)
  if (!r) throw new Error(`${text} is not a range: write 'Sheet name'!B2:D9.`)
  if (r.sheet === undefined) throw new Error(`Name the sheet: 'Sheet1'!${text}.`)
  return { sheet: r.sheet, range: r }
}

export const OFFICE_TOOLS: OfficeTool[] = [
  tool({
    name: 'office_files',
    description: 'Lists the Office files open on the Mac: workbooks with their sheets and used sizes, Word documents and PowerPoint decks, each with the `key` the other office tools take (a path, or a URL for a file in OneDrive, SharePoint or Teams).',
    input: {},
    readOnly: true,
    async run(_a, env) {
      const apps = await env.carrier.apps()
      const on = (app: string) => apps.some((s) => s.app === app && s.running)
      return json({
        apps,
        workbooks: on('excel') ? await env.carrier.workbooks() : [],
        documents: on('word') ? await env.carrier.documents() : [],
        decks: on('powerpoint') ? await env.carrier.presentations() : []
      })
    }
  }),
  tool({
    name: 'office_range_read',
    description: `Reads a range of an open Excel workbook: each cell's value and formula, and the range's \`hash\`, which \`office_range_write\` takes as \`base\` so it never writes over a change made since. At most ${EXCEL_MAX_CELLS.toLocaleString('en-US')} cells a call.`,
    input: { workbook: z.string().describe('The workbook\'s key from `office_files`.'), range: z.string().describe("'Sheet1'!A1:F40") },
    readOnly: true,
    async run(a, env) {
      const { sheet, range } = rangeOf(a.range)
      const b = await env.excel.read(a.workbook, sheet, range)
      return json({ range: a.range, hash: b.hash, values: b.values, formulas: b.formulas })
    }
  }),
  tool({
    name: 'office_range_write',
    description:
      "Writes a block of cells in an open Excel workbook, through Excel. `values` is rows of cells, the block's size; a string starting with = is a formula, null empties a cell. Pass the `hash` you read as `base`: if the cells changed since, nothing is written and the answer is `conflict` with what they hold now. " +
      'On a workbook others can open (a URL), say why: `because: "asked"` with his words as `quote` writes it; your own idea waits as suggestions he steps through. Answers a `writeId` for `office_range_undo`.',
    input: { workbook: z.string(), range: z.string(), values: z.array(z.array(OfficeCellSchema)).min(1), base: z.string().optional(), ...Reason },
    readOnly: false,
    async run(a, env) {
      const { sheet, range } = rangeOf(a.range)
      const rows = range.endRow - range.startRow + 1
      const cols = range.endColumn - range.startColumn + 1
      if (a.values.length !== rows || a.values.some((r) => r.length !== cols)) return fail(`${a.range} is ${rows} by ${cols}: pass that many rows of that many cells.`)
      if (rangeCells(range) > EXCEL_MAX_CELLS) return fail(`Write at most ${EXCEL_MAX_CELLS.toLocaleString('en-US')} cells a call.`)
      if (judged(a, a.workbook, env) === 'suggest') {
        const now = await env.excel.read(a.workbook, sheet, range)
        if (a.base !== undefined && a.base !== now.hash) return json({ conflict: true, now: now.values })
        const n = env.suggestions.add(
          excelStore(a.workbook),
          randomUUID(),
          env.by,
          a.because === 'own' ? undefined : 'his words were not found in this thread',
          a.values.flatMap((row, i) =>
            row.map((v, j) => ({
              sheet,
              row: range.startRow + i,
              col: range.startColumn + j,
              base: cellOf(now.values[i][j], now.formulas[i][j]),
              proposed: cellOf(v, typeof v === 'string' && v.startsWith('=') ? v : '')
            }))
          )
        )
        return workText(`Others can open this workbook, so nothing was written: ${n} cell${n === 1 ? ' waits' : 's wait'} as suggestions for the owner to take or leave.`)
      }
      const res = await env.excel.write(a.workbook, sheet, range, a.values as OfficeCell[][], { base: a.base, by: env.by })
      return 'conflict' in res ? json({ conflict: true, now: res.now.values }) : json({ written: a.range, writeId: res.writeId, hash: res.hash })
    }
  }),
  tool({
    name: 'office_range_undo',
    description: 'Takes back one of your writes to a workbook (its `writeId`), while its cells still hold what you wrote. Excel\'s own Undo does not cover scripted writes.',
    input: { workbook: z.string(), writeId: z.string() },
    readOnly: false,
    async run(a, env) {
      const res = await env.excel.undo(a.writeId)
      return 'conflict' in res ? fail('Those cells changed since your write: nothing was taken back.') : workText('Taken back.')
    }
  }),
  tool({
    name: 'office_doc_read',
    description: 'Reads an open Word document as paragraphs.',
    input: { document: z.string().describe('The key from `office_files`.') },
    readOnly: true,
    run: async (a, env) => json(await env.carrier.readDocument(a.document))
  }),
  tool({
    name: 'office_doc_edit',
    description:
      'Changes an open Word document: `insert` text at its `start` or `end`, or `find` and `replace` every match. On a document others can open, your own idea is made as a tracked change he accepts or rejects in Word; `because: "asked"` with his words as `quote` writes it plainly.',
    input: { document: z.string(), insert: z.string().max(100_000).optional(), at: z.enum(['start', 'end']).optional(), find: z.string().min(1).max(255).optional(), replace: z.string().max(255).optional(), ...Reason },
    readOnly: false,
    async run(a, env) {
      const edit = a.insert !== undefined ? { insert: a.insert, at: a.at ?? 'end' } : a.find !== undefined && a.replace !== undefined ? { find: a.find, replace: a.replace } : null
      if (!edit) return fail('Pass `insert` (with `at`), or `find` and `replace`.')
      const tracked = judged(a, a.document, env) === 'suggest'
      const n = await env.carrier.editDocument(a.document, edit, tracked)
      return workText(`${n === 0 ? 'Nothing matched.' : `Changed ${n} place${n === 1 ? '' : 's'}`}${n && tracked ? ', as tracked changes for the owner to accept.' : n ? '.' : ''}`)
    }
  }),
  tool({
    name: 'office_slides_read',
    description: "Reads an open PowerPoint deck: each slide's text.",
    input: { deck: z.string().describe('The key from `office_files`.') },
    readOnly: true,
    run: async (a, env) => json(await env.carrier.readSlides(a.deck))
  }),
  tool({
    name: 'office_slides_replace',
    description: 'Replaces text on every slide of an open deck. A deck others can open is changed only when he asked for it (`because: "asked"` with his words as `quote`); PowerPoint keeps no suggestions, so otherwise say the change in your reply.',
    input: { deck: z.string(), find: z.string().min(1).max(1_000), replace: z.string().max(1_000), ...Reason },
    readOnly: false,
    async run(a, env) {
      if (judged(a, a.deck, env) === 'suggest') return fail('Others can open this deck and he did not ask for this change in so many words: nothing was changed. Say it in your reply instead.')
      const n = await env.carrier.replaceSlideText(a.deck, a.find, a.replace)
      return workText(n ? `Changed ${n} text box${n === 1 ? '' : 'es'}.` : 'Nothing matched.')
    }
  }),
  tool({
    name: 'office_mail_list',
    description: 'Lists mail in Outlook: the inbox, sent or drafts, newest first, optionally only subjects containing `query`.',
    input: { folder: z.enum(['inbox', 'sent', 'drafts']).default('inbox'), query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(25) },
    readOnly: true,
    run: async (a, env) => json(await env.carrier.listMail(a))
  }),
  tool({
    name: 'office_mail_read',
    description: 'Reads one mail in Outlook by the id `office_mail_list` gave.',
    input: { id: z.string().max(200) },
    readOnly: true,
    run: async (a, env) => json(await env.carrier.readMail(a.id))
  }),
  tool({
    name: 'office_mail_draft',
    description: "Leaves a draft in Outlook's Drafts for the owner to finish and send himself. Nothing is sent.",
    input: { ...MailFields, replyTo: z.string().max(200).optional().describe('The id of the mail it answers.') },
    readOnly: false,
    async run(a, env) {
      const id = await env.carrier.draftMail({ ...a, cc: a.cc ?? [], bcc: a.bcc ?? [] })
      return workText(`Left in Outlook's Drafts (${id}).`)
    }
  }),
  tool({
    name: 'office_mail_send',
    description:
      "Sends, replies to (`replyTo`) or forwards (`forward`) a mail through Outlook, with its formatting. It is held: it waits in the owner's Outbox, where he can change it, and goes only when he presses Send. The answer says it is waiting.",
    input: { ...MailFields, replyTo: z.string().max(200).optional(), forward: z.string().max(200).optional() },
    readOnly: false,
    async run(a, env) {
      if (a.replyTo && a.forward) return fail('A mail answers one mail or passes one on, not both.')
      const item = env.ctx.held.create({
        kind: 'office.mail.send',
        sessionId: env.sessionId,
        account: a.account,
        payload: { host: env.ctx.host, ...a, cc: a.cc ?? [], bcc: a.bcc ?? [] }
      })
      return heldAnswer(item.state, item.summary)
    }
  }),
  tool({
    name: 'office_calendar_list',
    description: "Lists events in Outlook's calendar that start between `from` and `to` (ISO 8601).",
    input: { from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) },
    readOnly: true,
    run: async (a, env) => json(await env.carrier.events(a.from, a.to))
  }),
  tool({
    name: 'office_calendar_create',
    description:
      "Puts an event in the owner's Outlook calendar. With nobody invited it is a hold on his own calendar and is made at once; with `attendees` it is an invitation, held for his press like a mail.",
    input: {
      subject: z.string().min(1).max(255),
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
      location: z.string().max(255).optional(),
      body: z.string().max(100_000).optional(),
      attendees: Addresses.default([]),
      account: z.string().max(320).optional()
    },
    readOnly: false,
    async run(a, env) {
      if (a.end <= a.start) return fail('The end comes after the start.')
      if (!a.attendees.length) return workText(`On his calendar (${await env.carrier.createEvent(a)}).`)
      const item = env.ctx.held.create({ kind: 'office.calendar.op', sessionId: env.sessionId, account: a.account, payload: { host: env.ctx.host, op: 'create', event: a } })
      return heldAnswer(item.state, item.summary)
    }
  }),
  tool({
    name: 'office_calendar_answer',
    description: "Answers an invitation in Outlook (accept, decline or tentative). Held: it waits for the owner's press.",
    input: { id: z.string().max(200), subject: z.string().max(255).describe("The event's subject, as he will see it on the held card."), answer: z.enum(['accept', 'decline', 'tentative']), comment: z.string().max(10_000).optional() },
    readOnly: false,
    async run(a, env) {
      const item = env.ctx.held.create({ kind: 'office.calendar.op', sessionId: env.sessionId, payload: { host: env.ctx.host, op: 'answer', ...a } })
      return heldAnswer(item.state, item.summary)
    }
  })
]

/** What a held tool answers: it waits for him, or a grant he made let it go. */
function heldAnswer(state: string, summary: string): WorkToolResult {
  if (state === 'held') return workText(`Held for the owner: "${summary}" waits in his Outbox and goes only when he presses it.`)
  return workText(`"${summary}": a grant he made covers it, so it went (${state}).`)
}

/** The tool by name, or a refusal: the peer route names tools by string. */
export function officeTool(name: string): OfficeTool {
  const t = OFFICE_TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`There is no Office tool ${name}.`)
  return t
}

/** Runs a tool here, its arguments checked against its own schema. Never throws: a refusal is an error result. */
export async function runHere(t: OfficeTool, args: unknown, env: Env): Promise<WorkToolResult> {
  const parsed = (t.input as ZodType).safeParse(args ?? {})
  if (!parsed.success) return fail(`The arguments do not fit ${t.name}: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  try {
    return await t.run(parsed.data as never, env)
  } catch (err) {
    return fail(errorText(err))
  }
}

/** Whether the owner's words for this change are in the thread: the one thing `asked` rests on. */
export function askedIn(ctx: ToolCtx, args: unknown): boolean {
  const a = args as { because?: string; quote?: string } | null
  if (a?.because !== 'asked' || !a.quote) return false
  try {
    return ctx.threads.ownerSaid(ctx.sessionId, a.quote)
  } catch {
    return false
  }
}

export interface ToolDeps {
  /** this host's carrier and helper, or null where no Office runs */
  here(ctx: WorkCtx): { carrier: OfficeCarrier; excel: ExcelHelper; suggestions: SuggestionStore } | null
}

/** The tools as the frame mounts them: here when this host has Office, else on the workspace's desktop host. */
export function workTools(deps: ToolDeps): WorkTool[] {
  return OFFICE_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input: t.input,
    readOnly: t.readOnly,
    async run(args, ctx: ToolCtx) {
      const asked = !t.readOnly && askedIn(ctx, args)
      const here = deps.here(ctx)
      if (here) return runHere(t, args, { ctx, ...here, by: `agent:${ctx.host}:${ctx.sessionId}`, sessionId: ctx.sessionId, asked })
      const host = ctx.scope.workspaceId ? ctx.settings.workspace(ctx.scope.workspaceId).mayUseDesktop[0] : undefined
      if (!host) return fail('No Office on this host, and this workspace may use no desktop that has it (Work settings → May use this Mac).')
      try {
        const verb = t.readOnly ? 'read' : 'write'
        const body = t.readOnly ? { tool: t.name, args } : { tool: t.name, args, asked, by: `agent:${ctx.host}:${ctx.sessionId}` }
        return (await ctx.peer(host).call('office', verb, body)) as WorkToolResult
      } catch (err) {
        return fail(errorText(err))
      }
    }
  }))
}
