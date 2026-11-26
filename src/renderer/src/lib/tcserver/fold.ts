import { carryPendingApprovalIndex, type Attachment, type Block, type CompactionMeta, type QuestionMeta } from "../session";
import { BACKGROUND_CHECK_WORDS, COMPACTING_WORDS } from "@shared/statusWords";
import { mergeContextUsage, type ContextUsage } from "../contextUsage";
import {
  asRecord,
  previewFromTool,
  toolKindFromName,
  toolTitle,
} from "../harness/claudeProtocol";
import {
  approvalBlockAfter,
  isOpenTool,
  isUnsettledTool,
  normalizeLabel,
  toolBlockAfter,
  upsertToolBlock,
  type ApprovalAttach,
  type ToolPatch,
} from "../harness/toolBlock";
import type { EventRow, ServerAttachment } from "./types";
import { isOmittedBody } from "@server/shared/wire";
import { shortName } from "../toolPhrase";
import type { ToolPreview } from "../session";
import {
  applyTaskResult,
  applyTodoCall,
  beginTurn,
  emptyThread,
  markUsage,
  type ThreadState,
} from "./todos";

export type { ThreadState, TodoItem, TodoStatus, UsageMark, ResearchSource } from "./todos";

/** MCP tool names carry the server and tool name; their kind is never
 *  inferable from the words inside ("app_list_threads" is not a read). */
function toolKind(name: string): string {
  return name.startsWith("mcp__") ? "other" : toolKindFromName(name);
}

/**
 * The server's event log, folded into transcript blocks. Pure:
 * one row in, a new state out (unchanged rows return the same state, so
 * React sees no change). Live pushes and a replay of the stored log fold
 * to the same blocks because text is keyed by `msgId:blockIndex` and tools
 * by `callId` — an ephemeral streaming row and its persisted final land
 * on the same block.
 */
export type FoldState = {
  blocks: Block[];
  /** A turn is open: the harness is starting, running, or waiting on us. */
  busy: boolean;
  context?: ContextUsage;
  /** Highest persisted seq folded; ephemeral rows (seq -1) never move it. */
  lastSeq: number;
  /** Counter for blocks with no natural key. */
  nextId: number;
  /** Board state beside the transcript: todos, rounds, cost, sources. */
  thread: ThreadState;
};

export function emptyFold(): FoldState {
  return { blocks: [], busy: false, lastSeq: 0, nextId: 1, thread: emptyThread() };
}

/** Timestamp of the last stamped block — how a dead turn is recognized. */
function lastBlockTs(d: Draft): number | undefined {
  for (let i = d.length - 1; i >= 0; i--) {
    const ts = d.at(i).ts;
    if (ts !== undefined) return ts;
  }
  return undefined;
}

/**
 * The blocks one fold writes. A single push (`foldEvent`) copies the array
 * on its first write, as an immutable update must; a page (`foldPage`)
 * copies it once for all its rows and writes in place after that, with
 * indexes that answer "the block of call X" and "the open blocks" without
 * walking the thread. Every read of a block goes through `at`, so
 * `foldProbe.visits` counts the work a fold does by blocks touched.
 */
class Draft {
  arr: Block[];
  private owned = false;
  /** Writes since `beginRow`, and since the draft began. */
  rowWrites = 0;
  writes = 0;
  /** Page mode only: kept across rows, built on first use. */
  private index: {
    byCall: Map<string, number>;
    byId: Map<string, number>;
    pending: number;
    orphans: number;
    lastUser: number;
  } | null = null;
  /** Page mode only: no block below each mark is streaming / an unsettled
   *  call / an open section of the person's (`closeUserTurns`). */
  private marks = { stream: 0, open: 0, users: 0 };

  constructor(
    base: Block[],
    readonly page: boolean,
  ) {
    this.arr = base;
  }

  get length(): number {
    return this.arr.length;
  }

  at(i: number): Block {
    foldProbe.visits++;
    return this.arr[i];
  }

  beginRow(): void {
    this.rowWrites = 0;
  }

  /** The array has left in a state: the next write copies it first. */
  share(): void {
    this.owned = false;
  }

  private own(): Block[] {
    if (!this.owned) {
      foldProbe.visits += this.arr.length;
      this.arr = this.arr.slice();
      this.owned = true;
    }
    return this.arr;
  }

  set(i: number, block: Block): void {
    const arr = this.own();
    if (this.index) this.unindex(arr[i]);
    arr[i] = block;
    this.noted(block, i);
    this.rowWrites++;
    this.writes++;
  }

  push(block: Block): void {
    const arr = this.own();
    arr.push(block);
    this.noted(block, arr.length - 1);
    this.rowWrites++;
    this.writes++;
  }

  /** The whole array replaced (a removal): the indexes start again. */
  replace(next: Block[]): void {
    foldProbe.visits += next.length;
    this.arr = next;
    this.owned = true;
    this.index = null;
    this.marks = { stream: 0, open: 0, users: 0 };
    this.rowWrites++;
    this.writes++;
  }

  private unindex(old: Block | undefined): void {
    const ix = this.index!;
    if (old?.pending) ix.pending--;
    if (old && isOrphanApproval(old)) ix.orphans--;
  }

  private noted(block: Block, i: number): void {
    if (this.page) {
      if (block.streaming && i < this.marks.stream) this.marks.stream = i;
      if (i < this.marks.open && isUnsettledTool(block)) this.marks.open = i;
      if (i < this.marks.users && isOpenUser(block)) this.marks.users = i;
    }
    const ix = this.index;
    if (!ix) return;
    const callId = block.tool?.callId;
    if (callId && (ix.byCall.get(callId) ?? -1) < i) ix.byCall.set(callId, i);
    if ((ix.byId.get(block.id) ?? -1) < i) ix.byId.set(block.id, i);
    if (block.pending) ix.pending++;
    if (isOrphanApproval(block)) ix.orphans++;
    if (block.role === "user" && i > ix.lastUser) ix.lastUser = i;
  }

