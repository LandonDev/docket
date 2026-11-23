// @vitest-environment jsdom
/**
 * The digest's list (docs/DESIGN.md "The digest") over two hosts that
 * answer from memory: sections by day, the empty state, a host that did
 * not answer, and a row's press.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../lib/connection", async (original) => {
  const kit = await import("./world.testkit");
  world.current = kit.makeWorld();
  return kit.connectionMock(world.current as import("./world.testkit").World, await original<object>());
});

import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { DigestSheet, unansweredLine } from "./DigestSheet";
import { digestNow, loadDigest, mergeDays, mergeRows, resetDigestStore, useDigest } from "./store";
import { push, resetWorld, tell, type World } from "./world.testkit";

const w = (): World => world.current as World;
const at = (day: number, h: number, m = 0): number => new Date(2026, 10, day, h, m).getTime();
const NOW = at(24, 10);

function Sheet({ onOpenRow = () => {}, onOpenChange = () => {} }: { onOpenRow?: (row: unknown) => void; onOpenChange?: (open: boolean) => void }) {
  const view = useDigest();
  return <DigestSheet open onOpenChange={onOpenChange} view={view} now={NOW} onOpenRow={onOpenRow} />;
}

beforeEach(() => {
  resetWorld(w());
  resetDigestStore();
  setWorkOn("box", true);
  setWorkOn("mac", true);
});
afterEach(() => {
  cleanup();
  workSwitch.reset();
});

describe("the list", () => {
  it("shows a skeleton in the rows' shape until the hosts have answered, then sections by day with each row's job, words and time", async () => {
    w().days.set("box", [{ day: "2026-11-24", madeAt: at(24, 8), seenAt: null, count: 2 }, { day: "2026-11-23", madeAt: at(23, 8), seenAt: 5, count: 1 }]);
    w().rows.set("box", [
      tell({ title: "Receipts to confirm", detail: "3 from Friday", sector: "ref", at: at(24, 9, 15) }),
      tell({ title: "Morning summary", detail: "Done in 12m", day: "2026-11-24", how: "digest", open: { thread: "t1" } }),
      tell({ title: "Held: Invite Dana Reyes to Budget review", sector: "purdue", day: "2026-11-24", how: "digest", by: at(26, 14), open: { held: { at: "host", id: "h1" } } }),
      tell({ title: "Sign-in to Frame.io ends in 14 days", sector: null, workspaceId: null, day: "2026-11-23", how: "digest", at: at(23, 6) }),
    ]);
    // Before any host has answered: rows in their shape, no words.
    const waiting = render(<DigestSheet open onOpenChange={() => {}} view={{ days: [], rows: [], settings: null, loaded: false, errors: [] }} now={NOW} onOpenRow={() => {}} />);
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    expect(screen.queryByText("Nothing waited")).toBeNull();
    waiting.unmount();
    render(<Sheet />);
    await waitFor(() => expect(screen.queryByLabelText("Loading")).toBeNull());
    expect(await screen.findByRole("heading", { name: "Digest" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Since the digest", "Today, 8:00 AM", "Yesterday"]);
    const today = within(screen.getByRole("region", { name: "Today, 8:00 AM" }));
    // by job, then newest: Cosmic before Purdue
    expect(today.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Morning summaryDone in 12m7:30 AM", "Held: Invite Dana Reyes to Budget reviewby Nov 26, 2:00 PM"]);
    // the job's dot is each row's only colour
    expect(today.getAllByRole("listitem").map((li) => li.querySelector("[data-sector]")?.getAttribute("data-sector"))).toEqual(["cosmic", "purdue"]);
    // a row with nowhere to go is not a button
    const yesterday = within(screen.getByRole("region", { name: "Yesterday" }));
    expect(yesterday.queryByRole("button")).toBeNull();
    expect(yesterday.getByText("Sign-in to Frame.io ends in 14 days")).toBeTruthy();
    // nothing counts beside the title, and no row carries a chip
    expect(screen.getByRole("heading", { name: "Digest" }).textContent).toBe("Digest");
  });

  it("a row's press hands the row over: its target opens and the sheet closes", async () => {
    w().rows.set("box", [tell({ title: "Morning summary", open: { thread: "t1" } })]);
    const opened: unknown[] = [];
    render(<Sheet onOpenRow={(row) => opened.push(row)} />);
    fireEvent.click(await screen.findByRole("button", { name: /Morning summary/ }));
    expect(opened).toMatchObject([{ title: "Morning summary", open: { thread: "t1" } }]);
  });

  it("with nothing told it is one empty state, and no section", async () => {
    render(<Sheet />);
    expect(await screen.findByText("Nothing waited")).toBeTruthy();
    expect(screen.getByText("Work has had nothing to tell you since Oct 25.")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("a host that did not answer is one muted line at the foot with Retry, under what the other host holds", async () => {
    w().down.add("mac");
    w().rows.set("box", [tell({ title: "Morning summary" })]);
    render(<Sheet />);
    expect(await screen.findByText("The Mac did not answer")).toBeTruthy();
    expect(screen.getByText("Morning summary")).toBeTruthy();
    w().down.delete("mac");
    w().rows.set("mac", [tell({ host: "mac", title: "Thumbnail review is ready", sector: "hypixel" })]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Thumbnail review is ready")).toBeTruthy();
    expect(screen.queryByText("The Mac did not answer")).toBeNull();
  });

  it("with no host answering it does not claim that nothing waited", async () => {
    w().down.add("mac");
    w().down.add("box");
    render(<Sheet />);
    expect(await screen.findByText("The digest did not load")).toBeTruthy();
    expect(screen.getByText("The box and The Mac did not answer.")).toBeTruthy();
    expect(screen.queryByText("Nothing waited")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("the store", () => {
  it("one thing two hosts tell under one key is one row, the one he was told of at once; hosts' days of one date are one day, seen once any is", async () => {
    w().rows.set("box", [tell({ key: "clash:1", title: "A clash", at: 5 }), tell({ id: "same", title: "box's own" })]);
    w().rows.set("mac", [tell({ host: "mac", key: "clash:1", title: "A clash", at: 9, how: "now", toldAt: 9 }), tell({ host: "mac", id: "same", title: "mac's own" })]);
    w().days.set("box", [{ day: "2026-11-24", madeAt: 100, seenAt: null, count: 1 }]);
    w().days.set("mac", [{ day: "2026-11-24", madeAt: 90, seenAt: 95, count: 2 }]);
    await loadDigest();
    const view = digestNow();
    expect(view.rows.filter((r) => r.key === "clash:1")).toMatchObject([{ host: "mac", how: "now" }]);
    expect(view.rows.map((r) => r.title).sort()).toEqual(["A clash", "box's own", "mac's own"]);
    expect(view.days).toEqual([{ day: "2026-11-24", madeAt: 90, seenAt: 95, hosts: ["box", "mac"] }]);
    expect(mergeRows([[tell({ key: "k", at: 1 })], [tell({ key: "k", at: 2, host: "mac" })]])).toMatchObject([{ host: "mac" }]);
    expect(mergeDays([])).toEqual([]);
  });
  it("keeps the push: a row told, a row gone, a day seen", async () => {
    w().rows.set("box", [tell({ id: "a", title: "First" })]);
    w().days.set("box", [{ day: "2026-11-24", madeAt: 100, seenAt: null, count: 1 }]);
    await loadDigest();
    push(w(), "box", { row: tell({ id: "b", title: "Second" }) });
    expect(digestNow().rows.map((r) => r.title).sort()).toEqual(["First", "Second"]);
    push(w(), "box", { gone: "a" });
    expect(digestNow().rows.map((r) => r.title)).toEqual(["Second"]);
    push(w(), "box", { day: { day: "2026-11-24", madeAt: 100, seenAt: 200, count: 1 } });
    expect(digestNow().days[0]!.seenAt).toBe(200);
  });
  it("says which hosts did not answer, in words", () => {
    expect(unansweredLine([])).toBe("");
    expect(unansweredLine(["The Mac"])).toBe("The Mac did not answer");
    expect(unansweredLine(["The box", "The Mac", "The PC"])).toBe("The box, The Mac and The PC did not answer");
  });
});
