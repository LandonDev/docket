import { describe, expect, it, vi } from "vitest";
import type { ComputerSessionRow } from "@server/shared/contract-computer";
import { macComputerKey } from "@server/shared/contract-maccomputer";
import { canTakeOver, computerTiles, viewKey, computersMark, driveName, findComputer, handBack, takeOver, tileKey } from "./computers";
import { restingVm, restingVmTiles, type VmState } from "./winvmWake";
import { registry } from "./connection/registry";
import { BOX_BROWSER_BUNDLE } from "./computerSessions";

const row = (over: Partial<ComputerSessionRow> & { threadId: string }): ComputerSessionRow => ({
  since: 1,
  lastCallAt: 1,
  apps: [{ name: "TextEdit", bundleId: "com.apple.TextEdit", window: "Untitled" }],
  running: null,
  tier: "ax",
  ...over,
});
const chromium = [{ name: "Chromium", bundleId: BOX_BROWSER_BUNDLE, window: "Concur" }];
const titles: Record<string, string> = { "local\nt1": "Fix the invoice", "box\nb1": "File the expense report", "box\nb2": "Book the room" };
const titleOf = (host: string, thread: string): string | null => titles[`${host}\n${thread}`] ?? null;
const nameOf = (host: string): string => (host === "local" ? "this Mac" : "The box");
const mac = { desktop: true, localId: "env_mac" };

