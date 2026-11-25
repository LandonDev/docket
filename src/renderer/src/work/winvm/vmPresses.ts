import type { WinvmStill } from "@shared/contract-work-winvm";
import { registry } from "../../lib/connection/registry";

/**
 * The Windows VM's presses and reads from the Computers page's bar and picture (surfaces/threads/computer/ComputerBar.tsx,
 * Viewport.tsx), apart from Settings' own: Sleep, Restart, the screen's Size and Detail, and the still it went to sleep on.
 */

/** Puts the VM to sleep, held asleep until his Wake. */
export const sleepVm = (host: string): Promise<unknown> => registry.linkOf(host).request("work.winvm.sleep", {});

/** Restarts Windows cleanly; the host refuses while a thread holds it. */
export const restartVm = (host: string): Promise<unknown> => registry.linkOf(host).request("work.winvm.restart", {}, { timeoutMs: 660_000 });

/** The screen's Size or Detail (`work.winvm.settings`, once the host takes them). */
export const setVmScreen = (host: string, pick: { screen: string } | { detail: string }): Promise<unknown> => registry.linkOf(host).request("work.winvm.settings", pick);

/** The picture the VM went to sleep on; null before its first sleep, or where this key may not watch it. */
export async function readVmStill(host: string): Promise<WinvmStill | null> {
  const link = registry.link(host);
  if (!link) return null;
  try {
    return (await link.request<{ still: WinvmStill | null }>("work.winvm.still", {})).still;
  } catch {
    return null;
  }
}
