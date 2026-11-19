/**
 * The work-canvas chunk's barrel (surfaces/chunks.ts `workCanvasChunk`):
 * the canvas pane beside a Work thread and the composer's chip row. Loaded
 * the first time a Work thread is on screen or a composer holds a chip;
 * nothing of it is in the first paint.
 */
export { CanvasSeat } from "./CanvasSeat";
export { ComposerChips } from "./ComposerChips";
export { SentChips } from "./SentChips";
export { addContextChip } from "./chips";
export { askWorkMentions, pickWorkMention, rowsStillMatching } from "./mentions";
export { sentChipsOf } from "./sentChips";
export { CANVAS, kindFor } from "./registry";
export { onOpenHeld } from "./held";
export { openItem } from "./store";
