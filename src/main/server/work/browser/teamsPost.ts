import { readFile } from 'node:fs/promises'
import { cutFields, heldTargets, isCutValue, screenMark, screenOfObservation, withValues, type Screen, type ScreenElement } from '@shared/computer/outward'
import type { ComputerAction } from '@shared/computer/protocol'
import type { ComputerToolOutcome } from '../../computer/result'
import type { ComputerToolContext } from '../../computer/run'
import { ActNotSent, ActStale } from '../outbox/kinds'
import { configureTeamsCarrier, type TeamsCarrier, type TeamsPost } from './teams'

/**
 * The Teams carrier (docs/agents/work-browser.md "Teams"): a held reply,
 * posted by computer use on the reply's thread's computer session once the
 * owner pressed Post. Every step that acts is a `pressed` call: it runs as
 * read, with no card and no second hold, and only if the window still holds
 * what the step was read against (computer/run.ts restages it).
 *
 * The steps: bring Teams forward; read it; click the one chat whose name is
 * exactly the reply's (none, or more than one, and nothing is posted); read
 * again; the chat open is that one, by its header or the window's title; the
 * one message box, empty; type the reply into it (a line break as
 * Shift-Return) and Return; read with a picture. Anything before the Return
 * that does not hold throws `ActStale`: nothing went.
 */

/** What the carrier needs of the host's computer sessions (computer/sessions.ts). */
export interface TeamsComputer {
  run(ctx: ComputerToolContext, tool: string, args: unknown): Promise<ComputerToolOutcome>
  rowOf(threadId: string): { apps: Array<{ name: string; bundleId: string | null }> } | null
}

export const TEAMS_APP = 'Microsoft Teams'
type Pressed = NonNullable<ComputerToolContext['pressed']>

/** Roles a chat is listed with; a text field, the window, the list itself or the open chat's header never is. */
const NOT_A_CHAT = new Set(['window', 'web area', 'list', 'table', 'outline', 'scroll area', 'group', 'heading', 'input', 'text area', 'combo box', 'search', 'password', 'date'])
const BOX_ROLES = new Set(['input', 'text area'])
/** A reply of more lines than this is more Shift-Returns than one call carries. */
const MAX_LINES = 9

const nothing = (why: string): ActStale => new ActStale(`${why} Nothing was posted.`)

/** The elements named exactly `name`, the outermost of each nest (a row and the text inside it are one chat). */
export function chatsNamed(screen: Screen, name: string): ScreenElement[] {
  const hits = [...screen.elements.values()].filter((e) => e.name === name && !NOT_A_CHAT.has(e.role))
  const indices = new Set(hits.map((e) => e.index))
  const inside = (e: ScreenElement): boolean => {
    for (let p = e.parent; p !== null; p = screen.elements.get(p)?.parent ?? null) if (indices.has(p)) return true
    return false
  }
  return hits.filter((e) => !inside(e))
}

/** Whether the chat Teams shows open is `name`: a heading of exactly that name (the chat's header), or the window's title naming it between its bars ("Chat | Esports staff | Microsoft Teams"). */
export function chatOpen(screen: Screen, name: string): boolean {
  return [...screen.elements.values()].some((e) => (e.role === 'heading' && e.name === name) || (e.role === 'window' && (e.name ?? '').split(' | ').some((part) => part.trim() === name)))
}

/** The one box a message is typed into: the only text field, else the only one named for a message. */
export function messageBox(screen: Screen): ScreenElement | null {
  const fields = [...screen.elements.values()].filter((e) => BOX_ROLES.has(e.role))
  if (fields.length === 1) return fields[0]!
  const named = fields.filter((e) => /message|reply/i.test(e.name ?? ''))
  return named.length === 1 ? named[0]! : null
}

/** The reply as steps into the box: its lines with Shift-Return between them, then Return. */
export function typingSteps(text: string, box: number): ComputerAction[] {
  const lines = text.split(/\r?\n/)
  const steps: ComputerAction[] = []
  lines.forEach((line, i) => {
    if (line) steps.push({ action: 'type', element: box, text: line } as ComputerAction)
    if (i < lines.length - 1) steps.push({ action: 'key', element: box, text: 'shift+Return' } as ComputerAction)
  })
  steps.push({ action: 'key', element: box, text: 'Return' } as ComputerAction)
  return steps
}

