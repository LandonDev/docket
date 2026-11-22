import { useEffect, useState } from "react";
import type { WinvmState, WinvmStateName } from "@server/shared/contract-work-winvm";
import { registry } from "./connection/registry";
import { useWorkHosts } from "./workSwitch";
import { tileId, type ComputerTile } from "./computers";
import type { ComputerSessionRow } from "@server/shared/contract-computer";

/**
 * The Windows VM's state on each Work host, as the Computers page needs it
 * (docs/DESIGN.md "Computers"): read from each host's keeper
 * (`work.winvm.state`, kept current by the `work.winvm` push and read again
 * whenever the host's link opens, so a box restart or a dropped link comes
 * back by itself). Awake, the VM has a row of its own and is a tile like any
 * computer; in every other state the page draws its tile from this.
 */

/** What the page reads of one host's VM. */
export interface VmState {
  state: WinvmStateName;
  /** why this host cannot have one (not the box, no base image); null when it can */
  cannot: string | null;
  /** the keeper's last failure, in words */
  error: string | null;
}

const vmOf = (s: WinvmState): VmState => ({ state: s.state, cannot: s.cannot ?? null, error: s.error ?? null });
const same = (a: VmState | undefined, b: VmState): boolean => !!a && a.state === b.state && a.cannot === b.cannot && a.error === b.error;

/** Every Work host's VM, by host; a host with none it could have is left out. */
export function useVmStates(): Readonly<Record<string, VmState>> {
  const hosts = useWorkHosts();
  const [states, setStates] = useState<Record<string, VmState>>({});
  const key = [...hosts].sort().join("\n");
  useEffect(() => {
    let live = true;
    const offs: (() => void)[] = [];
    const put = (host: string, s: WinvmState | null): void => {
      if (!live) return;
      setStates((was) => {
        const next = s && !(s.state === "none" && s.cannot) ? vmOf(s) : null;
        if (next ? same(was[host], next) : !(host in was)) return was;
        const out = { ...was };
        if (next) out[host] = next;
        else delete out[host];
        return out;
      });
    };
    for (const host of hosts) {
      const link = registry.link(host);
      if (!link) continue;
      const load = (): void =>
        void link.request<WinvmState>("work.winvm.state", {}).then(
          (s) => put(host, s),
          () => put(host, null),
        );
      load();
      offs.push(
        link.onPush((push) => {
          if (push.push === "work.winvm") put(host, push.state);
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
  return states;
}

/** What the waiting picture says while it waits: the same words the host's own calls wait with. */
export const WAKING_LINE = "Waking the Windows VM";

/**
 * A VM that is not awake, as its picture's box says it (the one place its state is said): the words, whether a
 * spinner goes beside them, and whether the stage wakes it. Awake with no row of its own yet (the row and the state
 * arrive apart) reads as waking, so the tile never leaves the page between the two.
 */
export function restingVm(vm: VmState): { line: string; busy: boolean; wakes: boolean } {
  switch (vm.state) {
    case "none":
      return { line: "Not set up: Settings → Work → Windows VM", busy: false, wakes: false };
    case "setting-up":
      return { line: "Setting up the Windows VM", busy: true, wakes: false };
    case "asleep":
      return { line: "Asleep", busy: false, wakes: true };
    // going to sleep: a wake waits for the sleep, then wakes it
    case "going-to-sleep":
      return { line: WAKING_LINE, busy: true, wakes: true };
    default:
      return { line: WAKING_LINE, busy: true, wakes: false };
  }
}

/** Wakes the host's VM; it answers once the VM is awake. */
export async function wakeVm(host: string): Promise<void> {
  const link = registry.link(host);
  if (!link) throw new Error("the host is not connected");
  await link.request("work.winvm.wake", {});
}

/** The Windows VM's name on its host: its tile's key whoever holds it, and whatever its state. */
const VM_COMPUTER = "vm:windows";

/**
 * The Windows VM of every host whose VM has no row now (asleep, waking, going to sleep, setting up, not set up,
 * or awake before its row came): one tile each, drawn from its state, under the same key its live tile has, so
 * the page keeps one element for it through every state and his press on it always lands.
 */
export function restingVmTiles(vms: Readonly<Record<string, VmState>>, tiles: readonly ComputerTile[], nameOf: (host: string) => string): ComputerTile[] {
  const out: ComputerTile[] = [];
  for (const [host, vm] of Object.entries(vms)) {
    if (tiles.some((t) => t.entry.host === host && t.computer === VM_COMPUTER)) continue;
    const row: ComputerSessionRow = { threadId: VM_COMPUTER, since: 0, lastCallAt: 0, apps: [{ name: "Windows VM", bundleId: null, window: null }], running: null, tier: null, computer: VM_COMPUTER, idle: true };
    out.push({
      id: tileId(host, VM_COMPUTER),
      entry: { host, row, previewable: false },
      title: "Windows VM",
      // its state is said once, in its picture's box (RestingVmPicture)
      doing: null,
      where: nameOf(host),
      driving: false,
      browser: false,
      pane: VM_COMPUTER,
      shownOn: null,
      computer: VM_COMPUTER,
      idle: true,
      vm,
    });
  }
  return out;
}
