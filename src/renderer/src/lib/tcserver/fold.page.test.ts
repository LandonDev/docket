import { describe, expect, it } from "vitest";
import { lcg, perfThread } from "../../../../../scripts/lib/ios-perf-seeds";
import { emptyFold, FoldBuilder, foldEvent, foldOlder, foldPage, foldProbe, type FoldState } from "./fold";
import type { AgentEvent, EventRow } from "./types";

const CWD = "/repo";

/** Agent-shaped rows: two turns of calls, results, thoughts and replies. */
function agentRows(rows: number, seed = 7): EventRow[] {
  return perfThread("t", { rows, turns: 2, seed }).map((event, i) => ({ sessionId: "t", seq: i + 1, ts: 1_000 + i * 50, event }));
}

/**
 * The seeded thread with what it lacks mixed in: live deltas (ephemeral),
 * statuses that pause and resume, approvals, a compaction, an error that
 * Continue clears, a spawn the host stamps, a background check and a
 * notice. Seqs stay contiguous; an ephemeral row carries -1.
 */
function mixedRows(rows: number, seed: number): EventRow[] {
  const rand = lcg(seed);
  const base = perfThread("m", { rows, turns: 4, seed });
  const out: EventRow[] = [];
  let seq = 0;
  let ts = 1_000;
  const add = (event: AgentEvent, ephemeral = false) => {
    ts += 40;
    out.push(ephemeral ? { sessionId: "m", seq: -1, ts, event, ephemeral: true } : { sessionId: "m", seq: ++seq, ts, event });
  };
  base.forEach((event, i) => {
    const r = rand();
    if (event.type === "tool-call" && r < 0.05) {
      add({ type: "approval-request", requestId: `ap${i}`, toolName: event.name, input: event.input, callId: event.callId });
      add({ type: "status", status: "waiting", detail: "awaiting approval" });
      add({ type: "approval-resolved", requestId: `ap${i}`, allow: rand() < 0.8 });
      add({ type: "status", status: "running" });
    } else if (event.type === "assistant-text" && r < 0.2) {
      add({ ...event, text: event.text.slice(0, 20), delta: true }, true);
    } else if (r < 0.01) {
      add({ type: "status", status: "paused" });
      add({ type: "status", status: "running" });
    } else if (r < 0.012) {
      add({ type: "compaction", phase: "start" } as AgentEvent);
      add({ type: "compaction", phase: "done", postTokens: 1_000 } as AgentEvent);
    } else if (r < 0.014) {
      add({ type: "error", message: "The provider failed", stopped: true });
      add({ type: "errors-cleared" });
      add({ type: "status", status: "running", detail: "Retrying" });
    } else if (r < 0.016) {
      add({ type: "status", status: "running", detail: "Checking background tasks" });
      add({ type: "notice", kind: "account", message: "The account left this host" } as AgentEvent);
    }
    add(event);
    if (event.type === "tool-call" && event.name.endsWith("spawn_agent")) {
      add({ type: "agent-spawned", childSessionId: `child${i}` } as AgentEvent);
    }
  });
  return out;
}

const rowByRow = (rows: readonly EventRow[], state: FoldState = emptyFold()): FoldState =>
  rows.reduce((acc, row) => foldEvent(acc, row, CWD), state);

/** Random page boundaries: 1 to `max` rows a page. */
function pages<T>(rows: readonly T[], seed: number, max: number): T[][] {
  const rand = lcg(seed);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; ) {
    const n = 1 + Math.floor(rand() * max);
    out.push(rows.slice(i, i + n));
    i += n;
  }
  return out;
}

function visits(run: () => void): number {
  foldProbe.visits = 0;
  run();
  return foldProbe.visits;
}

describe("foldPage", () => {
  it("folds a page to the state folding it a row at a time gives", () => {
    for (const seed of [1, 2, 3]) {
      const rows = seed === 1 ? agentRows(6_000, seed) : mixedRows(6_000, seed);
      const expected = rowByRow(rows);
      let state = emptyFold();
      for (const page of pages(rows, seed, 700)) state = foldPage(state, page, CWD);
      expect(state).toEqual(expected);
      expect(state.blocks.map((b) => b.id)).toEqual(expected.blocks.map((b) => b.id));
      expect(state.lastSeq).toBe(expected.lastSeq);
    }
  });

  it("a page landing on a state a push folded matches the push's path, and back again", () => {
    const rows = mixedRows(3_000, 9);
    const expected = rowByRow(rows);
    let state = emptyFold();
    pages(rows, 9, 200).forEach((page, i) => {
      state = i % 2 ? rowByRow(page, state) : foldPage(state, page, CWD);
    });
    expect(state).toEqual(expected);
  });

  it("a builder handing out states between slices folds as one page does", () => {
    const rows = mixedRows(3_000, 4);
    const builder = new FoldBuilder(emptyFold(), CWD);
    const seen: FoldState[] = [];
    for (const page of pages(rows, 4, 300)) {
      for (const row of page) builder.add(row);
      seen.push(builder.state());
    }
    expect(seen[seen.length - 1]).toEqual(rowByRow(rows));
    // A state handed out is never written again.
    const first = rowByRow(pages(rows, 4, 300)[0]);
    expect(seen[0]).toEqual(first);
  });

  it("a page that changes nothing hands back the state it was given", () => {
    const rows = agentRows(400);
    const state = foldPage(emptyFold(), rows, CWD);
    expect(foldPage(state, rows.slice(0, 100), CWD)).toBe(state);
  });

  it("visits each of 40,000 agent rows a bounded number of times: twice the rows, at most 2.5 times the visits", () => {
    const half = visits(() => foldPage(emptyFold(), agentRows(20_000), CWD));
    const whole = visits(() => foldPage(emptyFold(), agentRows(40_000), CWD));
    expect(whole / half).toBeLessThanOrEqual(2.5);
    expect(whole).toBeLessThanOrEqual(10 * 40_000);
  });

  it("a live push still copies once: today's path, one block array a row", () => {
    const state = foldPage(emptyFold(), agentRows(2_000), CWD);
    const n = visits(() =>
      foldEvent(state, { sessionId: "t", seq: state.lastSeq + 1, ts: 9e9, event: { type: "assistant-text", text: "more", delta: true, msgId: "x", blockIndex: 0 } }, CWD),
    );
    expect(n).toBeLessThanOrEqual(3 * state.blocks.length);
  });
});

describe("foldOlder", () => {
  it("each Load earlier page folds the log exactly, at a cost of its rows, not rows × blocks", () => {
    const rows = agentRows(6_300);
    const PAGE = 300;
    let kept: EventRow[] = rows.slice(-PAGE);
    let state = foldPage(emptyFold(), kept, CWD);
    const perPage: number[] = [];
    for (let page = 1; page <= 20; page++) {
      const older = rows.slice(rows.length - (page + 1) * PAGE, rows.length - page * PAGE);
      perPage.push(visits(() => (state = foldOlder(older, kept, CWD))));
      kept = [...older, ...kept];
      expect(state).toEqual(foldPage(emptyFold(), kept, CWD));
    }
    // Linear in what is loaded: the twentieth page (6,300 rows) costs about
    // 21 times the first (600 rows), never its square.
    expect(perPage[19] / perPage[0]).toBeLessThanOrEqual(21 * 1.25);
    expect(perPage[19]).toBeLessThanOrEqual(10 * kept.length);
  });
});
