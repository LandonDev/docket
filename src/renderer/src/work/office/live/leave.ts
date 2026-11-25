import { confirmAction } from "../../../chrome/ConfirmDialog";
import { liveLayer } from "./layer";
import { liveLabel, type LiveApp } from "./liveSwitch";

/**
 * A live file's guest unloads (its tab closing, or Live → Edit here). Word holds the unload while it is still saving;
 * the layer waits up to 10 s, then asks. Answers whether the guest is gone; a tab with no guest answers at once.
 */
export function leaveLive(itemId: string, name: string, layer = liveLayer): Promise<boolean> {
  return layer.leave(itemId, () =>
    confirmAction({ title: `${name} is still saving`, body: "Office for the web has not finished saving it. Close it anyway? What it has not saved may be lost.", action: "Close Anyway", danger: true }),
  );
}

/**
 * Live → Edit here: the guest unloads as for a close, but the ask names the switch ("Switch Anyway"). Answers
 * "forced" when he let Word go mid-save, so the switch makes the host prove the file holds his edits before it opens
 * them here (liveSwitch.ts); unproven, the tab stays live and the guest comes back.
 */
export async function leaveForSwitch(itemId: string, name: string, app: LiveApp, layer = liveLayer): Promise<boolean | "forced"> {
  let forced = false;
  const gone = await layer.leave(itemId, async () => {
    forced = await confirmAction({
      title: `${name} is still saving`,
      body: `What ${liveLabel(app)} has not saved may be lost. If the file does not have your changes yet, it stays in ${liveLabel(app)}.`,
      action: "Switch Anyway",
      danger: true,
    });
    return forced;
  });
  return gone && forced ? "forced" : gone;
}
