import { z } from 'zod'
import { basename } from 'node:path'
import { GUEST_DEFAULT_DAYS, GUEST_ROLES, GuestLinkActSchema, guestRefusal, GuestsRequestSchemas, type GuestLinkAct, type GuestSource, type LifeosGuestSource } from '@shared/contract-work-guests'
import { handled, NOT_HANDLED, workText, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { ActKindDef, WorkCtx, WorkModule, WorkTool } from '../modules'
import { ActStale } from '../outbox/kinds'
import { serviceOf } from '../service/ctx'
import { GuestRuntime, TICK_MS } from './links'
import { ensureGuestTables } from './store'
import { guestsHealth } from './health'
import { hisZone } from '../clock'
import { heldReceipt } from '../outbox/words'

/**
 * The guests pillar's server module (docs/agents/work-guests.md): one named
 * guest on one LifeOS document or sheet, to view, comment or edit, or on one
 * LifeOS project, to view, until the link ends or is revoked. The owner makes one from Share; an agent can only
 * ask, and its request waits in the Outbox as `share.guestLink` for his
 * press. The Work service serves the guest's page and checks every connect
 * and write against what this module tells it (service/routes/guests.ts).
 */

/** One runtime per host, by its database: a tool's and an act's context are copies of the host's. */
const runtimes = new WeakMap<object, GuestRuntime>()
export const guestRuntime = (ctx: WorkCtx): GuestRuntime => {
  let rt = runtimes.get(ctx.db)
  if (!rt) runtimes.set(ctx.db, (rt = new GuestRuntime(ctx)))
  return rt
}

const roleWords = (role: string): string => (role === 'view' ? 'view' : role === 'comment' ? 'comment' : 'edit')
const day = (zone: string, at: number): string => new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(at)

export const guestLinkKind: ActKindDef<GuestLinkAct, never> = {
  kind: 'share.guestLink',
  store: 'host',
  payload: GuestLinkActSchema,
  // No matcher: letting someone in takes no grant; every request waits for his press.
  words: (p) => ({ summary: `Make a guest link for ${p.name}: ${p.title}`, verb: 'Create link' }),
  async execute(p, act) {
    const refused = guestRefusal(p)
    if (refused) throw new ActStale(`${refused} Nothing was made.`)
    const made = await guestRuntime(act).create({ ...p, bySession: act.item.sessionId })
    if (act.item.sessionId) {
      await act.threads
        .resume(
          act.item.sessionId,
          `The owner made the guest link you asked for (${made.link.id}): ${p.name} can ${roleWords(p.role)} ${p.title} until ${day(hisZone(act), p.expiresAt)}. Its address is his alone to send: he copies it from Settings, Work, Guest links. Never ask him for it.`
        )
        .catch((err: Error) => act.log(`guests: the thread was not told: ${err.message}`))
    }
    return { summary: `Made a guest link for ${p.name}: ${p.title}`, ref: { linkId: made.link.id } }
  },
  wayBack: (r) => {
    const linkId = (r.ref as { linkId?: unknown } | undefined)?.linkId
    return typeof linkId === 'string' ? { pillar: 'guests', verb: 'guest_link_revoke', args: { linkId }, label: 'Revoke link' } : null
  }
}

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })

