import { describe, expect, it } from "vitest";
import { lcg, perfThread } from "../../../../scripts/lib/ios-perf-seeds";
import type { Block } from "../lib/session";
import { emptyFold, foldEvent, foldPage, type FoldState } from "../lib/tcserver/fold";
import type { AgentEvent, EventRow } from "../lib/tcserver/types";
import { RowLayout } from "../lib/transcriptWindow";
import { isErrorBlock } from "../lib/turnOutcome";
import {
  awaitsUser,
  endsWork,
  extendTurns,
  isActivityBlock,
  isHiddenTool,
  isTodoBlock,
  standsAlone,
  turnItems,
  type TurnItem,
} from "./transcriptActivity";
import { estimateRowHeight, flattenTurns, ROW_GAP, rowKeyOf, type RowGap, type TranscriptRow, type TurnInfo } from "./transcriptRows";

// ── The oracle: the rows as they were built before they extended from the tail ──

function oldGroupTurns(blocks: Block[]): Block[][] {
  const turns: Block[][] = [];
  let current: Block[] = [];
  for (const block of blocks) {
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
  return turns;
}

function oldStableTurns(next: Block[][], previous: Block[][]): Block[][] {
  let changed = next.length !== previous.length;
  const out = next.map((turn, i) => {
    const old = previous[i];
    if (old && old.length === turn.length && old.every((block, j) => block === turn[j])) return old;
    changed = true;
    return turn;
  });
  return changed ? out : previous;
}

const plainText = (text: string) => text.replace(/\s+/g, " ").trim();

function oldRepeatsNextProse(blocks: Block[], index: number): boolean {
  const block = blocks[index];
  if (block.role !== "reasoning") return false;
  const next = blocks.slice(index + 1).find((b) => b.role !== "assistant" || b.text.trim());
  return next?.role === "assistant" && plainText(next.text) === plainText(block.text);
}

function oldIgnored(block: Block): boolean {
  if (block.role === "reasoning") return !block.text.trim();
  return block.role === "assistant" && !block.text.trim();
}

function oldGroupTurnItems(blocks: Block[]): TurnItem[] {
  const visible = blocks.filter(
    (block, index) =>
      !oldIgnored(block) && (isTodoBlock(block) || standsAlone(block) || !isHiddenTool(block)) && !oldRepeatsNextProse(blocks, index),
  );
  const items: TurnItem[] = [];
  let activity: Block[] = [];
  const flush = () => {
    if (activity.length > 0) items.push({ type: "activity", blocks: activity });
    activity = [];
  };
  for (const block of visible) {
    if (!standsAlone(block) && !endsWork(block) && isActivityBlock(block)) {
      activity.push(block);
      continue;
    }
    flush();
    items.push({ type: "block", block });
  }
  flush();
  return items;
}

function oldTurnUserBlock(blocks: Block[]): Block | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].role === "user") return blocks[i];
  return undefined;
}

function oldShapeOf(item: TurnItem): "line" | "bubble" | "block" {
  if (item.type === "activity") return "line";
  const block = item.block;
  switch (block.role) {
    case "user":
      return "bubble";
    case "assistant":
    case "plan":
      return "block";
    case "approval":
      return "line";
    case "tool":
      return block.question || isTodoBlock(block) || standsAlone(block) ? "block" : "line";
    case "system":
      return isErrorBlock(block) || (block.review?.outcome === "held" && !block.review.resolved) ? "block" : "line";
    default:
      return "line";
  }
}

function oldGapAbove(item: TurnItem, before: TurnItem | null, previousRow: TranscriptRow | undefined): RowGap {
  if (!previousRow) return ROW_GAP.first;
  if (!before) return previousRow.kind === "more" ? ROW_GAP.more : ROW_GAP.turn;
  const above = oldShapeOf(before);
  if (above === "bubble") return ROW_GAP.reply;
  return above === "line" && oldShapeOf(item) === "line" ? ROW_GAP.line : ROW_GAP.block;
}

