import { useEffect, useState } from "react";
import type { WinvmState } from "@server/shared/contract-work-winvm";
import { registry } from "./connection/registry";
import { useWorkHosts } from "./workSwitch";

/**
 * The Windows VM as the Computers page's header needs it (docs/DESIGN.md
 * "Computers"): a host whose VM sleeps, or wakes, so the header can offer
 * Wake. Read from each Work host's keeper (`work.winvm.state`, kept current
 * by the `work.winvm` push); a host with no VM answers `none` and is left
 * out. Awake, the VM is a tile, and nothing is offered here.
 */

export interface SleepingVm {
  host: string;
  waking: boolean;
}

/** The first host whose VM sleeps or wakes, from each host's state. */
export function sleepingVm(states: Readonly<Record<string, WinvmState["state"]>>): SleepingVm | null {
  for (const [host, state] of Object.entries(states)) if (state === "asleep" || state === "waking") return { host, waking: state === "waking" };
  return null;
}

export function useSleepingVm(): SleepingVm | null {
  const hosts = useWorkHosts();
  const [states, setStates] = useState<Record<string, WinvmState["state"]>>({});
  const key = [...hosts].sort().join("\n");
  useEffect(() => {
    let live = true;
    const offs: (() => void)[] = [];
    const put = (host: string, state: WinvmState["state"] | null): void => {
      if (!live) return;
      setStates((was) => {
        if ((was[host] ?? null) === state) return was;
        const next = { ...was };
        if (state === null) delete next[host];
        else next[host] = state;
        return next;
      });
    };
    for (const host of hosts) {
      const link = registry.link(host);
      if (!link) continue;
      const load = (): void =>
        void link.request<WinvmState>("work.winvm.state", {}).then(
          (s) => put(host, s.state),
          () => put(host, null),
        );
      load();
      offs.push(
        link.onPush((push) => {
          if (push.push === "work.winvm") put(host, push.state.state);
        }),
        link.onOpen(load),
      );
    }
    setStates((was) => Object.fromEntries(Object.entries(was).filter(([h]) => hosts.has(h))));
    return () => {
      live = false;
      for (const off of offs) off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the hosts' content
  }, [key]);
  return sleepingVm(states);
}

/** Wakes the host's VM; it answers once the VM is awake, when its tile is already on the page. */
export async function wakeVm(host: string): Promise<void> {
  const link = registry.link(host);
  if (!link) throw new Error("the host is not connected");
  await link.request("work.winvm.wake", {});
}
