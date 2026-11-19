import { z } from 'zod'
import { PortalSourceSchema, type BrowserState } from '@shared/contract-work-browser'
import { handled, NOT_HANDLED, workText } from '@shared/work'
import type { ActKindDef, ToolCtx, WorkCtx, WorkModule, WorkTool } from '../modules'
import { DriveStore, ensureBrowserTables } from './drive'
import { TEAMS_UNAVAILABLE, teamsCarrier, TeamsPostSchema, teamsPostKind } from './teams'

/**
 * The browser pillar's server module (docs/agents/work-browser.md): the
 * live browser beside a Work thread, who drives it, what a page needs of
 * the owner, where the values on a page came from, and the held Teams
 * reply. The picture is computer use's own live stream, and a submit on
 * the final screen is the computer hold's live item: this module adds no
 * hold of its own to a click.
 */

export const NOT_A_PERSON = 'refused: only a person takes over the browser or hands it back'
export const HANDED_BACK = 'He handed the browser back. Read the window again before you act: he may have changed the page. Then carry on.'
export const OWNER_DRIVES = 'He is driving the browser now. Do not use computer use until he hands it back; end your turn and say where you will pick up.'

export const NOT_WORK = 'refused: that is not a Work thread'

/** Handing back wakes the thread that was driving (a subagent, say), else the pane's own; the wheel is his to give either way. */
async function wake(ctx: WorkCtx, actor: string | null, pane: string): Promise<void> {
  for (const id of actor && actor !== pane ? [actor, pane] : [pane]) {
    try {
      await ctx.threads.resume(id, HANDED_BACK)
      return
    } catch (err) {
      ctx.log(`browser: could not tell ${id} the browser was handed back: ${String(err)}`)
    }
  }
}

const send = (ctx: WorkCtx, state: BrowserState): BrowserState => {
  ctx.push({ push: 'work.browser', state })
  return state
}

/** The browser item of a pane, opened once and kept: a second open shows the same item. */
function openItem(ctx: ToolCtx, pane: string, title: string): void {
  const open = ctx.canvas.forSession(pane).find((i) => i.kind === 'browser' && i.source.at === 'browser' && i.source.sessionId === pane)
  if (!open) ctx.canvas.open(pane, 'browser', { at: 'browser', host: ctx.host, sessionId: pane }, title)
}

const host = (url: string): string => {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function tools(): WorkTool[] {
  return [
    {
      name: 'browser_open',
      description:
        "Show the browser beside the thread at full size before you drive a website with computer use, so the owner can watch it, take over and hand back. `url` is the page you are on or about to open, `name` the site as a person says it (\"Arbiter\", \"Concur\"), `title` the page's title. Call it again when you move to another site. A submit on a site's final screen waits for his press on its own: drive up to it and stop there.",
      input: z.object({ url: z.string().min(1).max(2000), name: z.string().min(1).max(80), title: z.string().min(1).max(200) }),
      readOnly: false,
      async run(args, ctx) {
        const { url, name, title } = args as { url: string; name: string; title: string }
        const pane = ctx.canvas.paneOf(ctx.sessionId)
        openItem(ctx, pane, title)
        const state = send(ctx, new DriveStore(ctx.db).open(pane, { url, name }, ctx.sessionId))
        return workText(state.driver === 'owner' ? OWNER_DRIVES : `The browser is open beside the thread on ${host(url)}.`)
      }
    },
    {
      name: 'browser_needs_you',
      description:
        'Say that a page needs the owner to act there himself: a sign in, a password, a second factor, a captcha, a payment. You never type a password. The browser asks him to take over; stop using computer use and end your turn. He hands back when he is done, and you are told.',
      input: z.object({ needs: z.string().min(1).max(120).describe('what the page needs of him, in a few words: "Arbiter wants you to sign in"') }),
      readOnly: false,
      async run(args, ctx) {
        const pane = ctx.canvas.paneOf(ctx.sessionId)
        send(ctx, new DriveStore(ctx.db).needs(pane, (args as { needs: string }).needs, ctx.sessionId))
        return workText('The browser asks him to take over. End your turn; you are told when he hands back.')
      }
    },
    {
      name: 'browser_sources',
      description:
        "Before the final submit, say where each value you put on the page came from (\"Your message\", \"Hilton folio.pdf, page 1\", \"412 miles at $0.447, from Maps\"), by the field's name as the page labels it. He sees each field as the app reads it off the page, beside your source. Name a field again to change its source.",
      input: z.object({ values: z.array(PortalSourceSchema).min(1).max(100) }),
      readOnly: false,
      async run(args, ctx) {
        const pane = ctx.canvas.paneOf(ctx.sessionId)
        const state = send(ctx, new DriveStore(ctx.db).sources(pane, (args as { values: z.infer<typeof PortalSourceSchema>[] }).values, ctx.sessionId))
        return workText(`Noted ${state.sources.length === 1 ? 'one source' : `${state.sources.length} sources`}.`)
      }
    },
    {
      name: 'teams_reply',
      description:
        'Reply in Microsoft Teams. Never post in Teams with computer use yourself. The reply is held: nothing is posted until the owner presses Post, and then the app posts it to the chat on this Mac and keeps a picture of the posted message. `chat` is the chat, channel or person as Teams lists it.',
      input: TeamsPostSchema,
      readOnly: false,
      async run(args, ctx) {
        if (!teamsCarrier()) return { ...workText(TEAMS_UNAVAILABLE), isError: true }
        const item = ctx.held.create({ kind: 'teams.post', sessionId: ctx.sessionId, payload: TeamsPostSchema.parse(args) })
        return workText(`Held: ${item.summary}. It waits for the owner's press; nothing is posted until then. This is a finished step, not a failure: carry on.`)
      }
    }
  ]
}

export const browser: WorkModule = {
  id: 'browser',
  ensure(db) {
    ensureBrowserTables(db)
  },
  async handle(req, ctx, by) {
    switch (req.method) {
      case 'work.browser.state':
        return handled(new DriveStore(ctx.db).get(req.params.sessionId))
      case 'work.browser.drive': {
        // The agent never hands itself the wheel, and never takes it from him.
        if (by.kind === 'model') throw new Error(NOT_A_PERSON)
        const { sessionId, driver } = req.params
        if (!ctx.scopeOf(sessionId)) throw new Error(NOT_WORK)
        const store = new DriveStore(ctx.db)
        const was = store.get(sessionId)
        const state = send(ctx, store.drive(sessionId, driver))
        if (was.driver === 'owner' && state.driver === 'agent') await wake(ctx, store.actor(sessionId), sessionId)
        return handled(state)
      }
      default:
        return NOT_HANDLED
    }
  },
  tools: () => tools(),
  acts: [teamsPostKind as unknown as ActKindDef],
  sessionsRemoved(ids, ctx) {
    new DriveStore(ctx.db).remove(ids)
  }
}