function oldFlattenTurns(turns: Block[][], busy: boolean, options: { loadEarlier?: boolean; paused?: boolean } = {}): TranscriptRow[] {
  const open = busy || !!options.paused;
  const rows: TranscriptRow[] = [];
  if (options.loadEarlier) rows.push({ kind: "more", key: "more", gap: ROW_GAP.first });
  turns.forEach((blocks, index) => {
    const isLast = index === turns.length - 1;
    const userBlock = oldTurnUserBlock(blocks);
    const durationMs =
      userBlock?.durationMs ??
      (userBlock?.doneTs != null && userBlock.startedAt != null ? Math.max(0, userBlock.doneTs - userBlock.startedAt) : undefined);
    const turn: TurnInfo = { id: rowKeyOf(blocks[0]), index, isLast, settled: !(open && isLast), blocks, userBlock, durationMs, startedAt: userBlock?.startedAt };
    const items = oldGroupTurnItems(blocks);
    items.forEach((item, itemIndex) => {
      const gap = oldGapAbove(item, itemIndex === 0 ? null : items[itemIndex - 1], rows[rows.length - 1]);
      if (item.type === "activity") {
        rows.push({
          kind: "item",
          key: rowKeyOf(item.blocks[0]),
          turn,
          item,
          live: busy && isLast && itemIndex === items.length - 1,
          working: open && isLast && items.slice(itemIndex + 1).every((it) => it.type === "block" && awaitsUser(it.block)),
          gap,
        });
        return;
      }
      rows.push({ kind: "item", key: rowKeyOf(item.block), turn, item, live: false, working: false, gap });
    });
    rows.push({ kind: "end", key: `${turn.id}:end`, turn, gap: ROW_GAP.end });
  });
  return rows;
}

/** A row as drawn: everything RowView reads, blocks by identity. */
function drawn(row: TranscriptRow) {
  const height = estimateRowHeight(row);
  if (row.kind === "more") return { ...row, height };
  const turn = { id: row.turn.id, index: row.turn.index, isLast: row.turn.isLast, settled: row.turn.settled, userBlock: row.turn.userBlock, durationMs: row.turn.durationMs, startedAt: row.turn.startedAt, length: row.turn.blocks.length };
  if (row.kind === "end") return { kind: row.kind, key: row.key, gap: row.gap, turn, height };
  const blocks = row.item.type === "activity" ? row.item.blocks : [row.item.block];
  return { kind: row.kind, key: row.key, gap: row.gap, live: row.live, working: row.working, type: row.item.type, blocks, turn, height };
}

// ── The seeded thread, streamed ──

const CWD = "/repo";

/** The thread's rows, with a reply streamed as deltas before each settled
 *  paragraph and thought, a pause now and then, and a tool result that lands
 *  late; seqs contiguous, deltas ephemeral. */
function streamed(rows: number, turns: number, seed: number): EventRow[] {
  const rand = lcg(seed);
  const out: EventRow[] = [];
  let seq = 0;
  let ts = 1_000;
  const add = (event: AgentEvent, ephemeral = false) => {
    ts += 30;
    out.push(ephemeral ? { sessionId: "s", seq: -1, ts, event, ephemeral: true } : { sessionId: "s", seq: ++seq, ts, event });
  };
  for (const event of perfThread("s", { rows, turns, seed })) {
    if ((event.type === "assistant-text" || event.type === "thinking") && !event.delta && rand() < 0.5) {
      const words = event.text.split(" ");
      for (let i = 0; i < words.length; i += 6) add({ ...event, text: `${i ? " " : ""}${words.slice(i, i + 6).join(" ")}`, delta: true }, true);
    }
    if (rand() < 0.003) {
      add({ type: "status", status: "paused" });
      add({ type: "status", status: "running" });
    }
    add(event);
  }
  return out;
}

class Pipeline {
  blocks: Block[] = [];
  turns: Block[][] = [];
  oldTurns: Block[][] = [];
  rows: TranscriptRow[] = [];

  step(state: FoldState, check: boolean | "never"): void {
    const turns = extendTurns(this.blocks, this.turns, state.blocks);
    this.rows = flattenTurns(turns, state.busy).rows;
    if (check === true) {
      const oldTurns = oldStableTurns(oldGroupTurns(state.blocks), this.oldTurns);
      expect(turns.length).toBe(oldTurns.length);
      turns.forEach((turn, i) => expect(turn).toEqual(oldTurns[i]));
      // Reused exactly where the old path reused.
      turns.forEach((turn, i) => expect(turn === this.turns[i]).toBe(oldTurns[i] === this.oldTurns[i]));
      expect(turns === this.turns).toBe(oldTurns === this.oldTurns);
      this.oldTurns = oldTurns;
      const want = oldFlattenTurns(oldTurns, state.busy).map(drawn);
      expect(this.rows.map(drawn)).toEqual(want);
      turns.forEach((turn) => expect(turnItems(turn)).toEqual(oldGroupTurnItems(turn)));
    } else if (check === false) {
      this.oldTurns = oldStableTurns(oldGroupTurns(state.blocks), this.oldTurns);
    }
    this.blocks = state.blocks;
    this.turns = turns;
  }
}

