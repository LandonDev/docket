import { loadOutbox } from "../outbox/store";
import { loadSources } from "./store";
import { keepWarm, openedLately } from "./warm";

/**
 * Today, the first page above the Work workspaces: one lazy chunk
 * (`work-place-today`, work/places/registry.ts), asked for by its rail row,
 * the Go menu and the idle warm-up while Work is on. Nothing here is in the
 * first paint (docs/agents/work-today.md).
 */
export { Head, View } from "./TodayView";
export { openToday, toggleToday, goTo, TODAY } from "./open";
export type { TodayAct, TodayAnswer, TodayEnv, TodayFailure, TodayMark, TodayRow, TodaySection, TodaySource, TodayWorkspace } from "./types";

/** The page's sources, loaded with its chunk: its first frame has them. */
export const ready: Promise<void> = loadSources();

/**
 * Read ahead of the open. On the row's hover or focus: the sources run from
 * now, and what waits in the Outbox is asked again. At idle after launch:
 * only if he opened Today today or on either of the two days before.
 */
export function warm(why: "intent" | "idle"): void {
  if (why === "idle" && !openedLately()) return;
  void ready.then(() => keepWarm());
  if (why === "intent") void loadOutbox();
}