  private indexed() {
    if (!this.page) return null;
    if (!this.index) {
      const ix = { byCall: new Map<string, number>(), byId: new Map<string, number>(), pending: 0, orphans: 0, lastUser: -1 };
      this.index = ix;
      foldProbe.visits += this.arr.length;
      this.arr.forEach((b, i) => {
        if (b.tool?.callId) ix.byCall.set(b.tool.callId, i);
        ix.byId.set(b.id, i);
        if (b.pending) ix.pending++;
        if (isOrphanApproval(b)) ix.orphans++;
        if (b.role === "user") ix.lastUser = i;
      });
    }
    return this.index;
  }

  private lastWhere(pred: (b: Block) => boolean, from = this.arr.length - 1, to = 0): number {
    for (let i = from; i >= to; i--) if (pred(this.at(i))) return i;
    return -1;
  }

  firstWhere(pred: (b: Block) => boolean): number {
    for (let i = 0; i < this.arr.length; i++) if (pred(this.at(i))) return i;
    return -1;
  }

  /** The last block of a call. Call ids are one block each (nothing in the
   *  fold makes a second), so this is also the first. */
  byCall(callId: string): number {
    const ix = this.indexed();
    if (ix) {
      const i = ix.byCall.get(callId);
      if (i === undefined) return -1;
      if (this.at(i)?.tool?.callId === callId) return i;
    }
    return this.lastWhere((b) => b.tool?.callId === callId);
  }

  byId(id: string): number {
    const ix = this.indexed();
    if (ix) {
      const i = ix.byId.get(id);
      if (i === undefined) return -1;
      if (this.at(i)?.id === id) return i;
    }
    return this.lastWhere((b) => b.id === id);
  }

  lastWhereBy(pred: (b: Block) => boolean): number {
    return this.lastWhere(pred);
  }

  /** The first pending block (of this text, when given). */
  firstPending(text?: string): number {
    const ix = this.indexed();
    if (ix && ix.pending === 0) return -1;
    return this.firstWhere((b) => !!b.pending && (text === undefined || b.text === text));
  }

  /** Whether an approval card with no call id waits for one: when none
   *  does, a call's title cannot match one. */
  mayHaveOrphans(): boolean {
    const ix = this.indexed();
    return !ix || ix.orphans > 0;
  }

  lastUser(): number {
    const ix = this.indexed();
    if (ix) {
      if (ix.lastUser < 0) return -1;
      if (this.at(ix.lastUser).role === "user") return ix.lastUser;
    }
    return this.lastWhere((b) => b.role === "user");
  }

  /** Each block from `mark` up that `pred` holds, rewritten by `fix`; the
   *  mark then passes them all (page mode). */
  sweep(mark: "stream" | "open" | "users", pred: (b: Block) => boolean, fix: (b: Block) => Block): void {
    const from = this.page ? this.marks[mark] : 0;
    for (let i = from; i < this.arr.length; i++) {
      const b = this.at(i);
      if (pred(b)) this.set(i, fix(b));
    }
    if (this.page) this.marks[mark] = this.arr.length;
  }
}

function isOrphanApproval(block: Block): boolean {
  return block.role === "tool" && !!block.approval && !block.tool?.callId;
}

function isOpenUser(block: Block): boolean {
  return block.role === "user" && block.doneTs === undefined && !block.pending;
}

/** What a fold touched, in blocks: read, copied or indexed. Tests read it
 *  to hold the fold to work in proportion to its rows. */
export const foldProbe = { visits: 0 };

/** The fields of a fold beside its blocks, written in place by `foldRow`. */
type Scalars = Omit<FoldState, "blocks">;

/** A finished text or reasoning stream at the tail stops streaming before
 *  anything is appended after it (toolBlock.ts `sealLastStream`). */
function sealLast(d: Draft): void {
  const n = d.length;
  if (n === 0) return;
  const last = d.at(n - 1);
  if (last.streaming && (last.role === "assistant" || last.role === "reasoning")) d.set(n - 1, { ...last, streaming: false });
}

function append(d: Draft, block: Block): void {
  sealLast(d);
  d.push(block);
}

/** toolBlock.ts `appendStatusBlock`, in place: true when it appended. */
function appendStatus(d: Draft, text: string, id: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  let last: Block | undefined;
  for (let i = d.length - 1; i >= 0 && !last; i--) {
    const b = d.at(i);
    if (b.role !== "reasoning") last = b;
  }
  if (last?.role === "system" && last.text === trimmed) return false;
  append(d, { id, role: "system", text: trimmed });
  return true;
}

/** toolBlock.ts `upsertToolBlock`, in place. */
function upsertTool(d: Draft, cwd: string, patch: ToolPatch, id: string): void {
  let index = patch.callId ? d.byCall(patch.callId) : -1;
  if (index < 0) {
    const needle = normalizeLabel(patch.title || "");
    if (needle && d.mayHaveOrphans()) {
      index = d.firstWhere(
        (b) => b.role === "tool" && !!b.approval && !b.tool?.callId && normalizeLabel(b.text || b.tool?.title || "") === needle,
      );
    }
  }
  if (index < 0) {
    append(d, toolBlockAfter(undefined, cwd, patch, id));
    return;
  }
  const prev = d.at(index);
  const next = toolBlockAfter(prev, cwd, patch, id);
  if (next !== prev) d.set(index, next);
}

/** toolBlock.ts `attachApprovalBlock`, in place. */
function attachApproval(d: Draft, cwd: string, event: ApprovalAttach, id: string): void {
  let index = -1;
  if (event.callId) {
    index = d.byCall(event.callId);
  } else {
    // No call id: only a call from this turn still waiting on its result can
    // be the one asked about (toolBlock.ts `findToolForApproval`).
    const start = d.lastUser() + 1;
    const candidate = (b: Block) => b.role === "tool" && !b.approval && isOpenTool(b);
    if (event.name) {
      for (let i = d.length - 1; i >= start && index < 0; i--) {
        const b = d.at(i);
        if (candidate(b) && b.tool?.name === event.name) index = i;
      }
    }
    if (index < 0) {
      const needle = normalizeLabel(event.title);
      const unmatched: number[] = [];
      for (let i = d.length - 1; i >= start; i--) {
        const b = d.at(i);
        if (!candidate(b)) continue;
        unmatched.push(i);
        if (needle && normalizeLabel(b.text || b.tool?.title || "") === needle) {
          index = i;
          break;
        }
      }
      if (index < 0 && unmatched.length === 1) index = unmatched[0];
    }
  }
  if (index >= 0) d.set(index, approvalBlockAfter(d.at(index), cwd, event, id));
  else append(d, approvalBlockAfter(undefined, cwd, event, id));
}

