// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/master/BatchFoot.tsx#BatchFoot`. The console stays open and its elapsed time is fixed.
import { emptyBatch, type BatchState, type BatchStep } from "@server/shared/contract-batch";

const clock = Date.UTC(2026, 9, 21, 15, 20);
const t = clock - 5 * 60_000;
const noop = async () => {};
const missing = 'error: Module not found "scripts/gate.ts"';

/** The default steps (land, gate, release) with these states. */
function batch(gate: Partial<BatchStep>, release: Partial<BatchStep> = {}): BatchState {
  const state = emptyBatch("m");
  const [land, g, r] = state.steps;
  return {
    ...state,
    steps: [
      { ...land, status: "passed", detail: "nothing landed", at: t, startedAt: t, endedAt: t },
      { ...g, at: t, startedAt: t, endedAt: t + 69_000, ...gate },
      { ...r, ...release },
    ],
  };
}

const props = (state: BatchState) => ({ batch: state, clock, titleOf: () => undefined, onSave: noop, onStop: noop });

export default [
  {
    // The rows paint from the store; the foot alone waits for batch.board, still.
    name: "loading",
    props: { ...props(batch({ status: "running" })), loaded: false },
  },
  {
    // Both reads failed on first open: no steps from the default rules and no Edit…, one red line with Retry.
    name: "rules not read",
    props: { ...props(emptyBatch("m")), failed: true, onRetry: noop },
  },
  {
    // A child blocks the end: the word Blocked and what blocks, two spans.
    name: "blocked",
    props: { ...props({ ...batch({ status: "pending", startedAt: undefined, endedAt: undefined, at: null }), blocked: { sessionId: "c1", why: "unreachable", environmentId: "mac" } }), titleOf: () => "Release notes", hostName: () => "this Mac" },
  },
  {
    // A running step's count and its label are one detail with a comma.
    name: "gate running",
    props: props(batch({ status: "running", endedAt: undefined, progress: { done: 3, total: 7, label: "vitest" }, log: ["✓ typecheck 12s", "vitest: 3 of 7 files"] })),
  },
  {
    // A script that never ran: its one line is the row's, with no console under it.
    name: "gate script missing",
    props: props(batch({ status: "failed", detail: missing, endedAt: t, log: [missing] })),
  },
  {
    name: "vitest failed",
    props: props(
      batch({
        status: "failed",
        detail: "vitest: src/total.test.ts > rounds the total",
        log: [
          "  ✓ typecheck  21.0s  passed",
          "  ✗ vitest       48s  failed  exit 1",
          "--- vitest (last lines) ---",
          " FAIL  src/total.test.ts > rounds the total",
          "AssertionError: expected 3 to be 4",
          "--- end vitest ---",
          "gate failed: vitest in 1m 9s",
        ],
      }),
    ),
  },
  {
    // The time column says each step's time; the details say no more than the glyphs.
    name: "passed",
    props: props(
      batch(
        { status: "passed", detail: "passed in 1m 09s", log: ["gate passed in 1m 9s"] },
        { status: "passed", detail: "release-278 tagged", at: t, startedAt: t + 69_000, endedAt: t + 77_000 },
      ),
    ),
  },
];