describe("the live turn's rows, from the tail", () => {
  it("build the seeded 30,000-row thread's rows exactly as the old path did, delta by delta", () => {
    const rows = streamed(30_000, 2, 5);
    const head = rows.length - 1_500;
    let state = foldPage(emptyFold(), rows.slice(0, head), CWD);
    const pipe = new Pipeline();
    pipe.step(state, true);
    rows.slice(head).forEach((row, i, rest) => {
      state = foldEvent(state, row, CWD);
      pipe.step(state, i % 150 === 0 || i === rest.length - 1);
    });
  }, 120_000);

  it("match the old path over many turns, a new turn and a removal among them", () => {
    const rows = streamed(4_000, 40, 8);
    let state = emptyFold();
    const pipe = new Pipeline();
    rows.forEach((row, i) => {
      state = foldEvent(state, row, CWD);
      pipe.step(state, i % 25 === 0);
    });
    // An error and Continue: the error row leaves the list.
    for (const event of [{ type: "error", message: "failed", stopped: true }, { type: "errors-cleared" }] as AgentEvent[]) {
      state = foldEvent(state, { sessionId: "s", seq: state.lastSeq + 1, ts: 9e9, event }, CWD);
      pipe.step(state, true);
    }
  }, 120_000);

  it("a delta into a 20,000-block live turn reads no more than twice its own blocks", () => {
    const base = foldPage(emptyFold(), streamed(40_000, 1, 3).filter((r) => !r.ephemeral), CWD);
    expect(base.blocks.length).toBeGreaterThan(20_000);
    // Every block the delta did not make counts each block it is read through.
    const touched = new Set<Block>();
    const watch = (b: Block): Block => new Proxy(b, { get: (t, k, r) => (touched.add(t), Reflect.get(t, k, r)) });
    let state: FoldState = { ...base, busy: true, blocks: base.blocks.map(watch) };
    const pipe = new Pipeline();
    pipe.step(state, "never");
    const layout = new RowLayout();
    layout.setRows(pipe.rows.map((row) => ({ key: row.key, estimate: estimateRowHeight(row) })));
    const deltas: AgentEvent[] = [
      { type: "assistant-text", text: "Reading", delta: true, msgId: "live", blockIndex: 0 },
      { type: "assistant-text", text: " the fold", delta: true, msgId: "live", blockIndex: 0 },
      { type: "tool-call", callId: "live-call", name: "Read", input: { file_path: "src/a.ts" } },
      { type: "tool-result", callId: "live-call", output: "ok", isError: false },
      { type: "thinking", text: "Next the rows", delta: true, msgId: "live-t", blockIndex: 0 },
    ];
    for (const event of deltas) {
      const before = state.blocks;
      state = foldEvent(state, { sessionId: "s", seq: -1, ts: 9e9, event, ephemeral: true }, CWD);
      const own = state.blocks.filter((b, i) => b !== before[i]).length;
      touched.clear();
      pipe.step(state, "never");
      layout.setRows(pipe.rows.map((row) => ({ key: row.key, estimate: estimateRowHeight(row) })));
      expect(touched.size).toBeLessThanOrEqual(2 * own);
    }
  }, 120_000);
});

describe("RowLayout.setRows from the first row that moved", () => {
  it("answers every index, offset and total a fresh layout would", () => {
    const rand = lcg(21);
    let rows = Array.from({ length: 400 }, (_, i) => ({ key: `r${i}`, estimate: 20 + (i % 7) }));
    const layout = new RowLayout();
    layout.setRows(rows);
    for (let step = 0; step < 200; step++) {
      const r = rand();
      if (r < 0.4) rows = [...rows, { key: `n${step}`, estimate: 28 }];
      else if (r < 0.6) rows = rows.map((row, i) => (i === rows.length - 1 ? { ...row, estimate: row.estimate + 22 } : row));
      else if (r < 0.7) rows = [{ key: `top${step}`, estimate: 30 }, ...rows];
      else if (r < 0.8) rows = rows.slice(0, -2);
      else layout.measure(rows[Math.floor(rand() * rows.length)].key, 10 + Math.floor(rand() * 90));
      layout.offsetOf(Math.floor(rand() * rows.length));
      layout.setRows(rows);
      const fresh = new RowLayout();
      for (const row of rows) if (layout.hasMeasured(row.key)) fresh.measure(row.key, layout.sizeOf(layout.indexOf(row.key)));
      fresh.setRows(rows);
      expect(layout.length).toBe(fresh.length);
      expect(layout.total()).toBe(fresh.total());
      for (let i = 0; i <= rows.length; i += 7) expect(layout.offsetOf(i)).toBe(fresh.offsetOf(i));
      for (const row of rows) expect(layout.indexOf(row.key)).toBe(fresh.indexOf(row.key));
      expect(layout.indexOf(`gone`)).toBe(-1);
    }
  });
});
