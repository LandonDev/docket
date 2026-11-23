/**
 * The frame of a page above the Work workspaces, one lazy chunk
 * (`work-places`, surfaces/chunks.ts): asked for by the rail's place rows,
 * the Go menu and the idle warm-up while Work is on. Each place's body is a
 * chunk of its own (registry.ts). Nothing here is in the first paint.
 */
export { WorkPlacePage } from "./WorkPlacePage";
import { watchDayStart } from "./registry";

export { placeForDayStart, warmPlace, WORK_PLACES, type WorkPlaceModule, type WorkPlaceProps } from "./registry";

watchDayStart();
