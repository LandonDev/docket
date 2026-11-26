import {
  composeToolTitle,
  isEditTool,
  isExecuteTool,
  isReadTool,
  isSearchTool,
  isWeakToolTitle,
} from "../lib/harness/preview";
import { displayPath } from "../lib/paths";
import type { Block } from "../lib/session";
import type { LiveEditState } from "../lib/tcserver/store";
import type { TitleOf } from "../lib/threadMentions";
import { groupPhrase } from "../lib/groupPhrase";
import { kindOf, shortName, toolPhrase } from "../lib/toolPhrase";
import { editModel, isEditBlock } from "./editModel";
import { splitEditCards } from "./editCards";
import { htmlRenderOf } from "./htmlRenderBlock";
import { isComputerShotBlock } from "./computerShots";
import { isMailOfferBlock } from "./mailOfferBlock";
import { isOutboxRequestBlock } from "./outboxRequestBlock";
import { passActionsOf } from "../lib/turnClock";
import { AGENT_TOOLS } from "./appTool";
import { isOpenWait, isWaitCall, waitOutcomes } from "./agentSteps";

export type ToolCallState = "pending" | "accepted" | "rejected";

export type TurnItem =
  { type: "block"; block: Block } | { type: "activity"; blocks: Block[] };

export function needsApproval(block: Block): boolean {
  return !!block.approval && !block.approval.decided;
}

/** A question card still waiting on the user (the turn has not moved on). */
export function needsAnswer(block: Block): boolean {
  return (
    !!block.question &&
    block.question.answers === undefined &&
    block.tool?.status === "running"
  );
}

/** Anything the turn cannot continue without: an approval or an answer. */
export function awaitsUser(block: Block): boolean {
  return needsApproval(block) || needsAnswer(block);
}

export function toolCallState(block: Block): ToolCallState {
  const status = block.tool?.status?.toLowerCase() ?? "";
  const decided = block.approval?.decided;

  if (decided === "deny") return "rejected";
  if (
    status === "failed" ||
    status === "error" ||
    status === "cancelled" ||
    status === "canceled"
  ) {
    return "rejected";
  }
  if (needsApproval(block)) return "pending";
  if (status === "completed" || status === "success") return "accepted";
  if (
    block.streaming ||
    status === "in_progress" ||
    status === "pending" ||
    status === "running"
  ) {
    return "pending";
  }
  if (decided === "allow" || !status) return "accepted";
  return "pending";
}

export function toolCallLabel(block: Block, cwd?: string): string {
  const phrase = toolPhrase(block, cwd);
  if (phrase) return phrase;
  const preview = block.tool?.preview;
  const path = preview?.path
    ? displayPath(preview.path, cwd)
    : preview?.fileName;
  return (
    composeToolTitle({
      kind: block.tool?.kind,
      title: block.text || block.tool?.title,
      path,
      query: preview?.query,
      previewKind: preview?.kind,
      cwd,
    }) || "Working"
  );
}

export function isIncompleteTool(
  block: Block,
  label: string,
  state: ToolCallState,
): boolean {
  if (state !== "pending") return false;
  const kind = block.tool?.kind?.toLowerCase();
  if (kind && kind !== "other") return false;
  if (
    block.tool?.preview?.path ||
    block.tool?.preview?.query ||
    block.tool?.preview?.lines?.length
  ) {
    return false;
  }
  return !label || isWeakToolTitle(label);
}

export function isHiddenTool(block: Block): boolean {
  if (block.role !== "tool" && block.role !== "approval") return false;
  // A wait is a state of the turn: never a row while open, and only its
  // settled agents once it returns (agentSteps.ts).
  if (isWaitCall(block)) return isOpenWait(block) || waitOutcomes(block).length === 0;
  if (
    isEditTool(
      block.tool?.kind,
      block.text || block.tool?.title,
      block.tool?.preview,
    )
  ) {
    return false;
  }
  const state = toolCallState(block);
  return isIncompleteTool(block, toolCallLabel(block), state);
}