describe("every computer being driven now", () => {
  it("is one tile for each live session on every host, the one that acted last first, joined to its thread's title", () => {
    const tiles = computerTiles(
      {
        local: [row({ threadId: "t1", lastCallAt: 5, running: { tool: "computer_click", words: "Clicking Save in TextEdit", startedAt: 5 } })],
        box: [row({ threadId: "b1", lastCallAt: 9, apps: chromium }), row({ threadId: "b2", lastCallAt: 2, apps: chromium })],
      },
      titleOf,
      nameOf,
      mac,
    );
    expect(tiles.map((t) => [t.id, t.title, t.where, t.doing])).toEqual([
      ["box\nb1", "File the expense report", "The box", null],
      ["local\nt1", "Fix the invoice", "this Mac", "Clicking Save in TextEdit"],
      ["box\nb2", "Book the room", "The box", null],
    ]);
    // this Mac draws its own windows and the box's browser
    expect(tiles.every((t) => t.entry.previewable && t.shownOn === null)).toBe(true);
    expect(tiles.map((t) => t.browser)).toEqual([true, false, true]);
    expect(tiles[0].entry).toMatchObject({ previewHost: "box", previewKey: "b1" });
  });

  it("keeps a page he drives as a tile that says so, with nothing running", () => {
    const [tile] = computerTiles({ box: [row({ threadId: "b1", apps: chromium, driver: "owner", running: { tool: "x", words: "stale", startedAt: 1 } })] }, titleOf, nameOf, mac);
    expect(tile).toMatchObject({ driving: true, doing: null, browser: true });
  });

  it("names the machine that alone draws a session this desktop may not", () => {
    // a box thread driving another Mac's window: only that Mac draws it
    const [other] = computerTiles({ box: [row({ threadId: "b1", macPeer: "env_studio", macName: "Studio" })] }, titleOf, nameOf, mac);
    expect(other).toMatchObject({ where: "Studio", shownOn: "Studio", browser: false });
    expect(other.entry.previewable).toBe(false);
    // the browser /ui draws no picture at all
    const web = computerTiles({ box: [row({ threadId: "b1", apps: chromium })] }, titleOf, nameOf, { desktop: false, localId: null });
    expect(web[0].shownOn).toBe("The box");
  });

  it("shows a session a box thread drives on this Mac once, as the box's thread, drawn here", () => {
    const box = `env_${"b".repeat(22)}`;
    const tiles = computerTiles(
      {
        [box]: [row({ threadId: "b1", macPeer: "env_mac", macName: "Landon's MacBook" })],
        // this Mac's own push carries the same session under the bridge's key
        local: [row({ threadId: macComputerKey(box, "b1") })],
      },
      () => "File the expense report",
      nameOf,
      mac,
    );
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ id: `${box}\nb1`, title: "File the expense report", where: "Landon's MacBook", shownOn: null });
    expect(tiles[0].entry).toMatchObject({ previewHost: "local", previewKey: macComputerKey(box, "b1") });
  });

  it("falls back to the window's name for a thread the store does not hold, and is empty when nothing is driven", () => {
    expect(computerTiles({ local: [row({ threadId: "gone" })] }, titleOf, nameOf, mac)[0].title).toBe("Untitled");
    expect(computerTiles({ local: [row({ threadId: "gone", apps: [{ name: "Notes", bundleId: null, window: null }] })] }, titleOf, nameOf, mac)[0].title).toBe("Notes");
    expect(computerTiles({ local: [], box: [] }, titleOf, nameOf, mac)).toEqual([]);
  });

  it("gives each tile the thread whose pane holds its browser, so Take over is asked of the pane", () => {
    const tiles = computerTiles({ box: [row({ threadId: "sub", apps: chromium })] }, titleOf, nameOf, mac, (id) => (id === "sub" ? "root" : id));
    expect(tiles[0].pane).toBe("root");
  });

  it("keeps a pane's one browser page the same tile when its row moves from the thread that drove it to the pane's own", () => {
    const paneOf = (id: string): string => (id === "sub" ? "root" : id);
    const before = computerTiles({ box: [row({ threadId: "sub", apps: chromium })] }, titleOf, nameOf, mac, paneOf);
    const after = computerTiles({ box: [row({ threadId: "root", apps: chromium, driver: "owner" })] }, titleOf, nameOf, mac, paneOf);
    expect(before[0].id).not.toBe(after[0].id);
    expect(tileKey(before[0], before)).toBe(tileKey(after[0], after));
    // two pages of one pane are two tiles, each its thread's; a window that is no browser page is its thread's
    const two = computerTiles({ box: [row({ threadId: "sub", apps: chromium }), row({ threadId: "root", apps: chromium })] }, titleOf, nameOf, mac, paneOf);
    expect(two.map((t) => tileKey(t, two)).sort()).toEqual(two.map((t) => t.id).sort());
    const window = computerTiles({ local: [row({ threadId: "t1" })] }, titleOf, nameOf, mac);
    expect(tileKey(window[0], window)).toBe(window[0].id);
  });

  it("finds the page a full view was opened on after Take over moved its row to the pane's thread", () => {
    const paneOf = (id: string): string => (id === "sub" ? "root" : id);
    const before = computerTiles({ box: [row({ threadId: "sub", apps: chromium })] }, titleOf, nameOf, mac, paneOf);
    const after = computerTiles({ box: [row({ threadId: "root", apps: chromium, driver: "owner" })] }, titleOf, nameOf, mac, paneOf);
    expect(findComputer(before, "box", "sub", "root")).toBe(before[0]);
    expect(findComputer(after, "box", "sub", "root")).toBe(after[0]);
    // another pane's page, another host's, and a window that is no browser page are not it
    expect(findComputer(after, "box", "b2", "b2")).toBeNull();
    expect(findComputer(after, "local", "sub", "root")).toBeNull();
    expect(findComputer(computerTiles({ box: [row({ threadId: "root" })] }, titleOf, nameOf, mac, paneOf), "box", "sub", "root")).toBeNull();
  });

  it("takes over and hands back in one call each, naming the pane's page: the host stops what drove it", async () => {
    const calls: unknown[] = [];
    const spy = vi.spyOn(registry, "link").mockImplementation(() => ({ request: async (method: string, params: unknown) => void calls.push([method, params]) }) as never);
    const paneOf = (id: string): string => (id === "sub" ? "root" : id);
    const tiles = computerTiles({ box: [row({ threadId: "sub", apps: chromium }), row({ threadId: "b2", apps: chromium })] }, titleOf, nameOf, mac, paneOf);
    const tile = tiles.find((t) => t.pane === "root")!;
    expect(driveName(tile)).toBe("browser:root");
    await takeOver(tile);
    await handBack(tile);
    expect(calls).toEqual([
      ["computer.drive", { computer: "browser:root", driver: "owner" }],
      ["computer.drive", { computer: "browser:root", driver: "agent" }],
    ]);
    spy.mockRestore();
  });

  it("names each tile's computer, and says when nothing drives it", () => {
    const tiles = computerTiles({ box: [row({ threadId: "w1", apps: chromium, computer: "browser:w1", idle: true })], local: [row({ threadId: "t1" })] }, titleOf, nameOf, mac);
    expect(tiles.map((t) => [t.computer, t.idle])).toEqual(
      expect.arrayContaining([
        ["browser:w1", true],
        ["window:t1", false],
      ]),
    );
  });

  it("marks the rail's row: waiting while a card needs him, working while anything is driven, nothing otherwise, and never a count", () => {
    expect(computersMark({})).toBeNull();
    // the box's page after its last act is listed, and is not working
    expect(computersMark({ box: [row({ threadId: "w1", apps: chromium, idle: true })] })).toBeNull();
    expect(computersMark({ local: [], box: [] })).toBeNull();
    expect(computersMark({ local: [row({ threadId: "t1" })] })).toBe("working");
    expect(computersMark({ local: [row({ threadId: "t1" })], box: [row({ threadId: "b1", macPeer: "env_mac", asking: { line: "Allow TextEdit?" } })] })).toBe("waiting");
    // this Mac's own row of a session a box thread drives here is that thread's, counted once and never alone
    expect(computersMark({ local: [row({ threadId: macComputerKey(`env_${"b".repeat(22)}`, "b1") })] })).toBeNull();
  });
});

