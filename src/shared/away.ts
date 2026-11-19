import { z } from 'zod'

// Away from computer (src/main/server/away.ts): the person's own state, one
// copy per host, mirrored both ways over the peer links (remote/awaySync.ts),
// newest wins. While it is on, threads decide without asking.

export const AwayStateSchema = z.object({
  enabled: z.boolean(),
  /** When it last flipped (epoch ms); 0 for a host that never flipped. */
  at: z.number(),
  /** The environment id of the host where it flipped. */
  by: z.string()
})
export type AwayState = z.infer<typeof AwayStateSchema>

/** This host's tally of the stretch: how many decisions each thread made while away. */
export const AwayDecidedSchema = z.object({
  since: z.number(),
  threads: z.array(z.object({ sessionId: z.string(), count: z.number().int().min(0) }))
})
export type AwayDecided = z.infer<typeof AwayDecidedSchema>

export const AWAY_OFF_STATE: AwayState = { enabled: false, at: 0, by: '' }

/** A state from elsewhere wins only when it is newer; equal times keep what is here. */
export const isNewerAway = (incoming: AwayState, current: AwayState): boolean => incoming.at > current.at

/** note_decision (apptools.ts, the codex bridge's copy in scripts/app-mcp-bridge.mjs): one decision the thread made without the person. */
export const NOTE_DECISION_TOOL_NAME = 'note_decision'
export const NOTE_DECISION_DESCRIPTION =
  "Record one decision you made without asking the person, while they are away from the computer: what you chose and why, in one line. It shows as a quiet row in the thread and counts toward what the person reviews when they come back. One call per decision, once."
export const NOTE_DECISION_PARAMS = {
  decision: 'One line: what you chose and why.'
} as const
export const NOTE_DECISION_MAX_CHARS = 500

/** How many decisions a tally holds. */
export const decidedTotal = (decided: AwayDecided): number =>
  decided.threads.reduce((sum, t) => sum + t.count, 0)

/** Flagged computer acts Away still denies: they spend money. Everything else that would ask the person is allowed while away, in a code thread. */
export const AWAY_DENIED_KINDS = ['pay', 'subscribe'] as const

/** Tool cards Away never answers for a Work thread: each changes which servers a thread can reach, which only the owner decides. */
export const AWAY_WORK_DENIED_TOOLS = ['addon_add', 'addon_remove'] as const

/** What Away does with something that would ask the person: allow it, deny it, or hold it for the owner's press. */
export type AwayVerdict = 'allow' | 'deny' | 'hold'

/**
 * What is being asked while the person is away.
 *  - `computer`: a computer call's card. `kind` is the model's own flag
 *    (`args.confirm?.kind`), never a card's input. `outward`: the host's own
 *    reading of the screen says the act sends, posts, pays or the like
 *    (src/shared/computer/outward.ts). `password`: the host's own rule, text
 *    going into a password field.
 *  - `tool`: any other card, by the tool that raised it (`addon_add`, bare
 *    or as `mcp__app__addon_add`; `Bash`; an add-on's tool).
 */
export type AwayAsk =
  | { what: 'computer'; kind?: string | null; outward?: boolean; password?: boolean }
  | { what: 'tool'; tool: string }

const bare = (tool: string): string => tool.replace(/^mcp__app__/, '')

/**
 * Away's answer, by the scope of the thread that asks (`sessions.scope`).
 *
 * A code thread, as before Work: every card is allowed but a computer act
 * the model flagged `pay` or `subscribe`.
 *
 * A Work thread decides and carries on, and nothing it does leaves: a
 * computer act the host reads as outward, or the model flagged at all, is
 * held for the owner's press; text into a password field is denied; adding
 * or removing an add-on is denied; every other card (a file edit, a shell
 * command, an add-on's tool, which the hold's catch judges for itself) is
 * allowed. Away never releases a held act and never makes a grant: neither
 * is a card, so neither is asked here.
 */
export function awayVerdict(ask: AwayAsk, scope: 'code' | 'work' | null | undefined): AwayVerdict {
  if (scope !== 'work') return ask.what === 'computer' && (AWAY_DENIED_KINDS as readonly string[]).includes(ask.kind ?? '') ? 'deny' : 'allow'
  if (ask.what === 'tool') return (AWAY_WORK_DENIED_TOOLS as readonly string[]).includes(bare(ask.tool)) ? 'deny' : 'allow'
  if (ask.outward || ask.kind) return 'hold'
  if (ask.password) return 'deny'
  return 'allow'
}