/**
 * A step that folds into a run of actions: a call, or a thought. An edit
 * still awaiting approval stays out: you cannot judge a diff you cannot see.
 */
export function isActivityBlock(block: Block): boolean {
  if (isThinkingBlock(block)) return true;
  if (isFoldedStep(block)) return true;
  if (block.role !== "tool" && block.role !== "approval") return false;
  if (standsAlone(block)) return false;
  if (
    isEditTool(
      block.tool?.kind,
      block.text || block.tool?.title,
      block.tool?.preview,
    ) &&
    needsApproval(block)
  ) {
    return false;
  }
  return !isHiddenTool(block);
}

/**
 * A row the host wrote that is a step of the agent's work, so it folds into
 * the run it sits in: a subagent spawned or settled, a background task
 * that finished or the check on idle ones, a gate or release outcome, a
 * review that merged, the turn pass, the plan's build hand-off, a merge the
 * batch made, a decision made (or a question answered, an approval skipped)
 * while the person was away. What asks the person something or ends a stretch of work
 * (a held review, a failure, Stopped, compaction, Batch done, an account
 * gone, a plain host line) stays a row of its own.
 */
export function isFoldedStep(block: Block): boolean {
  if (block.role !== "system") return false;
  if (block.agent || block.task || block.backgroundCheck || block.gate || block.planHandoff) return true;
  if (block.review) return block.review.outcome !== "held";
  if (passActionsOf(block)) return true;
  if (block.notice?.kind === "away") return true;
  return block.notice?.kind === "batch" && block.text.startsWith("Merged by the batch");
}

/** A step of the run: a tool call or a folded host step (thoughts are not counted). */
export function isStepBlock(block: Block): boolean {
  return isToolBlock(block) || isFoldedStep(block);
}

const FAILED_REPORT = new Set(["error", "failed", "blocked"]);

/** The rows a step draws: one per agent a wait returned on, one per child a batch spawn stamped, else one. */
export function stepRows(block: Block): number {
  if (isWaitCall(block)) return waitOutcomes(block).length;
  const spawned = block.tool?.spawned?.length ?? 0;
  return isBatchSpawn(block) && spawned > 1 ? spawned : 1;
}

/** A spawn_agent call that asked for several agents. */
export function isBatchSpawn(block: Block): boolean {
  const name = shortName(block.tool?.name ?? "");
  const agents = (block.tool?.input as { agents?: unknown } | undefined)?.agents;
  return name === "spawn_agent" && Array.isArray(agents) && agents.length > 1;
}

/** How many of a step's parts went wrong: a red gate, a review that failed
 *  to run, a report of a failure, a failed task, each agent a wait found failed. */
function stepFailures(block: Block): number {
  if (isWaitCall(block)) return waitOutcomes(block).filter((o) => FAILED_REPORT.has(o.status)).length;
  return stepFailed(block) ? 1 : 0;
}

/** A folded host step that went wrong: a red gate, a review that failed to run, a report of a failure, a failed task. */
function stepFailed(block: Block): boolean {
  if (block.gate) return !block.gate.ok;
  if (block.review) return block.review.outcome === "failed";
  if (block.task) return block.task.status === "failed";
  if (block.agent?.status) return FAILED_REPORT.has(block.agent.status);
  return false;
}

/** Reasoning the agent streams while it works: a step in the run it sits in. */
export function isThinkingBlock(block: Block): boolean {
  return block.role === "reasoning" && !!block.text.trim();
}

export function isToolBlock(block: Block): boolean {
  return block.role === "tool" || block.role === "approval";
}

/** Assistant prose with something in it — the paragraphs between tool calls. */
export function isProseBlock(block: Block): boolean {
  return block.role === "assistant" && !!block.text.trim();
}

/**
 * A block that hands the turn to the user: a question, answered or not, and
 * an approval still undecided. It renders full size where it sits, never
 * as a step inside a folded group, so what it asks stays readable.
 */
export function endsWork(block: Block): boolean {
  return block.question != null || needsApproval(block);
}