/** toolBlock.ts `stopStreamingBlocks`: every stream stops, and the open
 *  turn of the person's gets its duration. */
function stopStreams(d: Draft, now: number): void {
  d.sweep("stream", (b) => !!b.streaming, (b) => ({ ...b, streaming: false }));
  const u = d.lastUser();
  if (u < 0) return;
  const user = d.at(u);
  if (user.durationMs != null || user.startedAt == null) return;
  d.set(u, { ...user, durationMs: Math.max(0, now - user.startedAt) });
}

/** toolBlock.ts `settleOpenTools`. */
function settleTools(d: Draft): void {
  d.sweep("open", isUnsettledTool, (b) => ({ ...b, streaming: false, tool: { ...b.tool, status: "cancelled" } }));
}

/** toolBlock.ts `resumeTurnClock`. */
function resumeClock(d: Draft, now: number): void {
  const i = d.lastUser();
  if (i < 0) return;
  const block = d.at(i);
  if (block.durationMs == null || block.startedAt == null) return;
  const { durationMs, doneTs, stoppedTs: _stopped, ...rest } = block;
  // An error already resumed from (older than the turn's current start)
  // leaves a later pause's span to the pause rule below.
  let error: Block | undefined;
  for (let j = d.length - 1; j > i; j--) {
    const b = d.at(j);
    if (b.role !== "system") break;
    if (b.id.startsWith("err:")) {
      error = b;
      break;
    }
  }
  if (error && (error.ts ?? Infinity) >= block.startedAt) {
    d.set(i, { ...rest, startedAt: now });
    return;
  }
  if (doneTs !== undefined && _stopped === undefined) return;
  d.set(i, { ...rest, startedAt: now - durationMs });
}

/** The turn ending closes every open user section — each gets its own
 *  timer. `stopped`: the host put the turn down with its harness gone, and
 *  a Resume carries the span on (resumeTurnClock). */
function closeUserTurns(d: Draft, ts: number, stopped = false): void {
  d.sweep("users", isOpenUser, (b) => ({ ...b, doneTs: ts, ...(stopped ? { stoppedTs: ts } : {}) }));
}

/** New blocks land at the tail unstamped; give them their round, todo and time. */
function stampTail(d: Draft, thread: ThreadState, ts: number | undefined): void {
  let end = d.length;
  while (end > 0 && d.at(end - 1).round === undefined) end--;
  for (let i = end; i < d.length; i++) {
    const b = d.at(i);
    d.set(i, {
      ...b,
      round: thread.round,
      todo: thread.activeTodo,
      ...(ts !== undefined && b.ts === undefined ? { ts } : {}),
      ...(thread.inPass ? { pass: true } : {}),
    });
  }
}

/** The open compaction's row, by the id the start stamped; -1 when none is open. */
function openCompactionIndex(d: Draft, thread: ThreadState): number {
  return thread.compactionId ? d.byId(thread.compactionId) : -1;
}

/** The open compaction's row takes its outcome in place, wherever it sits. */
function closeCompaction(d: Draft, idx: number, text: string, meta: Partial<CompactionMeta>): void {
  const row = d.at(idx);
  d.set(idx, { ...row, text, compaction: { ...row.compaction, ...meta } as CompactionMeta });
}

/** Stamp the child on the status row just appended (a repeat note appends nothing). */
function withAgent(d: Draft, agent: NonNullable<Block["agent"]>): void {
  if (d.length === 0) return;
  const last = d.at(d.length - 1);
  if (last.role !== "system" || last.agent?.id === agent.id) return;
  d.set(d.length - 1, { ...last, agent });
}

/**
 * The host spawned a child: the call that asked for it gains the id, so the
 * call's row is the one row of the spawn. The newest spawn_agent call of
 * the turn with room left takes it; a repeat changes nothing. False when no
 * call in the turn asked (an older log): the caller appends a row instead.
 */
function stampSpawn(d: Draft, id: string): boolean {
  const start = d.lastUser() + 1;
  let target = -1;
  for (let i = d.length - 1; i >= start; i--) {
    const tool = d.at(i).tool;
    if (!tool?.name || shortName(tool.name) !== "spawn_agent") continue;
    const spawned = tool.spawned ?? [];
    if (spawned.includes(id)) return true;
    if (target < 0 && spawned.length < spawnsAskedFor(tool)) target = i;
  }
  if (target < 0) return false;
  const b = d.at(target);
  d.set(target, { ...b, tool: { ...b.tool, spawned: [...(b.tool?.spawned ?? []), id] } });
  return true;
}

/** A subagent step under a spawning call: the parent's chip counts it. */
function countSubStep(d: Draft, parentCallId: string): void {
  const idx = d.byCall(parentCallId);
  if (idx < 0) return;
  const parent = d.at(idx);
  d.set(idx, { ...parent, tool: { ...parent.tool, subCount: (parent.tool?.subCount ?? 0) + 1 } });
}

export function foldAll(
  rows: EventRow[],
  cwd: string,
  state: FoldState = emptyFold(),
): FoldState {
  return foldPage(state, rows, cwd);
}

type UserTurnExtra = {
  secondOpinion?: Block["secondOpinion"];
  noteCard?: Block["noteCard"];
};

/** Show the user's message the instant they hit send; the echoed
 *  `user-text` row claims this block instead of appending a second one. */
export function foldOptimisticUser(
  state: FoldState,
  text: string,
  attachments: Attachment[] = [],
  extra?: UserTurnExtra,
  newPass?: boolean,
): FoldState {
  const now = Date.now();
  const thread = { ...state.thread };
  const d = new Draft(state.blocks, false);
  beginTurn(thread, now, lastBlockTs(d), newPass);
  const block: Block = {
    id: `pending:${state.nextId}`,
    role: "user",
    text,
    startedAt: now,
    pending: true,
    pendingAfter: state.lastSeq,
    born: now,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(extra?.secondOpinion ? { secondOpinion: extra.secondOpinion } : {}),
    ...(extra?.noteCard ? { noteCard: extra.noteCard } : {}),
  };
  append(d, block);
  stampTail(d, thread, now);
  return { ...state, busy: true, nextId: state.nextId + 1, thread, blocks: d.arr };
}

