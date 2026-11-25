import { useEffect, useState } from "react";
import type { WinvmDetail, WinvmScreen, WinvmStill } from "@shared/contract-work-winvm";
import { registry } from "../../lib/connection/registry";

/**
 * The Windows VM's presses and reads from the Computers page's bar and picture (surfaces/threads/computer/ComputerBar.tsx,
 * Viewport.tsx), apart from Settings' own: Sleep, Restart, the screen's Size and Detail, and the still it went to sleep on.
 */

/** Puts the VM to sleep, held asleep until his Wake. */
export const sleepVm = (host: string): Promise<unknown> => registry.linkOf(host).request("work.winvm.sleep", {});

/** Restarts Windows cleanly; the host refuses while a thread holds it. */
export const restartVm = (host: string): Promise<unknown> => registry.linkOf(host).request("work.winvm.restart", {}, { timeoutMs: 660_000 });

/** The screen's Size or Detail: the host's setting (`work.winvm.settings`), which `WinvmState.display` then says. */
export const setVmScreen = (host: string, pick: { screen: WinvmScreen } | { detail: WinvmDetail }): Promise<unknown> => registry.linkOf(host).request("work.winvm.settings", pick);

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

/** The Windows VM's last picture, kept by its host as it went to sleep (`work.winvm.still`), as an image source; read again at each sleep. */
const stills = new Map<string, { src: string; width: number; height: number; at: number }>();
export function useVmStill(host: string, want: boolean, key: unknown): { src: string; width: number; height: number } | null {
  const [still, setStill] = useState(() => stills.get(host) ?? null);
  useEffect(() => {
    if (!want) return;
    let live = true;
    void readVmStill(host).then((s) => {
      if (!live || !s) return;
      const kept = { src: `data:image/jpeg;base64,${s.data}`, width: s.width, height: s.height, at: s.at };
      stills.set(host, kept);
      setStill((was) => (was?.at === kept.at ? was : kept));
    });
    return () => {
      live = false;
    };
  }, [host, want, key]);
  return want ? still : null;
}