/** First paragraph of a folded prose block, stripped to one plain line. */
export function proseSummary(text: string): string {
  const body = text.replace(/```[\s\S]*?(?:```|$)/g, " ");
  const paragraph =
    body
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  return paragraph
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Canonical verb for a write-preview row, so edits read as "Edit src/app.ts"
 * alongside "Read" and "Find". Harnesses phrase these in past tense, hence the
 * doubled-up forms.
 */
export function editVerb(label: string): string {
  const word = label.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (/^(delete|deleted|remove|removed)$/.test(word)) return "Delete";
  if (/^(move|moved|rename|renamed)$/.test(word)) return "Move";
  if (/^(create|created|add|added|new)$/.test(word)) return "Create";
  if (/^(write|wrote|writing)$/.test(word)) return "Write";
  return "Edit";
}

/** User turns, with handoff dividers sitting on their own row. */
export function groupTurns(blocks: Block[]): Block[][] {
  const turns: Block[][] = [];
  splitTurns(blocks, 0, [], turns);
  return turns;
}

/** groupTurns from `from` on, with `current` the open turn's blocks so far. */
function splitTurns(blocks: Block[], from: number, current: Block[], turns: Block[][]): void {
  for (let i = from; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.role === "handoff") {
      if (current.length > 0) turns.push(current);
      turns.push([block]);
      current = [];
      continue;
    }
    if (block.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) turns.push(current);
}

/**
 * Re-uses the previous array for every turn whose blocks are the same
 * objects, so folding a delta into the live turn leaves the rest untouched
 * and their memoised views hold.
 */
export function stableTurns(next: Block[][], previous: Block[][]): Block[][] {
  let changed = next.length !== previous.length;
  const out = next.map((turn, i) => {
    const old = previous[i];
    if (old && old.length === turn.length && old.every((block, j) => block === turn[j])) return old;
    changed = true;
    return turn;
  });
  return changed ? out : previous;
}

/** Where each turn of a turns array starts in the blocks, built on first use. */
const turnStarts = new WeakMap<Block[][], number[]>();

function startsOf(turns: Block[][]): number[] {
  let starts = turnStarts.get(turns);
  if (!starts) {
    starts = [];
    let at = 0;
    for (const turn of turns) {
      starts.push(at);
      at += turn.length;
    }
    turnStarts.set(turns, starts);
  }
  return starts;
}

/** A turn array that differs from `grouping`'s turn from `from` on (its
 *  blocks before `from` are the same objects): its items regroup from there. */
const origins = new WeakMap<Block[], { grouping: Grouping; from: number }>();

/**
 * `stableTurns(groupTurns(blocks), previous)`, from the tail: `previous` are
 * the turns of `before`, and only the turns from the first block that
 * differs on are split again. A delta into a long live turn copies that
 * turn's array but reads no block before the change, and the turn's items
 * then regroup from the change (`turnItems`).
 */
export function extendTurns(before: Block[], previous: Block[][], blocks: Block[]): Block[][] {
  const n = Math.min(before.length, blocks.length);
  let f = 0;
  while (f < n && before[f] === blocks[f]) f++;
  if (f === blocks.length && f === before.length) return previous;
  if (f === 0 || previous.length === 0) return stableTurns(groupTurns(blocks), previous);
  // The turn that holds the last block both share: the turns before it stand.
  const starts = startsOf(previous);
  let t = starts.length - 1;
  while (t > 0 && starts[t] > f - 1) t--;
  const turns = previous.slice(0, t);
  const open = previous[t];
  const shared = f - starts[t];
  const handoff = open.length === 1 && open[0].role === "handoff";
  if (handoff) turns.push(open);
  splitTurns(blocks, f, handoff ? [] : open.slice(0, shared), turns);
  let changed = turns.length !== previous.length;
  for (let i = t; i < turns.length; i++) {
    const turn = turns[i];
    const old = previous[i];
    // The turn that took the change shares its first `shared` blocks with `old`.
    const from = i === t ? shared : 0;
    let same = !!old && old.length === turn.length;
    for (let j = from; same && j < turn.length; j++) same = turn[j] === old[j];
    if (same) {
      turns[i] = old;
      continue;
    }
    changed = true;
    if (i === t && !handoff && from > 0) {
      const grouping = groupings.get(old);
      if (grouping) origins.set(turn, { grouping, from });
    }
  }
  return changed ? turns : previous;
}