/** The echo takes the optimistic row's place on screen: its key (the row
 *  never changes key), its entrance, its previews and its chips. */
function claimPending(echo: Block, pending: Block): Block {
  return {
    ...echo,
    rowKey: pending.rowKey ?? pending.id,
    ...(pending.born !== undefined ? { born: pending.born } : {}),
    ...(pending.attachments?.length ? { attachments: pending.attachments } : {}),
    ...(pending.secondOpinion ? { secondOpinion: pending.secondOpinion } : {}),
    ...(pending.noteCard ? { noteCard: pending.noteCard } : {}),
  };
}

/**
 * After a refold from the rows alone (a head paged in, an older page), the
 * optimistic rows the entry still holds meet the refolded log. Each is
 * matched to its echo: a persisted user row past the seq the send followed
 * (`pendingAfter`), the same text first, else the next in order; the echo
 * stands and takes the row's key (`claimPending`). One with no echo in the
 * log yet stays pending: FIRST when the loaded rows start past the seq it
 * followed (its echo lies in the gap before them, where the next older page
 * or the live claim will find it), LAST when nothing persisted since could
 * hold it (the host has not written it). Appended last after the echo had
 * folded, a pending row sat under the whole stream and the working line
 * read Sending for the rest of the turn.
 */
export function reconcilePending(state: FoldState, pending: Block[]): FoldState {
  if (pending.length === 0) return state;
  let blocks = state.blocks;
  const taken = new Set<number>();
  const before: Block[] = [];
  const after: Block[] = [];
  let firstSeq = Infinity;
  for (const b of blocks) if (b.seq !== undefined && b.seq < firstSeq) firstSeq = b.seq;
  let from = 0;
  for (const p of pending) {
    const floor = p.pendingAfter ?? 0;
    const candidates: number[] = [];
    for (let i = from; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.role === "user" && !b.pending && b.seq !== undefined && b.seq > floor && !taken.has(i)) candidates.push(i);
    }
    const idx = candidates.find((i) => blocks[i].text === p.text) ?? candidates[0];
    if (idx === undefined) {
      (floor + 1 < firstSeq ? before : after).push(p);
      continue;
    }
    taken.add(idx);
    from = idx + 1;
    if (blocks === state.blocks) blocks = blocks.slice();
    blocks[idx] = claimPending(blocks[idx], p);
  }
  if (before.length === 0 && after.length === 0 && blocks === state.blocks) return state;
  return { ...state, blocks: [...before, ...blocks, ...after] };
}

const OPEN_STATUSES = new Set(["starting", "running", "waiting"]);
const COMPACTION_STOPPED = "Compaction stopped";

/** How many children a spawn_agent call asked for: its `agents` list, else one. */
function spawnsAskedFor(tool: NonNullable<Block["tool"]>): number {
  const input = asRecord(tool.input ?? tool.partialInput);
  return Array.isArray(input?.agents) ? Math.max(1, input.agents.length) : 1;
}

/** Remote profile: bytes of the OmittedBody values inside `value` (0 when none). */
function omittedBytes(value: unknown, depth = 0): number {
  if (isOmittedBody(value)) return value.bytes;
  if (!value || typeof value !== "object" || depth > 8) return 0;
  let n = 0;
  for (const v of Object.values(value as Record<string, unknown>)) n += omittedBytes(v, depth + 1);
  return n;
}

/** The block's `omitted` record with this row added; nothing when the row
 *  carries no omitted body, is ephemeral, or is already recorded. */
function omittedAfter(
  prev: Block | undefined,
  row: EventRow,
  bytes: number,
): { omitted?: NonNullable<Block["tool"]>["omitted"] } {
  if (bytes <= 0 || row.ephemeral || row.seq < 0) return {};
  const before = prev?.tool?.omitted;
  if (before?.seqs.includes(row.seq)) return {};
  return {
    omitted: {
      sessionId: row.sessionId,
      seqs: before ? [...before.seqs, row.seq] : [row.seq],
      bytes: (before?.bytes ?? 0) + bytes,
    },
  };
}

/** A preview as the renderer may hold it: diff lines or an output that
 *  left the wire become absent; the path and the counts stay. */
function wirePreview(preview: ToolPreview | undefined): ToolPreview | undefined {
  if (!preview) return preview;
  const lines = isOmittedBody(preview.lines) ? undefined : preview.lines;
  const output = isOmittedBody(preview.output) ? undefined : preview.output;
  return lines === preview.lines && output === preview.output ? preview : { ...preview, lines, output };
}

/** The text a tool result carries on the wire: the output, or an omitted
 *  body's first line until the row is fetched whole. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  return isOmittedBody(output) ? output.head : "";
}

export function foldEvent(
  state: FoldState,
  row: EventRow,
  cwd: string,
): FoldState {
  const persisted = !row.ephemeral && row.seq >= 0;
  // A row already folded (a live push that history then repeats) is a no-op.
  if (persisted && row.seq <= state.lastSeq) return state;
  const d = new Draft(state.blocks, false);
  const { blocks: _blocks, ...rest } = state;
  const s: Scalars = { ...rest };
  foldRow(d, s, row, cwd);
  if (d.writes > 0 && (row.event.type === "assistant-text" || row.event.type === "thinking")) {
    carryPendingApprovalIndex(state.blocks, d.arr);
  }
  if (
    d.writes === 0 &&
    s.busy === state.busy &&
    s.context === state.context &&
    s.lastSeq === state.lastSeq &&
    s.nextId === state.nextId &&
    s.thread === state.thread
  ) {
    return state;
  }
  return { blocks: d.arr, busy: s.busy, context: s.context, lastSeq: s.lastSeq, nextId: s.nextId, thread: s.thread };
}

/**
 * A page of rows folded at once: the state is the one folding them one by
 * one with `foldEvent` gives (same blocks, ids and seqs), but the blocks are
 * copied once for the page rather than once a row, and a call's block, a
 * keyed text and the open blocks are found by index, not by walking the
 * thread. Folding N rows into M blocks costs about N + M, not N × M. A live
 * push keeps `foldEvent`.
 */
