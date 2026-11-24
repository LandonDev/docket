import { confirmAction } from "../../../chrome/ConfirmDialog";
import { liveLayer } from "./layer";

/**
 * A live file's guest unloads (its tab closing, or Live → Edit here). Word holds the unload while it is still saving;
 * the layer waits up to 10 s, then asks. Answers whether the guest is gone; a tab with no guest answers at once.
 */
export function leaveLive(itemId: string, name: string, layer = liveLayer): Promise<boolean> {
  return layer.leave(itemId, () =>
    confirmAction({ title: `${name} is still saving`, body: "Office for the web has not finished saving it. Close it anyway? What it has not saved may be lost.", action: "Close Anyway", danger: true }),
  );
}
