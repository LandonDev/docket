/**
 * Work's own chrome, one lazy chunk (`work-shell`, surfaces/chunks.ts): asked
 * for only once a host has Work on, or by Settings → Work. Nothing here is
 * in the first paint; the rail, the column and Settings reach it through
 * lib/workSwitch.ts's seams and these surfaces.
 */
export { WorkRailHost } from "./WorkRailHost";
export { WorkColumnHead } from "./WorkColumn";
export { WorkViewSurface } from "./WorkViewPage";
export { WorkSettingsBody, WorkWorkspacePage, CodeWorkspaceSector } from "./settings";
export { WorkProjectSettings } from "./ProjectSettings";
// The Outbox's count in the rail, from boot while a host has Work on (work/outbox/store.ts).
import "../outbox/store";