/** A turn's items, and the index in the turn of each item's first block. */
type Grouping = { items: TurnItem[]; starts: number[]; user: number };

const groupings = new WeakMap<Block[], Grouping>();

/**
 * `groupTurnItems` kept by turn array: a settled turn keeps its array
 * (`stableTurns`), and a live turn that `extendTurns` made from the last one
 * regroups from its change, keeping every item before it.
 */
export function turnItems(turn: Block[]): TurnItem[] {
  return groupingOf(turn).items;
}

/** The turn's last message of the person's (a steered turn has several). */
export function turnUser(turn: Block[]): Block | undefined {
  const at = groupingOf(turn).user;
  return at < 0 ? undefined : turn[at];
}

function groupingOf(turn: Block[]): Grouping {
  const hit = groupings.get(turn);
  if (hit) return hit;
  const origin = origins.get(turn);
  origins.delete(turn);
  const grouping = origin ? regroup(turn, origin.grouping, origin.from) : groupFrom(turn, 0, [], [], -1);
  groupings.set(turn, grouping);
  return grouping;
}

/** The grouping of `turn` from the one of a turn equal to it before `from`. */
function regroup(turn: Block[], prev: Grouping, from: number): Grouping {
  // A thought followed only by empty paragraphs up to the change reads the
  // change to know whether it repeats the next paragraph: start there.
  let at = from;
  let j = from - 1;
  while (j >= 0 && (groupKindOf(turn[j]) & EMPTY_PROSE) !== 0) j--;
  if (j >= 0 && (groupKindOf(turn[j]) & THOUGHT) !== 0) at = j;
  // The last item that starts before it: a run may go on past it, so it
  // regroups whole; a block item is complete.
  let k = prev.starts.length - 1;
  while (k >= 0 && prev.starts[k] >= at) k--;
  let keep = k + 1;
  if (k >= 0 && prev.items[k].type === "activity") {
    keep = k;
    at = prev.starts[k];
  }
  // The person's last message: what the shared blocks held is known, unless it was the change.
  const user = prev.user < from ? prev.user : UNKNOWN;
  return groupFrom(turn, at, prev.items.slice(0, keep), prev.starts.slice(0, keep), user, from);
}

function groupFrom(blocks: Block[], from: number, items: TurnItem[], starts: number[], user: number, userFrom = 0): Grouping {
  let activity: Block[] = [];
  let activityStart = -1;
  const flush = () => {
    if (activity.length > 0) {
      items.push({ type: "activity", blocks: activity });
      starts.push(activityStart);
    }
    activity = [];
  };
  for (let i = from; i < blocks.length; i++) {
    const block = blocks[i];
    const kind = groupKindOf(block);
    if (kind & SKIP) continue;
    if (kind & THOUGHT && repeatsNextProse(blocks, i)) continue;
    if (kind & FOLDS) {
      if (activity.length === 0) activityStart = i;
      activity.push(block);
      continue;
    }
    flush();
    items.push({ type: "block", block });
    starts.push(i);
  }
  flush();
  for (let i = blocks.length - 1; i >= userFrom; i--) {
    if (blocks[i].role === "user") {
      user = i;
      break;
    }
  }
  if (user === UNKNOWN) {
    user = -1;
    for (let i = userFrom - 1; i >= 0; i--) {
      if (blocks[i].role === "user") {
        user = i;
        break;
      }
    }
  }
  return { items, starts, user };
}

const UNKNOWN = -2;

/** What a block is to its turn's items, by itself alone. */
const SKIP = 1;
const FOLDS = 2;
const THOUGHT = 4;
const EMPTY_PROSE = 8;
const kinds = new WeakMap<Block, number>();