export function teamsCarrierOn(computer: TeamsComputer, app = TEAMS_APP): TeamsCarrier {
  return {
    async post(p: TeamsPost, { sessionId }) {
      if (!sessionId) throw nothing('The reply has no thread to post from.')
      if (p.text.split(/\r?\n/).length > MAX_LINES) throw nothing(`Teams takes a reply of at most ${MAX_LINES} lines from here.`)
      const threadId = sessionId
      // A read or a launch restages nothing; a step that acts carries the window it was read against.
      const run = (tool: string, args: unknown, pressed: Pressed = { mark: '', targets: [] }): Promise<ComputerToolOutcome> => computer.run({ threadId, pressed }, tool, args)
      const identity = (): Screen['app'] => {
        const known = computer.rowOf(threadId)?.apps.find((a) => a.name === app)
        return { bundleId: known?.bundleId ?? null, name: known?.name ?? app }
      }
      const read = async (): Promise<Screen> => {
        const o = await run('computer_observe', { app, full: true })
        const screen = o.isError ? null : screenOfObservation(o.body ?? '', identity())
        if (!screen) throw nothing(`Teams could not be read${o.body ? `: ${o.body}` : '.'}`)
        return screen
      }
      /** The window with each field its read printed cut read again whole, as the press reads it (computer/run.ts `wholeFields`): a long message in the chat binds whole. */
      const whole = async (screen: Screen): Promise<Screen> => {
        const values = new Map<number, string>()
        for (const element of cutFields(screen)) {
          const o = await run('computer_observe', { app, element })
          const value = o.isError ? undefined : screenOfObservation(o.body ?? '', identity())?.elements.get(element)?.value
          if (value === undefined || isCutValue(value)) throw nothing('A field in Teams could not be read whole.')
          values.set(element, value)
        }
        return values.size ? withValues(screen, values) : screen
      }
      const act = async (screen: Screen, steps: ComputerAction[]): Promise<ComputerToolOutcome> => {
        const targets = heldTargets(steps, screen)
        if (!targets) throw nothing('A step names nothing Teams shows.')
        const pressed = { mark: screenMark(await whole(screen)), targets }
        return steps.length === 1 ? run('computer_act', { app, ...steps[0] }, pressed) : run('computer_batch', { app, actions: steps }, pressed)
      }

      const opened = await run('computer_apps', { launch: app })
      if (opened.isError) throw nothing(`Teams did not open${opened.body ? `: ${opened.body}` : '.'}`)

      // The chat: exactly one by its exact name.
      let screen = await read()
      const chats = chatsNamed(screen, p.chat)
      if (chats.length !== 1) throw nothing(chats.length ? `Teams lists more than one chat named “${p.chat}”.` : `Teams lists no chat named “${p.chat}”.`)
      const opening = await act(screen, [{ action: 'left_click', element: chats[0]!.index } as ComputerAction])
      if (opening.isError) throw nothing(`The chat “${p.chat}” did not open${opening.body ? `: ${opening.body}` : '.'}`)

      // The box: the one there is, in the chat he was shown, holding no draft of his. A click that landed while Teams
      // still shows another chat would put the reply in that chat's box.
      screen = await read()
      if (!chatOpen(screen, p.chat)) throw new ActNotSent(`Teams does not show the chat “${p.chat}” open. Nothing was posted.`)
      const box = messageBox(screen)
      if (!box) throw nothing(`Teams shows no single message box in “${p.chat}”.`)
      if (box.value?.trim()) throw nothing('The message box already holds a draft.')

      const sent = await act(screen, typingSteps(p.text, box.index))
      if ((sent as { stale?: true }).stale) throw nothing('Teams changed before the reply went.')
      if (sent.isError) throw new Error(`Teams did not take the reply${sent.body ? `: ${sent.body}` : ''}`)

      // One picture of the window as it is now, with the reply posted.
      const after = await run('computer_observe', { app, full: true, screenshot: true })
      const left = after.isError ? null : screenOfObservation(after.body ?? '', identity())
      const still = left ? messageBox(left) : null
      if (still?.value?.trim() === p.text.split(/\r?\n/).at(-1)?.trim() && still?.value?.trim()) throw new Error('Teams did not send the reply: it still sits in the message box.')
      const shot = after.shots.at(-1)
      if (!shot) return { picture: null }
      try {
        return { picture: { data: await readFile(shot.path), mimeType: shot.mimeType, width: shot.width, height: shot.height } }
      } catch {
        return { picture: null }
      }
    }
  }
}

/** Set once at boot by index.ts beside the host's computer sessions: a host without computer use sets none, and `teams_reply` refuses there. */
export function wireTeamsCarrier(computer: TeamsComputer): void {
  configureTeamsCarrier(teamsCarrierOn(computer))
}
