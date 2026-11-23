import { loadWeek, loadZone, thisWeek } from "./store";

/**
 * The weekly review's page, a chunk of its own under the frame of a page
 * above the workspaces (`WORK_PLACES` in work/places/registry.ts): `View` is
 * the page, `Head` its controls at the header's end. Nothing here is in the
 * first paint (docs/agents/work-review.md, "The window").
 */
export { View } from "./ReviewPage";
export { Head } from "./Head";

/**
 * A hover or focus on the rail's row reads this week ahead, so the page opens on rows. Nothing is read at idle: a
 * week costs every host a scan of its threads, and he may never open the page this launch.
 */
export function warm(why: "intent" | "idle"): void {
  if (why !== "intent") return;
  void loadZone().then(() => loadWeek(thisWeek()));
}
