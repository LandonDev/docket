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
 * Read ahead of the open. The row's hover or focus loads this chunk and asks nothing (the keeper and the pushes keep
 * what it reads current). At idle after launch: the sources run, only if he opened Today today or on either of the
 * two days before.
 */
export function warm(why: "intent" | "idle"): void {
  if (why === "intent" || !openedLately()) return;
  void ready.then(() => keepWarm());
}
