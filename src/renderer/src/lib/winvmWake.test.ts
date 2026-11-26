import { describe, expect, it } from "vitest";
import type { WinvmState } from "@server/shared/contract-work-winvm";
import { displayOf, vmPlate, wakeCount, type VmState } from "./winvmWake";

const at = (state: VmState["state"], more: Partial<VmState> = {}): VmState => ({ state, cannot: null, error: null, ...more });
const plate = (vm: VmState, o: Partial<Parameters<typeof vmPlate>[1]> = {}) => vmPlate(vm, { wakes: false, now: 20_000, ...o });

describe("the VM's plate in each state", () => {
  it("asleep: since when; waking: its count against the usual wake; not set up: the bare box; a failed wake: Retry", () => {
    expect(plate(at("asleep"))).toMatchObject({ title: "Asleep", spin: false, bare: false });
    expect(plate(at("asleep", { since: new Date(2026, 10, 24, 13, 14).getTime() }), { now: new Date(2026, 10, 24, 15, 0).getTime() }).detail).toMatch(/^Since 1:14/);
    expect(plate(at("asleep", { wakeMs: 13_000 }), { wakes: true, since: 14_000 })).toEqual({ title: "Waking the Windows VM", detail: "6 s of about 13", spin: true, bare: false, retry: false });
    // the first wake after a box restart has no usual one to count against: its seconds alone
    expect(plate(at("waking", { since: 14_000 }))).toMatchObject({ title: "Waking the Windows VM", detail: "6 s", spin: true });
    expect(plate(at("none"))).toMatchObject({ title: "The Windows VM is not set up", bare: true });
    expect(plate(at("asleep"), { failed: "no door" })).toMatchObject({ title: "Couldn't wake the Windows VM", detail: "no door", retry: true });
  });

  it("the keeper's own work says its words, with no count: a restart, a move, going back to a point", () => {
    expect(plate(at("waking", { step: "Restarting Windows", wakeMs: 13_000, since: 1 }))).toMatchObject({ title: "Restarting Windows", detail: null, spin: true });
    expect(plate(at("waking", { step: "Copying Docket's helper into Windows", wakeMs: 13_000, since: 14_000 }))).toMatchObject({ title: "Waking the Windows VM", detail: "6 s of about 13" });
    expect(plate(at("asleep", { step: "Going back to Clean" }))).toMatchObject({ title: "Going back to Clean", spin: true });
    // the keeper's own wake after a restart of the box's service
    expect(plate(at("waking", { step: "Waking after an update…", since: 14_000 }))).toMatchObject({ title: "Waking after an update…", spin: true });
    expect(plate(at("awake"))).toMatchObject({ title: "Connecting", spin: true });
    expect(wakeCount(undefined, 13_000, 1)).toBeNull();
  });

  it("reads the host's screen choice once the keeper says it, and nothing before", () => {
    const base: WinvmState = { state: "awake", step: null, error: null, cannot: null, sleepAfter: "30m", since: 1 };
    expect(displayOf(base)).toBeNull();
    expect(displayOf({ ...base, display: { device: "virtio", width: 1920, height: 1200, scale: 100, fit: false, detail: "faster", canResize: true } })).toEqual({ screen: "1920x1200", detail: "faster", canResize: true });
    expect(displayOf({ ...base, display: { device: "virtio", width: 3456, height: 2234, scale: 200, fit: true, detail: "sharp", canResize: true } })).toEqual({ screen: "fit", detail: "sharp", canResize: true });
    // std VGA: Windows takes no new size while it runs, so the bar's rows are off with their own line
    expect(displayOf({ ...base, display: { device: "vga", width: 1280, height: 800, scale: 100, fit: false, detail: "sharp", canResize: false } })).toEqual({ screen: "1280x800", detail: "sharp", canResize: false });
  });
});
