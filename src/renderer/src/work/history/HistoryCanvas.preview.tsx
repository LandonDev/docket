// A preview frame for `bun run ui:preview src/renderer/src/work/history/HistoryCanvas.preview.tsx#HistoryPreview --width 864`:
// a document's History in the canvas pane, as a Files tab or a folded thread has it (docs/agents/work-history.md): the
// versions by who and why, suggestions waiting over them, no versions yet, and a read that failed (the list's, a compare's).
import { diffBlocks, type BlockLike } from "work-kit/formats/diff";
import type { HistoryBranches } from "./store";
import type { HistoryVersion, HistoryVersions } from "@shared/contract-work-history";
import type { CanvasItem, CanvasKind } from "@shared/work";
import { defineChunk } from "../../lib/lazyChunk";
import { CanvasSeat } from "../canvas/CanvasSeat";
import type { CanvasKindDef } from "../canvas/kind";
import { CANVAS } from "../canvas/registry";
import { applyCanvasPush, keepState, resetCanvasStore, setFolded } from "../canvas/store";
import * as HistoryCanvas from "./HistoryCanvas";
import { seedHistory } from "./store";

export type HistoryMoment = "list" | "waiting" | "empty" | "failed" | "compare-failed";

const AGENT = "agent:env_box:t1";
const NAMES = { owner: "You", [AGENT]: "Venue for the spring LAN", "user:dana": "Dana Lee" };
const p = (id: string, text: string): BlockLike => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });

function versions(now: number): HistoryVersion[] {
  return [
    { id: "v4", at: now - 4 * 60_000, cause: "agent-turn", by: [AGENT], kept: "snapshot" },
    { id: "v3", at: now - 52 * 60_000, cause: "idle", by: ["owner", "user:dana"], kept: "snapshot" },
    { id: "v2", at: now - 26 * 3_600_000, cause: "named", label: "Sent to the venue", by: ["owner"], kept: "snapshot" },
    { id: "v1", at: now - 3 * 86_400_000, cause: "import", by: ["owner"], kept: "snapshot" },
  ];
}

export function HistoryPreview({ moment = "list" }: { moment?: HistoryMoment }) {
  resetCanvasStore();
  const now = Date.now();
  const sessionId = `preview-history-${moment}`;
  const itemId = `${sessionId}-item`;
  const source: CanvasItem["source"] = { at: "file", host: "local", path: `/work/${moment}/Run of show.tcdoc` };
  const item: CanvasItem = { id: itemId, sessionId, workspaceId: "ws", kind: "history" as CanvasKind, title: "Run of show", source, state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 };
  const listed: HistoryVersions = { versions: moment === "empty" ? [] : versions(now), shared: false, names: NAMES };
  const none: HistoryBranches = { branches: [], names: NAMES };
  const waiting: HistoryBranches = {
    branches: [
      { id: "b1", baseVersionId: "v4", authors: [AGENT], label: "Suggestions", at: now - 9 * 60_000, editedAt: now - 9 * 60_000, diff: diffBlocks([p("a", "Doors open at 9:00 AM")], [p("a", "Doors open at 8:30 AM"), p("n", "Badges at the north desk")]) },
      { id: "b2", baseVersionId: "v4", authors: ["owner"], label: `Restore ${now - 26 * 3_600_000}`, at: now - 2 * 60_000, editedAt: now - 2 * 60_000, diff: diffBlocks([p("a", "Doors open at 9:00 AM")], [p("a", "Doors open at 10:00 AM")]) },
    ],
    names: NAMES,
  } as HistoryBranches;
  seedHistory("local", source, {
    versions: moment === "failed" ? "The box did not answer" : listed,
    branches: moment === "waiting" ? waiting : none,
    compares: moment === "compare-failed" ? [["v2", "v4", "The box did not answer"]] : [],
  });
  if (moment === "compare-failed") keepState(itemId, { view: "compare", from: "v2", to: "v4", current: 0 });
  const chunk = defineChunk(`preview-history-${moment}`, () => Promise.resolve(HistoryCanvas as never));
  void chunk.load();
  const kinds: Record<CanvasKind, CanvasKindDef> = { ...CANVAS, history: { ...CANVAS.history, chunk: chunk as never } };
  applyCanvasPush({ sessionId, items: [item], opened: itemId });
  // The canvas alone, as a Files tab has it.
  setFolded(sessionId, true);
  return (
    <div className="relative flex h-[440px] w-full overflow-hidden rounded-xl border border-border">
      <CanvasSeat session={{ id: sessionId, environmentId: "local" }} kinds={kinds}>
        <div />
      </CanvasSeat>
    </div>
  );
}