export const guestsTools: WorkTool[] = [
  {
    name: 'guest_link',
    description:
      'Asks for a guest link: one named person outside may open one LifeOS document or sheet, or one TempCode document or sheet kept as a file (.tcdoc, .tcsheet), on a web page with no sign-in, to view, comment or edit, or one LifeOS project to view (its tasks, and its documents and sheets read-only), until the day it ends. It is held: nothing is made until the owner presses Create in the Outbox; you are then told the link is made, and he sends its address himself (you never see it). Use it when he asks to send someone one of his documents or to show someone a project.',
    input: z.object({
      docId: z.string().optional().describe('A LifeOS document id (from the doc tools). Give one of docId, sheetId, projectId and path.'),
      sheetId: z.string().optional().describe('A LifeOS sheet id.'),
      projectId: z.string().optional().describe('A LifeOS project id (from list_projects or get_project).'),
      path: z.string().optional().describe("The absolute path of a .tcdoc or .tcsheet in your workspace (a file's link can view or edit)."),
      name: z.string().min(1).max(80).describe('The one person the link is for, as he would name them.'),
      role: z.enum(GUEST_ROLES).default('view').describe('view, comment or edit (a sheet: view or edit; a project: view).'),
      days: z.number().int().min(1).max(365).default(GUEST_DEFAULT_DAYS).describe('How many days until it ends.')
    }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { docId?: string; sheetId?: string; projectId?: string; path?: string; name: string; role: GuestLinkAct['role']; days: number }
      const named = ([['docs', a.docId], ['sheets', a.sheetId], ['projects', a.projectId], ['file', a.path]] as const).filter(([, id]) => !!id)
      if (named.length !== 1) return fail('Give a docId, a sheetId, a projectId or a path, one of the four.')
      try {
        const rt = guestRuntime(ctx)
        let source: GuestSource
        let title: string
        let fileId: string | undefined
        if (a.path) {
          source = { at: 'file', host: ctx.host, path: a.path }
          // A file outside this thread's own workspace is not its to share; the rest is checked as for the owner's own,
          // and his press makes the link only for this same file.
          fileId = rt.threadFile(a.path, ctx.scope.workspaceId)
          rt.resolve(source, { kind: 'model', caps: [], sessionId: ctx.sessionId }, 'guest_link', a.role)
          title = basename(a.path).replace(/\.tc(doc|sheet)$/i, '') || 'Untitled'
        } else {
          const [table, id] = named[0] as [LifeosGuestSource['table'], string]
          if (!/^[A-Za-z0-9]{1,64}$/.test(id)) return fail('LifeOS has no such item.')
          source = { at: 'lifeos', table, id }
          const row = await rt.itemRow(source)
          // An item of another sector is not this thread's to share, whatever id it was handed.
          if (ctx.scope.sector && row.sector !== ctx.scope.sector) return fail('LifeOS has no such item.')
          title = row.title
        }
        const payload: GuestLinkAct = { source, ...(fileId ? { fileId } : {}), title: title.slice(0, 200), name: a.name.trim(), role: a.role, expiresAt: Date.now() + a.days * 24 * 60 * 60_000 }
        const refused = guestRefusal(payload)
        if (refused) return fail(refused)
        const held = ctx.held.create({ kind: 'share.guestLink', sessionId: ctx.sessionId, payload })
        return workText(
          heldReceipt({ ...held, summary: `a guest link for ${payload.name} to ${payload.title}, can ${roleWords(payload.role)}, ends ${day(hisZone(ctx), payload.expiresAt)}` }, 'No link exists yet, and nothing was shared; he sends the address himself once he creates it.')
        )
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'guest_link_revoke',
    description: 'Revokes a guest link this thread asked for and the owner created: the guest is shut out at once.',
    input: z.object({ linkId: z.string().min(1).max(40).describe("The link's id, from its Outbox row or the note that it was made.") }),
    readOnly: false,
    run: async (args, ctx) => {
      const { linkId } = args as { linkId: string }
      const rt = guestRuntime(ctx)
      const link = rt.store.get(linkId)
      // Revoking only narrows, but a thread revokes only what its own tree asked for.
      if (!link || !link.bySession || ctx.canvas.paneOf(link.bySession) !== ctx.canvas.paneOf(ctx.sessionId)) return fail('This thread asked for no such guest link.')
      try {
        await rt.revoke(linkId)
        return workText(`Revoked the guest link for ${link.name}.`)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  }
]

const METHODS: ReadonlySet<string> = new Set(GuestsRequestSchemas.map((s) => s.shape.method.value))

export const guests: WorkModule = {
  id: 'guests',
  health: guestsHealth,
  ensure(db) {
    ensureGuestTables(db)
  },
  async handle(req, ctx, by) {
    if (!METHODS.has(req.method)) return NOT_HANDLED
    // His screens' methods: a thread asks through `guest_link`, where the hold applies.
    if (by.kind === 'model' && req.method !== 'work.guests.list' && req.method !== 'work.guests.forItem') throw new Error('Only the owner makes or revokes a guest link; a thread asks with guest_link.')
    const rt = guestRuntime(ctx)
    switch (req.method) {
      case 'work.guests.list':
        return handled(await rt.list())
      case 'work.guests.forItem':
        await rt.servedHere(req.params.source)
        // A file is checked as Create would check it: a sheet that cannot make a link says why at once.
        return handled(await rt.list(rt.resolve(req.params.source, by, req.method)))
      case 'work.guests.create':
        return handled(await rt.create({ ...req.params, bySession: null, by }))
      case 'work.guests.setRole':
        if (!(await rt.setRole(req.params.linkId, req.params.role))) throw new Error('That link no longer opens anything.')
        return handled({ ok: true })
      case 'work.guests.rekey': {
        const url = await rt.rekey(req.params.linkId)
        if (!url) throw new Error('That link no longer opens anything.')
        return handled({ url })
      }
      case 'work.guests.revoke':
        await rt.revoke(req.params.linkId)
        return handled({ ok: true })
      case 'work.guests.ticket':
        return handled(await rt.ticket(req.params.source, req.params.title, by, req.method))
    }
    return NOT_HANDLED
  },
  tools: () => guestsTools,
  acts: [guestLinkKind as ActKindDef],
  preamble: () =>
    "To let someone outside open one of the owner's LifeOS documents or sheets, ask with `guest_link` (one named person, view, comment or edit, a number of days): it waits for his press, and he sends the address himself; you never see it. Sending one of his documents means such a link unless he asks for a file. A whole project can be shown the same way (`guest_link` with `projectId`, view only): the guest sees its tasks as they stand, and its documents and sheets read-only.",
  start(ctx) {
    const rt = guestRuntime(ctx)
    const tick = (): void => void rt.tick().catch((err: Error) => ctx.log(`guests: ${err.message}`))
    tick()
    // The signer is made as the service starts: tell it the links as soon as it answers.
    void serviceOf(ctx)?.ready().then((up) => up && tick())
    const timer = setInterval(tick, TICK_MS)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      rt.stop()
    }
  }
}