export function foldPage(state: FoldState, rows: readonly EventRow[], cwd: string): FoldState {
  const builder = new FoldBuilder(state, cwd);
  for (const row of rows) builder.add(row);
  return builder.state();
}

/**
 * `foldPage` a row at a time, for a caller that gives the window back
 * between slices of a long page: `state()` hands out the state so far and
 * the next `add` copies the blocks once more before it writes.
 */
export class FoldBuilder {
  private readonly d: Draft;
  private readonly s: Scalars;
  private last: FoldState;

  constructor(
    state: FoldState,
    private readonly cwd: string,
  ) {
    this.last = state;
    this.d = new Draft(state.blocks, true);
    const { blocks: _blocks, ...rest } = state;
    this.s = { ...rest };
  }

  add(row: EventRow): void {
    if (!row.ephemeral && row.seq >= 0 && row.seq <= this.s.lastSeq) return;
    foldRow(this.d, this.s, row, this.cwd);
  }

  state(): FoldState {
    const { d, s, last } = this;
    if (
      d.arr === last.blocks &&
      s.busy === last.busy &&
      s.context === last.context &&
      s.lastSeq === last.lastSeq &&
      s.nextId === last.nextId &&
      s.thread === last.thread
    ) {
      return last;
    }
    d.share();
    this.last = { blocks: d.arr, busy: s.busy, context: s.context, lastSeq: s.lastSeq, nextId: s.nextId, thread: s.thread };
    return this.last;
  }
}

/**
 * "Load earlier": the older page in front of the rows already kept, folded
 * from the start through one builder. Exact: the board's rounds and todos
 * (`Block.round`, `Block.todo`) and the thread state count from the first
 * row, so a fold that joined the page's blocks to the kept ones would stamp
 * the kept ones wrong; this refolds the kept rows, but each page costs its
 * rows and blocks once (not rows × blocks, as a refold a row at a time did).
 */
export function foldOlder(older: readonly EventRow[], kept: readonly EventRow[], cwd: string): FoldState {
  const builder = new FoldBuilder(emptyFold(), cwd);
  for (const row of older) builder.add(row);
  for (const row of kept) builder.add(row);
  return builder.state();
}