describe("the Windows VM", () => {
  const vm = (over: Partial<ComputerSessionRow> = {}): ComputerSessionRow => row({ threadId: "vm:windows", apps: [{ name: "Windows VM", bundleId: null, window: null }], tier: null, computer: "vm:windows", idle: true, ...over });

  it("is one tile titled by its own name while no thread holds it, its picture asked for by its name, and not working", () => {
    const [tile] = computerTiles({ box: [vm()] }, titleOf, nameOf, mac);
    expect(tile).toMatchObject({ title: "Windows VM", where: "The box", computer: "vm:windows", browser: false, idle: true });
    expect(tile.entry).toMatchObject({ previewable: true, previewHost: "box", previewKey: "vm:windows" });
    expect(canTakeOver(tile)).toBe(true);
    expect(computersMark({ box: [vm()] })).toBeNull();
  });

  it("is titled by the thread that holds it, and keeps its picture's name", () => {
    const [tile] = computerTiles({ box: [vm({ threadId: "b1", idle: undefined })] }, titleOf, nameOf, mac);
    expect(tile.title).toBe("File the expense report");
    expect(tile.entry.previewKey).toBe("vm:windows");
    expect(computersMark({ box: [vm({ threadId: "b1", idle: undefined })] })).toBe("working");
  });

  it("is one tile and one view through his Take over: the thread its row is listed under changes, its name does not", () => {
    const [byThread] = computerTiles({ box: [vm({ threadId: "b1", idle: undefined })] }, titleOf, nameOf, mac);
    const [his] = computerTiles({ box: [vm({ driver: "owner", idle: undefined })] }, titleOf, nameOf, mac);
    expect(tileKey(byThread, [byThread])).toBe(tileKey(his, [his]));
    expect(viewKey(byThread)).toBe("vm:windows");
    expect(findComputer([his], "box", "vm:windows", "vm:windows")).toBe(his);
    expect(findComputer([his], "local", "vm:windows", "vm:windows")).toBeNull();
    expect(his.driving).toBe(true);
  });

  it("offers no Take over with no window of its own", () => {
    const [tile] = computerTiles({ box: [vm({ pictureOnly: true })] }, titleOf, nameOf, mac);
    expect(tile.pictureOnly).toBe(true);
    expect(canTakeOver(tile)).toBe(false);
  });

  const at = (state: VmState["state"]): VmState => ({ state, cannot: null, error: null });

  it("is a tile in every state: drawn from its state, under the key its live tile has, while it has no row", () => {
    const [asleep] = restingVmTiles({ box: at("asleep") }, [], nameOf);
    const [live] = computerTiles({ box: [vm()] }, titleOf, nameOf, mac);
    expect(asleep).toMatchObject({ title: "Windows VM", where: "The box", computer: "vm:windows", idle: true, doing: null, vm: at("asleep") });
    expect(tileKey(asleep, [asleep])).toBe(tileKey(live, [live]));
    // no stream is asked for it
    expect(asleep.entry.previewable).toBe(false);
    // its row is there: the live tile alone
    expect(restingVmTiles({ box: at("awake") }, [live], nameOf)).toEqual([]);
    // awake before its row came: still a tile, waking
    expect(restingVmTiles({ box: at("awake") }, [], nameOf)[0].vm?.state).toBe("awake");
    expect(restingVm(at("awake"))).toMatchObject({ line: "Waking the Windows VM", busy: true, wakes: false });
  });

  it("says its state in words, and only an asleep or sleeping one is woken by the stage", () => {
    expect(restingVm(at("asleep"))).toEqual({ line: "Asleep", busy: false, wakes: true });
    expect(restingVm(at("going-to-sleep"))).toMatchObject({ busy: true, wakes: true });
    expect(restingVm(at("none"))).toEqual({ line: "Not set up: Settings → Work → Windows VM", busy: false, wakes: false });
    expect(restingVm(at("setting-up"))).toMatchObject({ line: "Setting up the Windows VM", wakes: false });
  });

  it("offers Take over asleep, going to sleep or waking, and none while it is not set up or sets up", () => {
    const offered = (state: VmState["state"]) => canTakeOver(restingVmTiles({ box: at(state) }, [], nameOf)[0]);
    expect(["asleep", "going-to-sleep", "waking", "awake"].map((s) => offered(s as VmState["state"]))).toEqual([true, true, true, true]);
    expect(offered("none")).toBe(false);
    expect(offered("setting-up")).toBe(false);
  });

  it("is woken by Take over before the wheel is asked for, so one press takes over whatever its state", async () => {
    const calls: string[] = [];
    vi.spyOn(registry, "link").mockReturnValue({ request: async (method: string) => void calls.push(method) } as never);
    await takeOver(restingVmTiles({ box: at("asleep") }, [], nameOf)[0]);
    expect(calls).toEqual(["work.winvm.wake", "computer.drive"]);
    vi.restoreAllMocks();
  });
});

