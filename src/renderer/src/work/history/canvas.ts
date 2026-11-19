import { defineChunk } from "../../lib/lazyChunk";
import { History } from "../icons";
import { defineCanvasKind } from "../canvas/kind";
import type { HistoryState } from "./HistoryCanvas";

/**
 * The history kind of canvas item (docs/agents/work-history.md): a
 * document's versions, the compare of any two, and the review of a branch
 * of suggestions. Nothing claims it: the pane opens it by name
 * (`shell.openHistory`), on the source of the document whose versions it
 * shows (a LifeOS document or a `.tcdoc`). It is its own history, so the
 * pane draws no History for it.
 */
export const historyCanvas = defineCanvasKind<HistoryState>({
  kind: "history",
  label: "History",
  icon: History,
  opens: {},
  phone: "web",
  guestable: false,
  chunk: defineChunk("work-history-canvas", () => import("./HistoryCanvas")),
});