/** One row into the draft and the fields beside it. */
function foldRow(d: Draft, s: Scalars, row: EventRow, cwd: string): void {
  const e = row.event;
  const persisted = !row.ephemeral && row.seq >= 0;
  d.beginRow();
  const rowThread = s.thread;
  if (persisted) s.lastSeq = Math.max(s.lastSeq, row.seq);
  // A persisted row mints ids from its seq, so a block gets the same id
  // whether it folded from a tail-first paint or from the whole log.
  let minted = 0;
  const fresh = (prefix: string): string =>
    persisted ? `${prefix}:${row.seq}${minted++ ? `.${minted}` : ""}` : `${prefix}:${s.nextId++}`;
  /** Copy-on-write view of the thread state (one copy a row). */
  const th = (): ThreadState => {
    if (s.thread === rowThread) s.thread = { ...rowThread };
    return s.thread;
  };
  const last = (): Block | undefined => (d.length > 0 ? d.at(d.length - 1) : undefined);

  // In-harness subagent output: its tool calls show as ordinary tool
  // blocks (nesting arrives later); its prose stays out of the main flow.
  const nested = "parentCallId" in e && !!e.parentCallId;

  switch (e.type) {
    case "user-text": {
      const attachments = e.attachments?.length
        ? e.attachments.map(fromServerAttachment)
        : undefined;
      const stamp = e as {
        model?: string;
        reasoning?: string;
        context1m?: boolean;
        fast?: boolean;
        ultrafast?: boolean;
        newPass?: boolean;
        preamble?: { text: string; words: number };
      };
      const preamble = stamp.preamble ? { preamble: stamp.preamble } : {};
      const steer = e.steerId ? { steerId: e.steerId } : {};
      const turn =
        stamp.model || stamp.reasoning || stamp.context1m !== undefined
          ? {
              turn: {
                model: stamp.model,
                reasoning: stamp.reasoning,
                context1m: stamp.context1m,
                fast: stamp.fast,
                ultrafast: stamp.ultrafast,
              },
            }
          : {};
      let idx = d.firstPending(e.text);
      if (idx < 0) idx = d.firstPending();
      const id = `u:${row.seq}`;
      if (idx >= 0) {
        // The optimistic push already ran beginTurn — just claim the block.
        const { pending: _pending, ...prev } = d.at(idx);
        d.set(idx, {
          ...prev,
          id,
          // The row on screen keeps its key: the echo renames the block, not the row.
          rowKey: prev.rowKey ?? prev.id,
          startedAt: row.ts,
          ts: row.ts,
          ...(persisted ? { seq: row.seq } : {}),
          ...turn,
          ...preamble,
          ...steer,
          ...(prev.attachments?.length
            ? { attachments: prev.attachments }
            : attachments
              ? { attachments }
              : {}),
        });
      } else {
        beginTurn(th(), row.ts, lastBlockTs(d), stamp.newPass);
        append(d, {
          id,
          role: "user",
          text: e.text,
          startedAt: row.ts,
          ...(persisted ? { seq: row.seq } : {}),
          ...turn,
          ...preamble,
          ...steer,
          ...(attachments ? { attachments } : {}),
        });
      }
      s.busy = true;
      break;
    }
    case "assistant-text":
    case "thinking": {
      if (nested) break;
      const role = e.type === "thinking" ? "reasoning" : "assistant";
      const key =
        e.msgId !== undefined && e.blockIndex !== undefined
          ? `${e.msgId}:${e.blockIndex}`
          : null;
      let idx = -1;
      if (key) {
        idx = d.byId(key);
      } else {
        const tail = last();
        if (tail?.role === role && tail.streaming) idx = d.length - 1;
      }
      if (idx < 0) {
        if (e.delta && !e.text) break;
        append(d, {
          id: key ?? fresh(role === "assistant" ? "a" : "r"),
          role,
          text: e.text,
          streaming: e.delta,
          ...(persisted && role === "assistant" ? { seq: row.seq } : {}),
          // A thought counts its seconds from its first delta, which is
          // ephemeral and so never reaches stampTail's `ts`; its end is its
          // final row, so a settled one reads "Thought for 12s".
          ...(role === "reasoning" ? { startedAt: row.ts, ...(e.delta ? {} : { doneTs: row.ts }) } : {}),
        });
        break;
      }
      const cur = d.at(idx);
      const text = e.delta ? cur.text + e.text : e.text;
      if (text === cur.text && cur.streaming === e.delta) break;
      d.set(idx, {
        ...cur,
        text,
        streaming: e.delta,
        ...(role === "reasoning" && !e.delta && cur.doneTs === undefined ? { doneTs: row.ts } : {}),
      });
      break;
    }
    case "tool-call": {
      if (!nested) {
        // Plan-tool calls move the todo model first, so this block and
        // everything after it belong to the newly in-progress todo.
        const next = { ...s.thread };
        if (applyTodoCall(next, e)) s.thread = next;
      }
      const input = asRecord(e.input) ?? {};
      const title = e.display
        ? [e.display.app, e.display.action].filter(Boolean).join(": ")
        : toolTitle(e.name, input);
      const prevIdx = d.byCall(e.callId);
      const prevCall = prevIdx >= 0 ? d.at(prevIdx) : undefined;
      upsertTool(
        d,
        cwd,
        {
          callId: e.callId,
          title: title || e.name,
          kind: toolKind(e.name),
          status: "running",
          // The raw input reaches the preview: normalized patches are arrays.
          preview: wirePreview(e.preview) ?? previewFromTool(e.name, e.input),
          streaming: true,
          extra: {
            name: e.name,
            ...(e.partial
              ? { partialInput: e.input }
              : { input: e.input, partialInput: undefined }),
            ...(e.display ? { display: e.display } : {}),
            ...(e.parentCallId ? { parentCallId: e.parentCallId } : {}),
            ...omittedAfter(prevCall, row, omittedBytes(e.input) + omittedBytes(e.preview)),
          },
        },
        e.callId,
      );
      if (e.parentCallId && !e.partial) countSubStep(d, e.parentCallId);
      if (persisted) {
        const idx = d.byCall(e.callId);
        if (idx >= 0) {
          const b = d.at(idx);
          if (b.ts === undefined && b.round !== undefined) d.set(idx, { ...b, ts: row.ts });
        }
      }
      break;
    }
    case "tool-result": {
      if (!nested) {
        const next = { ...s.thread };
        if (applyTaskResult(next, e)) s.thread = next;
      }
      const prevIdx = d.byCall(e.callId);
      const prev = prevIdx >= 0 ? d.at(prevIdx) : undefined;
      const name = prev?.tool?.name ?? "tool";
      const input = prev?.tool?.input ?? prev?.tool?.partialInput;
      const output = outputText(e.output);
      const extra = {
        ...(e.reauth ? { reauth: e.reauth } : {}),
        ...omittedAfter(prev, row, omittedBytes(e.output)),
      };
      upsertTool(
        d,
        cwd,
        {
          callId: e.callId,
          status: e.isError ? "failed" : "completed",
          detail: output,
          preview: previewFromTool(name, input, output),
          streaming: false,
          ...(Object.keys(extra).length ? { extra } : {}),
        },
        e.callId,
      );
      {
        const idx = d.byCall(e.callId);
        if (idx >= 0) {
          const b = d.at(idx);
          if (b.doneTs === undefined) d.set(idx, { ...b, doneTs: row.ts });
        }
      }
      break;
    }
    case "approval-request": {
      const input = asRecord(e.input) ?? {};
      attachApproval(
        d,
        cwd,
        {
          requestId: e.requestId,
          title: e.title ?? toolTitle(e.toolName, input) ?? e.toolName,
          kind: toolKind(e.toolName),
          callId: e.callId,
          preview: previewFromTool(e.toolName, e.input),
          name: e.toolName,
          input: e.input,
          choices: e.choices,
        },
        `ap:${e.requestId}`,
      );
      {
        const bytes = omittedBytes(e.input);
        const idx = bytes > 0 ? d.lastWhereBy((b) => b.approval?.requestId === e.requestId) : -1;
        if (idx >= 0) {
          const b = d.at(idx);
          if (b.tool) d.set(idx, { ...b, tool: { ...b.tool, ...omittedAfter(b, row, bytes) } });
        }
      }
      s.busy = true;
      break;
    }
    case "approval-resolved": {
      // A policy verdict (timeout, interrupt) is still a denial; `auto`
      // records who decided, never a third state.
      const decided = e.allow ? "allow" : "deny";
      const auto = e.auto === true;
      const idx = d.lastWhereBy((b) => b.approval?.requestId === e.requestId);
      if (idx < 0) break;
      const b = d.at(idx);
      const cur = b.approval;
      if (cur?.decided === decided && !!cur.auto === auto) break;
      d.set(idx, {
        ...b,
        approval: { requestId: e.requestId, decided, ...(auto ? { auto } : {}), ...(cur?.choices ? { choices: cur.choices } : {}) },
      });
      break;
    }
    case "steer": {
      // The last row per steer wins; a row for a steer the window never
      // saw (its user row outside the loaded page) changes nothing.
      const idx = d.lastWhereBy((b) => b.steerId === e.steerId);
      if (idx < 0) break;
      d.set(idx, {
        ...d.at(idx),
        steer: {
          state: e.state,
          ts: row.ts,
          ...(e.how ? { how: e.how } : {}),
          ...(e.reason ? { reason: e.reason } : {}),
        },
      });
      break;
    }
    case "question-request": {
      const question: QuestionMeta = {
        sessionId: row.sessionId,
        requestId: e.requestId,
        questions: e.questions,
      };
      const title = e.questions[0]?.header?.trim() || "Question";
      // The harness's own tool call (claude's AskUserQuestion) already has a
      // block; the card attaches to it instead of standing beside it.
      const idx = e.callId ? d.byCall(e.callId) : -1;
      if (idx >= 0) {
        const prev = d.at(idx);
        d.set(idx, {
          ...prev,
          text: title,
          streaming: true,
          tool: { ...prev.tool, title, kind: "question", status: "running" },
          question,
        });
      } else {
        append(d, {
          id: `q:${e.requestId}`,
          role: "tool",
          text: title,
          streaming: true,
          tool: { callId: e.callId, title, kind: "question", status: "running" },
          question,
        });
      }
      s.busy = true;
      break;
    }
    case "question-resolved": {
      const idx = d.lastWhereBy((b) => b.question?.requestId === e.requestId);
      if (idx < 0) break;
      const prev = d.at(idx);
      d.set(idx, {
        ...prev,
        streaming: false,
        tool: { ...prev.tool, status: e.answers ? "completed" : "cancelled" },
        question: { ...prev.question!, answers: e.answers },
      });
      break;
    }
    case "status": {
      s.busy = OPEN_STATUSES.has(e.status);
      // A turn that ends or pauses with a compaction open: it stopped there.
      if (!s.busy && (s.thread.compacting || s.thread.compactionId)) {
        const open = openCompactionIndex(d, s.thread);
        if (open >= 0) closeCompaction(d, open, COMPACTION_STOPPED, { phase: "stopped", endedAt: row.ts });
        const t = th();
        t.compacting = false;
        t.compactionId = null;
      }
      if (e.status === "paused") {
        // The turn clock freezes with the work; resuming restarts it.
        stopStreams(d, row.ts);
      } else if (!s.busy) {
        stopStreams(d, row.ts);
        settleTools(d);
      } else {
        resumeClock(d, row.ts);
      }
      // Logged end-of-turn signals close the turn even when the
      // turn-complete event itself was lost (crash between the two).
      // 'watching' ends the turn too: the harness is idle behind its
      // background work, and the wake turn opens a fresh one. 'stopped'
      // ends it as well: the harness is gone, and Resume opens a new one.
      if (
        (e.status === "idle" || e.status === "error" || e.status === "watching" || e.status === "stopped") &&
        (s.thread.turnOpen || s.thread.inPass)
      ) {
        const t = th();
        t.turnOpen = false;
        t.inPass = false;
        closeUserTurns(d, row.ts, e.status === "stopped");
      }
      // "awaiting approval"/"awaiting answer" already show as cards.
      if (e.detail && e.status !== "waiting") {
        // The check on idle background tasks is a step of the work, not a row.
        if (appendStatus(d, e.detail, fresh("s")) && e.detail === BACKGROUND_CHECK_WORDS) {
          d.set(d.length - 1, { ...d.at(d.length - 1), backgroundCheck: true });
        }
      }
      break;
    }
    case "turn-complete": {
      stopStreams(d, row.ts);
      settleTools(d);
      closeUserTurns(d, row.ts);
      s.busy = false;
      const t = th();
      t.turnOpen = false;
      t.inPass = false;
      if (e.costUsd !== undefined) t.cost = e.costUsd;
      markUsage(t, e.inputTokens, e.outputTokens);
      break;
    }
    case "context":
      s.context = mergeContextUsage(s.context, { used: e.tokens, window: e.window });
      break;
    case "error":
      stopStreams(d, row.ts);
      d.push({
        id: `err:${row.seq}`,
        role: "system",
        text: e.message,
        ts: row.ts,
        ...(e.stopped ? { stopped: true } : {}),
        ...(e.failure ? { failure: e.failure } : {}),
      });
      if (e.stopped) {
        settleTools(d);
        s.busy = false;
        th().stopped = true;
      }
      break;
    case "notice":
      // A plain system row (the account left this host, …): no failure, no stop.
      if (e.kind === "review" && e.review) {
        // The outcome card, its own row even when the text repeats (two
        // holds in a row read the same); a merged-anyway row settles the
        // hold it names.
        const review = e.review;
        append(d, { id: `notice:${row.seq}`, role: "system", text: e.message, review });
        if (review.outcome === "merged-anyway") {
          for (let i = d.length - 2; i >= 0; i--) {
            const b = d.at(i);
            const r = b.review;
            if (r && r.runId === review.runId && r.outcome === "held" && !r.resolved) {
              d.set(i, { ...b, review: { ...r, resolved: true } });
              break;
            }
          }
        }
      } else if (e.kind === "gate" && e.gate) {
        // A gate run's row: its own card, never folded into the status line.
        append(d, { id: `notice:${row.seq}`, role: "system", text: e.message, gate: e.gate });
      } else if (e.kind === "away") {
        // What the thread decided or the host answered while the person was
        // away: a row each, even when two read the same.
        const notice = e.away ? { kind: e.kind, away: e.away } : { kind: e.kind };
        append(d, { id: `notice:${row.seq}`, role: "system", text: e.message, notice });
      } else if (appendStatus(d, e.message, `notice:${row.seq}`)) {
        // A batch's or an account's notice keeps its kind, so it draws typed.
        d.set(d.length - 1, { ...d.at(d.length - 1), notice: { kind: e.kind } });
      }
      break;
    case "errors-cleared": {
      // Continue settled every error shown so far; the system rows that
      // followed the last one (status detail, stopped note) go with it.
      let end = d.length;
      while (end > 0 && d.at(end - 1).role === "system") end--;
      const kept: Block[] = [];
      for (let i = 0; i < end; i++) {
        const b = d.at(i);
        if (!b.id.startsWith("err:")) kept.push(b);
      }
      if (kept.length !== d.length) d.replace(kept);
      if (s.thread.stopped) th().stopped = false;
      break;
    }
    case "compaction": {
      const { type: _type, ...meta } = e;
      // One row per compaction: the CLI repeats its start every 30 s while
      // it compacts (rows on disk keep the repeats), and a message can land
      // between the start and the outcome.
      const open = openCompactionIndex(d, s.thread);
      if (e.phase === "start") {
        if (open >= 0) break;
        const id = fresh("s");
        append(d, { id, role: "system", text: COMPACTING_WORDS, compaction: { ...meta, startedAt: row.ts } });
        const t = th();
        t.compacting = true;
        t.compactionId = id;
      } else {
        const note =
          e.phase === "done"
            ? "Context compacted"
            : `Compaction failed${e.error ? `: ${e.error}` : ""}`;
        if (open >= 0) closeCompaction(d, open, note, meta);
        else append(d, { id: fresh("s"), role: "system", text: note, compaction: meta });
        // The meter drops with the transcript: the next turn's reading
        // confirms, but the user should not wait for it.
        if (e.phase === "done" && e.postTokens !== undefined) {
          s.context = mergeContextUsage(s.context, { used: e.postTokens });
        }
        if (s.thread.compacting || s.thread.compactionId) {
          const t = th();
          t.compacting = false;
          t.compactionId = null;
        }
      }
      break;
    }
    case "plan":
      append(d, { id: `p:${row.seq}`, role: "plan", text: e.text });
      break;
    case "turn-pass":
      // The completed-turn pass opens here; blocks fold as pass work
      // until its turn-complete (or a status end) closes it.
      appendStatus(d, `Pass: ${e.actions.join(", ")}`, fresh("s"));
      stampTail(d, s.thread, row.ts);
      th().inPass = true;
      break;
    case "agent-report":
      appendStatus(d, `Agent ${e.title}: ${e.status}`, fresh("s"));
      // The batch's own report names the master itself: it reads as the batch and links nowhere.
      withAgent(d, {
        id: e.agentId,
        title: e.title,
        status: e.status,
        ...(e.agentId === row.sessionId ? { batch: true } : {}),
      });
      break;
    case "background-task":
      // A task that settled is a step of the run it woke (the driver never
      // emits one for ambient housekeeping); live work is the Activity section.
      append(d, {
        id: fresh("t"),
        role: "system",
        text: e.description,
        task: { id: e.taskId, label: e.description, status: e.status },
      });
      break;
    case "background-tasks":
      // No row: the live set is the right panel's Activity section.
      break;
    case "plan-handoff": {
      // The plan's quiet record of its build: a row that links to the thread.
      appendStatus(d, `${e.how === "auto" ? "Implementation started" : "Build started"}: ${e.title}`, fresh("s"));
      const tail = last();
      if (tail?.role === "system") {
        d.set(d.length - 1, { ...tail, planHandoff: { id: e.sessionId, title: e.title, how: e.how } });
      }
      break;
    }
    case "agent-spawned": {
      // On the call, a child on another host is named as the call's result
      // names it (`<env>:<id>`); the fallback row keeps the id the store knows.
      const id = e.environmentId ? `${e.environmentId}:${e.childSessionId}` : e.childSessionId;
      if (!stampSpawn(d, id)) {
        appendStatus(d, `Spawned agent ${e.childSessionId}`, fresh("s"));
        withAgent(d, { id: e.childSessionId });
      }
      if (!s.thread.agents.includes(e.childSessionId)) {
        const t = th();
        t.agents = [...t.agents, e.childSessionId];
      }
      break;
    }
    case "goal":
      appendStatus(d, `Goal ${e.phase}: ${e.condition}`, fresh("s"));
      break;
    case "research-source": {
      // Kept whole for the research board; a repeat callId only enriches
      // the earlier row (a late-arriving title).
      const t = th();
      const i = t.sources.findIndex((src) => src.callId === e.callId);
      const source = { callId: e.callId, url: e.url, query: e.query, agentId: e.agentId, agentLabel: e.agentLabel, title: e.title, claim: e.claim, ts: row.ts };
      t.sources =
        i >= 0
          ? t.sources.map((src, n) =>
              n === i
                ? { ...src, ...(e.title ? { title: e.title } : {}), ...(e.url ? { url: e.url } : {}), ...(e.claim ? { claim: e.claim } : {}) }
                : src,
            )
          : [...t.sources, source];
      break;
    }
    case "usage":
      if (!nested && (e.inputTokens !== undefined || e.outputTokens !== undefined)) {
        markUsage(th(), e.inputTokens, e.outputTokens);
      }
      break;
  }

  if (d.rowWrites > 0) stampTail(d, s.thread, persisted ? row.ts : undefined);
}

