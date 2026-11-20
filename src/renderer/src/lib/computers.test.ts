import { describe, expect, it } from "vitest";
import type { ComputerSessionRow } from "@server/shared/contract-computer";
import { macComputerKey } from "@server/shared/contract-maccomputer";
import { computerTiles, computersMark } from "./computers";
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

  it("marks the rail's row: waiting while a card needs him, working while anything is driven, nothing otherwise, and never a count", () => {
    expect(computersMark({})).toBeNull();
    expect(computersMark({ local: [], box: [] })).toBeNull();
    expect(computersMark({ local: [row({ threadId: "t1" })] })).toBe("working");
    expect(computersMark({ local: [row({ threadId: "t1" })], box: [row({ threadId: "b1", macPeer: "env_mac", asking: { line: "Allow TextEdit?" } })] })).toBe("waiting");
    // this Mac's own row of a session a box thread drives here is that thread's, counted once and never alone
    expect(computersMark({ local: [row({ threadId: macComputerKey(`env_${"b".repeat(22)}`, "b1") })] })).toBeNull();
  });
});