function groupKindOf(block: Block): number {
  let kind = kinds.get(block);
  if (kind === undefined) {
    const shown = !isIgnoredTurnBlock(block) && (isTodoBlock(block) || standsAlone(block) || !isHiddenTool(block));
    kind =
      (shown ? 0 : SKIP) |
      (shown && !standsAlone(block) && !endsWork(block) && isActivityBlock(block) ? FOLDS : 0) |
      (block.role === "reasoning" ? THOUGHT : 0) |
      (block.role === "assistant" && !block.text.trim() ? EMPTY_PROSE : 0);
    kinds.set(block, kind);
  }
  return kind;
}

/**
 * A turn's items: every paragraph stands full size where it streamed, and
 * everything between two paragraphs (calls, settled edits, thinking, todo
 * updates, the host's steps of isFoldedStep) folds into one run. A
 * question, an undecided approval or an html_render page breaks the run
 * and stands alone.
 */
export function groupTurnItems(blocks: Block[]): TurnItem[] {
  return groupFrom(blocks, 0, [], [], -1).items;
}

/** A todo update (TodoWrite, update_plan): a step whose body is the list. */
export function isTodoBlock(block: Block): boolean {
  return block.role === "tool" && kindOf(block) === "todo";
}

/**
 * A published HTML page stands as its own row where the call completed. A
 * running html_render still folds into the activity group, so the frame
 * mounts once, when its result lands, and nothing above it moves.
 */
export function isHtmlRenderBlock(block: Block): boolean {
  return htmlRenderOf(block) !== null;
}

/**
 * A completed call whose result is something to look at stands as its own
 * row where it settled, breaking the run: a published page, a computer
 * call with a picture the model asked for (computerShots.ts), a mail
 * chat's card (mailOfferBlock.ts), or a thread's request for his press
 * (outboxRequestBlock.ts: the card takes the call's place, never a "Used" line over it). Running, it folds into its group like any
 * call and the working line tells it.
 */
export function standsAlone(block: Block): boolean {
  return isHtmlRenderBlock(block) || isComputerShotBlock(block) || isMailOfferBlock(block) || isOutboxRequestBlock(block);
}

/** Empty reasoning and empty prose (a stream's placeholder) take no row. */
function isIgnoredTurnBlock(block: Block): boolean {
  if (block.role === "reasoning") return !block.text.trim();
  return block.role === "assistant" && !block.text.trim();
}

/**
 * A thought the harness then says again as the next paragraph, word for
 * word. The paragraph shows it in full, so the dimmed step would only
 * repeat it.
 */
function repeatsNextProse(blocks: Block[], index: number): boolean {
  const block = blocks[index];
  if (block.role !== "reasoning") return false;
  let next: Block | undefined;
  for (let i = index + 1; i < blocks.length && !next; i++) {
    const b = blocks[i];
    if (b.role !== "assistant" || b.text.trim()) next = b;
  }
  return (
    next?.role === "assistant" && plainText(next.text) === plainText(block.text)
  );
}