export function fromServerAttachment(a: ServerAttachment): Attachment {
  return {
    id: a.path,
    name: a.name,
    mimeType: a.mime ?? "",
    kind: a.kind === "image" || a.kind === "appshot" ? "image" : "file",
    size: 0,
    path: a.path,
    ...(a.textPath ? { textPath: a.textPath } : {}),
  };
}

function findLastIndex<T>(list: T[], pred: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return i;
  return -1;
}

/** Remote profile: fold one row fetched whole (`session.rowBody`) over the
 *  block it belongs to, the way the live fold did with the projected row;
 *  the block keeps its id and place. Rows of other kinds change nothing. */
export function applyRowBody(blocks: Block[], cwd: string, row: EventRow): Block[] {
  const e = row.event;
  switch (e.type) {
    case "tool-call": {
      const prev = blocks[findLastIndex(blocks, (b) => b.tool?.callId === e.callId)];
      if (!prev) return blocks;
      const input = asRecord(e.input) ?? {};
      const title = e.display
        ? [e.display.app, e.display.action].filter(Boolean).join(": ")
        : toolTitle(e.name, input);
      return upsertToolBlock(
        blocks,
        cwd,
        {
          callId: e.callId,
          title: title || e.name,
          kind: toolKind(e.name),
          preview: e.preview ?? previewFromTool(e.name, e.input),
          streaming: !!prev.streaming,
          extra: { name: e.name, input: e.input, partialInput: undefined },
        },
        e.callId,
      );
    }
    case "tool-result": {
      const prev = blocks[findLastIndex(blocks, (b) => b.tool?.callId === e.callId)];
      if (!prev) return blocks;
      const name = prev.tool?.name ?? "tool";
      return upsertToolBlock(
        blocks,
        cwd,
        {
          callId: e.callId,
          status: e.isError ? "failed" : "completed",
          detail: e.output,
          preview: previewFromTool(name, prev.tool?.input, e.output),
          streaming: false,
        },
        e.callId,
      );
    }
    case "approval-request": {
      const idx = findLastIndex(blocks, (b) => b.approval?.requestId === e.requestId);
      const prev = blocks[idx];
      if (idx < 0 || !prev.tool) return blocks;
      const next = blocks.slice();
      next[idx] = {
        ...prev,
        tool: {
          ...prev.tool,
          input: e.input,
          preview: previewFromTool(e.toolName, e.input) ?? prev.tool.preview,
        },
      };
      return next;
    }
    default:
      return blocks;
  }
}
