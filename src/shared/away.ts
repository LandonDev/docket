import { z } from 'zod'

// Away from computer (src/main/server/away.ts): the person's own state, one
// copy per host, mirrored both ways over the peer links (remote/awaySync.ts),
// newest wins. Two switches, one per kind of thread: while a kind's is on,
// threads of that kind decide without asking. A thread's kind is its row's
// scope (`sessions.scope`, stamped once at create): Work, or else Code.

/** The kinds of thread Away is switched for, each by itself. */
export const AWAY_KINDS = ['code', 'work'] as const
export type AwayKind = (typeof AWAY_KINDS)[number]

export const AwayStateSchema = z.object({
  /**
   * Both kinds are away. Kept for a window, a phone or a peer one release
   * behind, which reads only this: an old reader believes he is away only
   * when no kind of thread still asks him.
   */
  enabled: z.boolean(),
  /** Away for Code threads; absent from an older host, which means `enabled`. */
  code: z.boolean().optional(),
  /** Away for Work threads; absent from an older host, which means `enabled`. */
  work: z.boolean().optional(),
  /** When Code's switch last flipped; absent from an older host, which means `at`. */
  codeAt: z.number().optional(),
  /** When Work's switch last flipped; absent from an older host, which means `at`. */
  workAt: z.number().optional(),
  /** When it last flipped (epoch ms); 0 for a host that never flipped. */
  at: z.number(),
  /** The environment id of the host where it flipped. */
  by: z.string()
})
export type AwayState = z.infer<typeof AwayStateSchema>

/** Each kind's switch. A state from an older host has `enabled` alone: it was away for both or for neither. */
export type AwayKinds = Record<AwayKind, boolean>

export const awayKindsOf = (state: AwayState): AwayKinds => ({
  code: state.code ?? state.enabled,
  work: state.work ?? state.enabled
})

/** When each kind last flipped. A state from an older host has `at` alone: both flipped then. */
export const awayStampsOf = (state: AwayState): Record<AwayKind, number> => ({
  code: state.codeAt ?? state.at,
  work: state.workAt ?? state.at
})

/** A state with both switches and their stamps written out, and `enabled` the old readers' "both". */
export const awayStateOf = (kinds: AwayKinds, at: number, by: string, stamps: Record<AwayKind, number> = { code: at, work: at }): AwayState => ({
  enabled: kinds.code && kinds.work,
  code: kinds.code,
  work: kinds.work,
  codeAt: stamps.code,
  workAt: stamps.work,
  at,
  by
})

/**
 * Two hosts' states as one, each kind by its own stamp, newest wins: a peer
 * that flipped Code later than this host flipped Work takes Code from the
 * peer and keeps Work here, so a flip of one kind never carries a stale value
 * of the other.
 */
export function mergeAway(current: AwayState, incoming: AwayState): AwayState {
  const mine = awayKindsOf(current)
  const theirs = awayKindsOf(incoming)
  const mineAt = awayStampsOf(current)
  const theirsAt = awayStampsOf(incoming)
  const kinds = { ...mine }
  const stamps = { ...mineAt }
  for (const kind of AWAY_KINDS) {
    if (theirsAt[kind] <= mineAt[kind]) continue
    kinds[kind] = theirs[kind]
    stamps[kind] = theirsAt[kind]
  }
  const newer = incoming.at > current.at
  return awayStateOf(kinds, Math.max(current.at, incoming.at), newer ? incoming.by : current.by, stamps)
}

/** The kind of a thread, from its row: a Work thread is stamped `scope: 'work'`; every other thread is Code. */
export const awayKindOf = (scope: string | null | undefined): AwayKind => (scope === 'work' ? 'work' : 'code')

/** Whether a thread of this scope is away under this state. */
export const isAwayFor = (state: AwayState, scope: string | null | undefined): boolean => awayKindsOf(state)[awayKindOf(scope)]

/** Whether any kind is away. */
export const anyAway = (state: AwayState): boolean => {
  const k = awayKindsOf(state)
  return k.code || k.work
}

/** The kinds whose switch differs between two states. */
export const awayKindsChanged = (from: AwayState, to: AwayState): AwayKind[] => {
  const a = awayKindsOf(from)
  const b = awayKindsOf(to)
  return AWAY_KINDS.filter((k) => a[k] !== b[k])
}

/** This host's tally of the stretch: how many decisions each thread made while away. */
export const AwayDecidedSchema = z.object({
  since: z.number(),
  threads: z.array(z.object({ sessionId: z.string(), count: z.number().int().min(0) }))
})
export type AwayDecided = z.infer<typeof AwayDecidedSchema>

export const AWAY_OFF_STATE: AwayState = { enabled: false, code: false, work: false, at: 0, by: '' }


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

/**
 * Who answers an approval in his place: Away, while the thread's kind is
 * away; Full access (`auto`), on a thread that has it; else nobody, and
 * the card asks him. Questions are not approvals: only Away answers those.
 */
export type AskDecider = 'away' | 'full' | null

export const askDeciderOf = (away: boolean, permission: string | null | undefined): AskDecider =>
  away ? 'away' : permission === 'auto' ? 'full' : null

/**
 * What becomes of an approval, from Away's verdict (`awayVerdict`) and who
 * decides. Full access allows exactly what Away allows; what Away denies
 * or holds still asks him under Full access, since he is there to answer.
 */
export function decideAsk(decider: AskDecider, verdict: AwayVerdict): 'allow' | 'deny' | 'ask' {
  if (decider === null) return 'ask'
  if (verdict === 'allow') return 'allow'
  return decider === 'away' ? 'deny' : 'ask'
}