function plainText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Markdown the user actually reads: assistant prose plus any plan, not tool chrome. */
export function turnCopyText(blocks: Block[]): string {
  return blocks
    .filter((block) => block.role === "assistant" || block.role === "plan")
    .map((block) => block.text.replace(/\r\n?/g, "\n").trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * What a run of tool calls was for. Reads and searches are one thing — looking
 * around — so a grep followed by the file it turned up stays one group.
 */
export type ActivityWorkKind = "research" | "edit" | "run" | "agents" | "other";

/** Ties break towards the kind that changed the most: an edit outranks a read. */
const WORK_KIND_ORDER: ActivityWorkKind[] = [
  "edit",
  "run",
  "research",
  "agents",
  "other",
];

/** Calls that start, steer or hear from other threads (in-harness subagents too). */
const THREAD_CALLS = new Set([...AGENT_TOOLS, "app_start_thread", "list_agents", "Agent", "Task"]);

export function toolCategory(block: Block): ActivityWorkKind {
  if (block.role === "system") return block.agent ? "agents" : "other";
  if (THREAD_CALLS.has(shortName(block.tool?.name ?? ""))) return "agents";
  const kind = block.tool?.kind;
  const title = block.text || block.tool?.title;
  const preview = block.tool?.preview;
  if (isEditTool(kind, title, preview)) return "edit";
  if (isSearchTool(kind, title, preview)) return "research";
  if (isReadTool(kind, title, preview)) return "research";
  if (isExecuteTool(kind, title)) return "run";
  return "other";
}

function dominantWorkKind(steps: Block[]): ActivityWorkKind | undefined {
  const counts = new Map<ActivityWorkKind, number>();
  for (const block of steps) {
    if (!isStepBlock(block)) continue;
    const kind = toolCategory(block);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  let best: ActivityWorkKind | undefined;
  for (const kind of WORK_KIND_ORDER) {
    const count = counts.get(kind) ?? 0;
    if (count > 0 && (!best || count > (counts.get(best) ?? 0))) best = kind;
  }
  return best;
}

/** The glyph a run leads with: its dominant kind of work, or think. */
export type ActionGroupKind = ActivityWorkKind | "think";

/** What a run of actions adds up to, for its one line. */
export type ActionGroup = {
  kind: ActionGroupKind;
  phrase: string;
  /** Lines added and removed over every edit in the run. */
  adds: number;
  dels: number;
  /** Steps that failed or were denied: calls, red gates, failed reports and tasks. */
  failed: number;
  /**
   * At most one step (with any thoughts around it): no line and no box, the
   * steps draw as their own rows in order. A line over one call, or over a
   * thought, would only say the row again.
   */
  lone: boolean;
};

/** A running edit's server-side record, by the same suffix match EditRow uses. */
export function liveEditFor(
  path: string,
  liveEdits: Record<string, LiveEditState> | undefined,
): LiveEditState | undefined {
  if (!path || !liveEdits) return undefined;
  return (
    liveEdits[path] ??
    Object.values(liveEdits).find((r) => path.endsWith("/" + r.path) || r.path.endsWith("/" + path))
  );
}

export function actionGroupOf(
  blocks: Block[],
  {
    cwd,
    live = false,
    liveEdits,
    titleOf,
    work = false,
  }: { cwd?: string; live?: boolean; liveEdits?: Record<string, LiveEditState>; titleOf?: TitleOf; work?: boolean } = {},
): ActionGroup {
  const tools = blocks.filter(isToolBlock);
  const steps = blocks.filter(isStepBlock);
  let adds = 0;
  let dels = 0;
  for (const block of tools) {
    if (!isEditBlock(block)) continue;
    const running = toolCallState(block) === "pending";
    for (const card of splitEditCards(block).cards) {
      const m = editModel(card);
      const rec = running ? liveEditFor(m.path, liveEdits) : undefined;
      adds += rec?.adds ?? m.adds;
      dels += rec?.dels ?? m.dels;
    }
  }
  const kind = dominantWorkKind(blocks) ?? "think";
  const phrase =
    kind === "think"
      ? live ? "Thinking" : "Thought"
      : groupPhrase(blocks, cwd, live, titleOf, work) || (live ? "Working" : "Worked");
  return {
    kind,
    phrase,
    // A Work thread's line carries no line totals: they wait in the edit rows, behind Show changes.
    adds: work ? 0 : adds,
    dels: work ? 0 : dels,
    failed:
      tools.filter((b) => toolCallState(b) === "rejected").length + steps.reduce((n, b) => n + stepFailures(b), 0),
    lone: steps.reduce((n, b) => n + stepRows(b), 0) <= 1,
  };
}

/**
 * A call the turn's working line tells while it runs (transcript/WorkingLine
 * .tsx): a tool call still pending that does not wait on the person and is
 * not agent work. While its turn is open it draws no row of its own; it lands
 * as a past-tense row in its group once it settles. A spawn, a message to an
 * agent or a check on one stays a row of the group with its state at its end,
 * and a call waiting on the person is its card.
 */
export function toldByWorkingLine(block: Block): boolean {
  return isToolBlock(block) && toolCallState(block) === "pending" && !awaitsUser(block) && toolCategory(block) !== "agents";
}
