/**
 * The outbox pillar's screens, one lazy chunk (`work-outbox`,
 * surfaces/chunks.ts): the Outbox page, the Results section of a Work
 * thread's right panel, and the return from Away. Nothing here is in the
 * first paint (docs/agents/work-outbox.md, "The screens").
 */
export { OutboxView, rememberOutboxTab } from "./OutboxView";
// Today's sheet shows a held item whole with the Outbox's own Send (work/today/HeldSheet.tsx).
export { HeldDetail } from "./HeldDetail";
export { HostRetry, KindGlyph, rowWords } from "./parts";
// The summary list: the Outbox's ticks, and a thread's request (its card and its detail).
export { SummaryList, type SummaryRow } from "./SummaryList";
export { ResultsSection } from "./ResultsSection";
export { AwayReturnWork, gatherAway } from "./AwayList";
