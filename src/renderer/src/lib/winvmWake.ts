import { useEffect, useState } from "react";
import type { WinvmDetail, WinvmScreen, WinvmState, WinvmStateName } from "@server/shared/contract-work-winvm";
import { registry } from "./connection/registry";
import { dayTime } from "./duration";
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
  /** what it is doing now, in the keeper's words; null when settled */
  step?: string | null;
  /** when `state` last changed */
  since?: number;
  /** the usual wake, in ms: the keeper's median of its last five; null before one */
  wakeMs?: number | null;
  /** asleep by a person's Sleep: the page waits for his Wake */
  heldAsleep?: boolean;
  /** the screen's choice, for the bar's Size and Detail; null where the host does not say it */
  display?: VmDisplay | null;
}

/** The bar's Size: Fit to window, or one fixed size of the guest's pixels. */
export const VM_SCREEN_PICKS = ["fit", "1280x800", "1920x1200", "2560x1600"] as const satisfies readonly WinvmScreen[];
export type VmScreenPick = WinvmScreen;
export type VmDetail = WinvmDetail;
/** What the bar's Size and Detail rows read: the host's choice, and whether Windows takes a new size now (live resize). */
export interface VmDisplay {
  screen: VmScreenPick;
  detail: VmDetail;
  canResize: boolean;
}

/** The bar's Size and Detail from the keeper's `WinvmState.display`; a host that does not say it (before live resize) has no Size or Detail. */
export function displayOf(s: WinvmState): VmDisplay | null {
  const d = s.display;
  if (!d) return null;
  const fixed = `${d.width}x${d.height}`;
  const screen: VmScreenPick = d.fit ? "fit" : ((VM_SCREEN_PICKS as readonly string[]).includes(fixed) ? fixed : "fit") as VmScreenPick;
  return { screen, detail: d.detail === "faster" ? "faster" : "sharp", canResize: d.canResize };
}

const vmOf = (s: WinvmState): VmState => ({
  state: s.state,
  cannot: s.cannot ?? null,
  error: s.error ?? null,
  step: s.step ?? null,
  since: s.since,
  wakeMs: s.wakeMs ?? null,
  heldAsleep: s.heldAsleep === true,
  display: displayOf(s),
});
const same = (a: VmState | undefined, b: VmState): boolean =>
  !!a &&
  a.state === b.state &&
  a.cannot === b.cannot &&
  a.error === b.error &&
  a.step === b.step &&
  a.since === b.since &&
  a.wakeMs === b.wakeMs &&
  a.heldAsleep === b.heldAsleep &&
  JSON.stringify(a.display) === JSON.stringify(b.display);

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

/** The keeper's own words while it wakes the machine: the plate says "Waking the Windows VM" through all of them. */
const WAKE_STEPS: ReadonlySet<string> = new Set([WAKING_LINE, "Copying TempCode's helper into Windows"]);

/** What the VM's picture says while it has nothing live: its plate's words (Viewport.tsx `Plate`). */
export interface VmPlateWords {
  title: string;
  detail: string | null;
  spin: boolean;
  /** no picture to keep under it: the plate on the bare box */
  bare: boolean;
  /** a failed wake: Retry asks again */
  retry: boolean;
}

/**
 * "6 s of about 13": the seconds this wake has taken, against the usual (the keeper's median of its last five); "6 s"
 * before the keeper has one (it keeps them in memory, so the first wake after a box restart has none).
 */
export function wakeCount(since: number | undefined, wakeMs: number | null | undefined, now: number): string | null {
  if (since === undefined) return null;
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  return wakeMs ? `${secs} s of about ${Math.round(wakeMs / 1000)}` : `${secs} s`;
}

/**
 * The VM's plate in every state it has no live picture (docs/DESIGN.md "Computers", "The faces"). `wakes`: the stage
 * asked it awake (asleep there and not held by his own Sleep); `since` is when that ask began, for its count.
 */
export function vmPlate(vm: VmState, o: { wakes: boolean; now: number; failed?: string | null; since?: number }): VmPlateWords {
  const plate = (title: string, more: Partial<VmPlateWords> = {}): VmPlateWords => ({ title, detail: null, spin: false, bare: false, retry: false, ...more });
  if (o.failed) return plate("Couldn't wake the Windows VM", { detail: o.failed, retry: true });
  const counting = (since: number | undefined): VmPlateWords => plate(WAKING_LINE, { spin: true, detail: wakeCount(since, vm.wakeMs, o.now) });
  switch (vm.state) {
    case "none":
      return plate("The Windows VM is not set up", { bare: true });
    case "setting-up":
      return plate(vm.step ?? "Setting up the Windows VM", { spin: true, bare: true });
    case "asleep":
      if (o.wakes) return counting(o.since);
      // a step while asleep: going back to a restore point
      if (vm.step) return plate(vm.step, { spin: true });
      return plate("Asleep", { detail: vm.since ? `Since ${dayTime(vm.since, o.now)}` : null });
    case "waking":
      // the keeper's own work under the wake's name (a restart, a move to live resize) says itself, with no count
      return vm.step && !WAKE_STEPS.has(vm.step) ? plate(vm.step, { spin: true }) : counting(vm.since);
    case "going-to-sleep":
      return o.wakes ? counting(o.since) : plate(vm.step ?? "Going to sleep", { spin: true });
    case "awake":
      // awake before its row came: the stream is about to open
      return plate("Connecting", { spin: true });
  }
}

/** Wakes the host's VM; it answers once the VM is awake, or with the keeper's own cause (its deadline is the keeper's: transport.ts). */
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
