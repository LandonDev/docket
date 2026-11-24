// @vitest-environment jsdom
/**
 * The digest on the desktop over two hosts that answer from memory: the
 * two toasts, what a press opens, the system notifications, and the port
 * Today registers.
 */
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../lib/connection", async (original) => {
  const kit = await import("./world.testkit");
  world.current = kit.makeWorld();
  return kit.connectionMock(world.current as import("./world.testkit").World, await original<object>());
});

type Shown = { id: string; kind: "plain" | "warning"; text: string; description?: string; action: () => void; dismiss: () => void };
const toasts = vi.hoisted(() => ({ shown: new Map<string, unknown>(), errors: [] as string[] }));
const files = vi.hoisted(() => ({ open: null as null | ((...a: unknown[]) => Promise<void>) }));
vi.mock("../files/openFrom", () => ({ openInFiles: (...a: unknown[]) => files.open!(...a) }));
vi.mock("../../components/ui/toaster", async (original) => {
  const show =
    (kind: "plain" | "warning") =>
    (text: string, o: { id: string; description?: string; duration: number; closeButton: boolean; action: { label: string; onClick: () => void }; onDismiss: () => void }) => {
      toasts.shown.set(o.id, { id: o.id, kind, text, description: o.description, action: o.action.onClick, dismiss: o.onDismiss, sticky: o.duration === Infinity && o.closeButton, label: o.action.label });
    };
  const api = Object.assign(show("plain"), {
    warning: show("warning"),
    error: (text: string) => void toasts.errors.push(text),
    // as sonner: taking a toast away calls its onDismiss too
    dismiss: (id: string) => {
      const had = toasts.shown.get(id) as { dismiss: () => void } | undefined;
      toasts.shown.delete(id);
      had?.dismiss();
    },
  });
  return { ...(await original<object>()), loadToast: () => Promise.resolve(api) };
});
const bridge = vi.hoisted(() => ({ show: vi.fn(async () => {}), close: vi.fn(async () => {}), onOpen: vi.fn(() => () => {}) }));
vi.mock("../../lib/native", async (original) => ({ ...(await original<object>()), systemNotice: bridge }));
const workspaces = vi.hoisted(() => ({ list: [] as unknown[], entered: [] as string[] }));
vi.mock("../../lib/tcserver/workspaces", async (original) => ({ ...(await original<object>()), useWorkspaces: () => workspaces.list }));
vi.mock("../../stores/project", async (original) => ({ ...(await original<object>()), project: { enterWorkspace: (path: string) => void workspaces.entered.push(path) } }));

import { OPEN_SETTINGS_EVENT } from "../../lib/monaco/debugTab";
import { choose, digestOpensPort, openWorkView, setWorkOn, workOpenPort, workSwitch, workViewNow } from "../../lib/workSwitch";
import { shell, shellStore } from "../../stores/shell";
import { WORK_PLACE_ROWS } from "../../lib/workPlaces";
import { useWorkPlaceAt } from "../../lib/workPlaceAt";
import { DigestHost, digestOpens, resetDismissed } from "./DigestHost";
import { loadDigest, resetDigestStore } from "./store";
import { push, reopen, resetWorld, tell, type World } from "./world.testkit";

const w = (): World => world.current as World;
const shown = (): Shown[] => [...toasts.shown.values()] as Shown[];
const at = (day: number, h: number, m = 0): number => new Date(2026, 10, day, h, m).getTime();

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
async function mount() {
  // As when the chunk lands: each host with Work on is read.
  await loadDigest();
  const view = render(<DigestHost />);
  await settle();
  await settle();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(24, 10));
  resetWorld(w());
  resetDigestStore();
  resetDismissed();
  toasts.shown.clear();
  workspaces.list = [];
  workspaces.entered = [];
  WORK_PLACE_ROWS.length = 0;
  shell.openWorkPlace(null);
  shell.closeOutbox();
  shell.closeSettings();
  bridge.show.mockClear();
  bridge.close.mockClear();
  bridge.onOpen.mockClear();
  setWorkOn("box", true);
  setWorkOn("mac", true);
});
afterEach(() => {
  cleanup();
  digestOpensPort.set(null);
  workOpenPort.set(null);
  workSwitch.reset();
  vi.useRealTimers();
});

describe("the digest's toast", () => {
  const day = { day: "2026-11-24", madeAt: at(24, 8), seenAt: null, count: 2 };
  beforeEach(() => {
    w().days.set("box", [day]);
    w().days.set("mac", [{ ...day, count: 1 }]);
    w().rows.set("box", [tell({ day: "2026-11-24", how: "digest" }), tell({ day: "2026-11-24", how: "digest", sector: "purdue" })]);
    w().rows.set("mac", [tell({ host: "mac", day: "2026-11-24", how: "digest", sector: "ref" })]);
  });

  it("is one toast for two hosts' same day, sticky, with Open", async () => {
    await mount();
    expect(shown()).toMatchObject([{ id: "work-digest", kind: "plain", text: "Digest: 3 things in Cosmic, Purdue and Ref", sticky: true, label: "Open" }]);
    // and one silent system notification, for a person looking at another app
    expect(bridge.show).toHaveBeenCalledWith({ key: "digest:2026-11-24", title: "Work", body: "Digest: 3 things in Cosmic, Purdue and Ref", silent: true });
  });

  it("opens the digest's own list while no page is registered, and every host hears the day was seen", async () => {
    await mount();
    await act(async () => shown()[0]!.action());
    expect(await screen.findByRole("heading", { name: "Digest" })).toBeTruthy();
    const seen = w().calls.filter((c) => c.method === "work.digest.seen").map((c) => [c.env, c.params.day]);
    expect(seen).toEqual([
      ["box", "2026-11-24"],
      ["mac", "2026-11-24"],
    ]);
    // seen: the toast and its system notification are gone
    await waitFor(() => expect(shown()).toEqual([]));
    expect(bridge.close).toHaveBeenCalledWith("digest:2026-11-24");
  });

  it("opens Today once its row is on the rail, though nobody registered a page, and the list until then", async () => {
    await mount();
    expect(digestOpens()).toBeNull();
    WORK_PLACE_ROWS.push({ id: "today", label: "Today", order: 10, icon: (() => null) as never });
    await act(async () => shown()[0]!.action());
    expect(shellStore.getState().workPlace).toBe("today");
    expect(screen.queryByRole("heading", { name: "Digest" })).toBeNull();
  });

  it("opens Today once Today has registered its page, and not the list", async () => {
    const today = vi.fn();
    digestOpensPort.set(today);
    await mount();
    await act(async () => shown()[0]!.action());
    expect(today).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Digest" })).toBeNull();
    expect(w().calls.filter((c) => c.method === "work.digest.seen")).toHaveLength(2);
  });

  it("opens the list, not Today, when Today has no row for something it counts: tomorrow's prep", async () => {
    w().rows.set("box", [tell({ day: "2026-11-24", how: "digest" }), tell({ day: "2026-11-24", how: "digest", kind: "prep.ready", group: "meetings", title: "Prep is ready" })]);
    w().rows.set("mac", []);
    const today = vi.fn();
    digestOpensPort.set(today);
    await mount();
    await act(async () => shown()[0]!.action());
    expect(today).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Digest" })).toBeTruthy();
  });

  it("opens the list, not Today, when it counts two weeks' reviews: Today draws the newest alone", async () => {
    w().rows.set("box", [
      tell({ day: "2026-11-24", how: "digest", kind: "review.ready", group: "review", title: "Last week's review is ready", key: "review:1", open: { place: "review", at: "1" } }),
      tell({ day: "2026-11-24", how: "digest", kind: "review.ready", group: "review", title: "This week's review is ready", key: "review:2", open: { place: "review", at: "2" } }),
    ]);
    w().rows.set("mac", []);
    const today = vi.fn();
    digestOpensPort.set(today);
    await mount();
    await act(async () => shown()[0]!.action());
    expect(today).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Digest" })).toBeTruthy();
  });

  it("opens the list, not Today, when a day before today is unseen too: Today shows today alone, and every day is marked seen", async () => {
    const before = { day: "2026-11-23", madeAt: at(23, 8), seenAt: null, count: 1 };
    w().days.set("box", [day, before]);
    w().rows.set("box", [tell({ day: "2026-11-24", how: "digest" }), tell({ day: "2026-11-23", how: "digest", sector: "ref", title: "Saturday's crews" })]);
    const today = vi.fn();
    digestOpensPort.set(today);
    await mount();
    await act(async () => shown()[0]!.action());
    expect(today).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Digest" })).toBeTruthy();
    expect(screen.getByText("Saturday's crews")).toBeTruthy();
    expect(w().calls.filter((c) => c.method === "work.digest.seen").map((c) => c.params.day).sort()).toContain("2026-11-23");
  });

  it("is gone when the day is seen anywhere: a phone's press reaches this window as a push", async () => {
    await mount();
    expect(shown()).toHaveLength(1);
    await act(async () => push(w(), "box", { day: { ...day, seenAt: 99 } }));
    await waitFor(() => expect(shown()).toEqual([]));
  });

  it("closed is seen: it does not come back", async () => {
    await mount();
    await act(async () => shown()[0]!.dismiss());
    expect(w().calls.filter((c) => c.method === "work.digest.seen")).toHaveLength(2);
  });

  it("a toast whose words changed while it was shown still closes for good: a second host's day arrives, then he closes it", async () => {
    w().days.set("mac", []);
    w().rows.set("mac", []);
    await mount();
    expect(shown()[0]!.text).toBe("Digest: 2 things in Cosmic and Purdue");
    // the Mac's day lands a moment later: the same toast, new words
    w().rows.set("mac", [tell({ host: "mac", day: "2026-11-24", how: "digest", sector: "ref" })]);
    w().days.set("mac", [{ ...day, count: 1 }]);
    await act(async () => push(w(), "mac", { day: { ...day, count: 1 } }));
    await waitFor(() => expect(shown()[0]?.text).toBe("Digest: 3 things in Cosmic, Purdue and Ref"));
    await act(async () => shown()[0]!.dismiss());
    expect(w().calls.filter((c) => c.method === "work.digest.seen").map((c) => c.env)).toContain("box");
  });

  it("an empty ledger shows nothing at all", async () => {
    resetWorld(w());
    await mount();
    expect(shown()).toEqual([]);
    expect(bridge.show).not.toHaveBeenCalled();
  });
});

describe("the zone the digest's time is kept in", () => {
  const said = () => w().calls.filter((c) => c.method === "work.digest.here").map((c) => c.env).sort();
  it("is said by the window he comes to, to every host with Work on", async () => {
    await mount();
    w().calls.length = 0;
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(said()).toEqual(["box", "mac"]);
  });
  it("is not said by a window in the background when its link comes back", async () => {
    await mount();
    const focus = vi.spyOn(document, "hasFocus");
    try {
      focus.mockReturnValue(false);
      w().calls.length = 0;
      act(() => reopen(w(), "box"));
      expect(said()).toEqual([]);
      focus.mockReturnValue(true);
      act(() => void window.dispatchEvent(new Event("focus")));
      const at = (w().calls.at(-1)!.params as { at: number }).at;
      w().calls.length = 0;
      act(() => reopen(w(), "box"));
      expect(said()).toEqual(["box"]);
      // the same moment it came to the front, not the reconnect's: the host keeps the latest across desktops
      expect(w().calls.find((c) => c.method === "work.digest.here")!.params).toMatchObject({ at });
    } finally {
      focus.mockRestore();
    }
  });
});

describe("a page above the workspaces", () => {
  it("opens when its row is on the rail, and is the list until then", async () => {
    w().rows.set("box", [tell({ key: "review:2026-11-16", title: "This week's review is ready", how: "now", toldAt: at(24, 9), open: { place: "review" } })]);
    await mount();
    await act(async () => shown()[0]!.action());
    // no such page in this build: the list opens instead
    expect(shellStore.getState().workPlace ?? null).toBeNull();
    expect(await screen.findByRole("heading", { name: "Digest" })).toBeTruthy();
  });
  it("opens the page once it is there", async () => {
    WORK_PLACE_ROWS.push({ id: "review", label: "Review", order: 20, icon: (() => null) as never });
    w().rows.set("box", [tell({ key: "review:2026-11-16", title: "This week's review is ready", how: "now", toldAt: at(24, 9), open: { place: "review" } })]);
    await mount();
    await act(async () => shown()[0]!.action());
    expect(shellStore.getState().workPlace).toBe("review");
  });
  it("opens the review on the week the row names", async () => {
    WORK_PLACE_ROWS.push({ id: "review", label: "Review", order: 20, icon: (() => null) as never });
    const week = at(16, 0);
    w().rows.set("box", [tell({ key: "review:2026-11-16", title: "This week's review is ready", how: "now", toldAt: at(24, 9), open: { place: "review", at: String(week) } })]);
    await mount();
    const asked = renderHook(() => useWorkPlaceAt("review"));
    await act(async () => shown()[0]!.action());
    expect(shellStore.getState().workPlace).toBe("review");
    expect(asked.result.current).toBe(week);
  });
});

describe("a guest's edit that does not open", () => {
  const guest = () => tell({ key: "guest-edit:lifeos:docs:d1:2026-11-24", kind: "docs.guest", group: "people", workspaceId: "ws-purdue", sector: "purdue", title: "A guest edited Pricing notes", how: "now", toldAt: at(24, 9), open: { view: "docs", workspaceId: "ws-purdue", at: "lifeos:docs:d1" } });
  let refuse: (err: Error) => void = () => {};
  beforeEach(() => {
    toasts.errors.length = 0;
    workspaces.list = [{ id: "ws-purdue", path: "/work/Purdue", environmentId: "box", kind: "work", sector: "purdue" }];
    files.open = () => {
      choose();
      return new Promise<void>((_, reject) => (refuse = reject));
    };
  });
  it("says why and shows Files while the press is still his latest choice", async () => {
    w().rows.set("box", [guest()]);
    await mount();
    await act(async () => shown()[0]!.action());
    await settle();
    await act(async () => refuse(new Error("That host runs an older build")));
    await settle();
    expect(workViewNow()).toMatchObject({ workspaceId: "ws-purdue", view: "files" });
    expect(toasts.errors).toEqual(["It did not open"]);
  });
  it("keeps a thread he opened while it waited: no Files over it, no word", async () => {
    w().rows.set("box", [guest()]);
    await mount();
    await act(async () => shown()[0]!.action());
    await settle();
    // he opens a thread while the host makes the tab
    act(() => {
      choose();
      openWorkView(null);
    });
    await act(async () => refuse(new Error("That host runs an older build")));
    await settle();
    expect(workViewNow()).toBeNull();
    expect(toasts.errors).toEqual([]);
  });
});

describe("an interrupt's toast", () => {
  const meeting = () => tell({ key: "prep:ev1", sector: "purdue", workspaceId: "ws-purdue", title: "Budget review starts at 2:00 PM", detail: "With Dana Reyes", how: "now", toldAt: at(24, 10), by: at(24, 14), open: { view: "agenda", workspaceId: "ws-purdue", at: "ev1" } });

  it("is one toast a key though two hosts tell it, in the waiting voice, with its detail as the second line", async () => {
    w().rows.set("box", [meeting()]);
    w().rows.set("mac", [{ ...meeting(), host: "mac" }]);
    await mount();
    expect(shown()).toMatchObject([{ id: "work-now:k:prep:ev1", kind: "warning", text: "Budget review starts at 2:00 PM", description: "With Dana Reyes", sticky: true, label: "Open" }]);
    expect(bridge.show).toHaveBeenCalledWith({ key: "work-now:k:prep:ev1", title: "Purdue", body: "Budget review starts at 2:00 PM\nWith Dana Reyes", telling: expect.any(String) });
  });

  it("its press moves the window to the job and opens the view on the thing, and the toast is gone for good", async () => {
    w().rows.set("box", [meeting()]);
    workspaces.list = [{ id: "ws-purdue", path: "/work/Purdue", environmentId: "box", kind: "work", sector: "purdue" }];
    await mount();
    await act(async () => shown()[0]!.action());
    expect(workspaces.entered).toEqual(["/work/Purdue"]);
    expect(workViewNow()).toEqual({ workspaceId: "ws-purdue", view: "agenda", event: "ev1" });
    await waitFor(() => expect(shown()).toEqual([]));
    // a reload does not bring it back
    cleanup();
    toasts.shown.clear();
    await mount();
    expect(shown()).toEqual([]);
  });

  it("pressed while Settings is up, Settings closes and the view opens in front", async () => {
    w().rows.set("box", [meeting()]);
    workspaces.list = [{ id: "ws-purdue", path: "/work/Purdue", environmentId: "box", kind: "work", sector: "purdue" }];
    await mount();
    act(() => shell.openSettings("work"));
    expect(shellStore.getState().settingsOpen).toBe(true);
    await act(async () => shown()[0]!.action());
    expect(shellStore.getState().settingsOpen).toBe(false);
    expect(workViewNow()).toEqual({ workspaceId: "ws-purdue", view: "agenda", event: "ev1" });
  });

  it("a job this window does not list opens nothing there: the list opens in its place", async () => {
    w().rows.set("box", [meeting()]);
    workspaces.list = [];
    await mount();
    await act(async () => shown()[0]!.action());
    expect(await screen.findByRole("heading", { name: "Digest" })).toBeTruthy();
  });

  it("goes when the thing is done, without counting as closed by him", async () => {
    const row = meeting();
    w().rows.set("box", [row]);
    await mount();
    await act(async () => push(w(), "box", { gone: row.id }));
    await waitFor(() => expect(shown()).toEqual([]));
    expect(bridge.close).toHaveBeenCalledWith("work-now:k:prep:ev1");
    expect(localStorage.getItem("work.digest.dismissed")).toBeNull();
  });

  it("a thread opens the thread, a held item the Outbox, a settings section Settings", async () => {
    const openedThread = vi.fn();
    workOpenPort.set(openedThread);
    const settings: string[] = [];
    const onSettings = (e: Event) => settings.push((e as CustomEvent<string>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, onSettings);
    w().rows.set("box", [
      tell({ key: "a", title: "A routine asks", how: "now", toldAt: at(24, 9, 1), open: { thread: "t1" } }),
      tell({ key: "b", title: "Not sent: Send to Dana Reyes", how: "now", toldAt: at(24, 9, 2), open: { held: { at: "host", id: "h1" }, thread: "t2" } }),
      tell({ key: "c", title: "Sign-in to Frame.io ends today", how: "now", toldAt: at(24, 9, 3), open: { settings: "connections" } }),
    ]);
    await mount();
    expect(shown().map((t) => t.text)).toEqual(["A routine asks", "Not sent: Send to Dana Reyes", "Sign-in to Frame.io ends today"]);
    for (const toast of shown()) await act(async () => toast.action());
    window.removeEventListener(OPEN_SETTINGS_EVENT, onSettings);
    expect(openedThread).toHaveBeenCalledWith("t1");
    expect(shellStore.getState().outboxViewOpen).toBe(true);
    expect(settings).toEqual(["connections"]);
  });

  it("a system notification sounds for a thing not heard before, and never again for one he heard: a fold that grows sounds, one that shrinks or breaks up does not", async () => {
    // Told just now, with the window open: news to the ear.
    const rows = Array.from({ length: 4 }, (_, i) => tell({ key: `k${i}`, title: `Thing ${i}`, how: "now", toldAt: at(24, 10, 0) + i }));
    w().rows.set("box", rows);
    await mount();
    expect(bridge.show).toHaveBeenLastCalledWith({ key: "work-now", title: "Work", body: "4 things need you: Thing 3; Thing 2; Thing 1; Thing 0", telling: expect.any(String) });
    // A fifth joins: asked again in the new words, and it sounds.
    const fifth = tell({ key: "k4", title: "Thing 4", how: "now", toldAt: at(24, 10, 0) + 9 });
    await act(async () => push(w(), "box", { row: fifth }));
    await settle();
    expect(bridge.show).toHaveBeenLastCalledWith({ key: "work-now", title: "Work", body: "5 things need you: Thing 4; Thing 3; Thing 2; Thing 1; Thing 0", telling: expect.any(String) });
    // The newest is done: four he heard remain, said quietly.
    await act(async () => push(w(), "box", { gone: fifth.id }));
    await settle();
    expect(bridge.show).toHaveBeenLastCalledWith({ key: "work-now", title: "Work", body: "4 things need you: Thing 3; Thing 2; Thing 1; Thing 0", silent: true, telling: expect.any(String) });
    // One more is done: the fold breaks up into three he heard, each quiet.
    bridge.show.mockClear();
    await act(async () => push(w(), "box", { gone: rows[3]!.id }));
    await settle();
    expect(bridge.close).toHaveBeenCalledWith("work-now");
    expect(bridge.show.mock.calls.map((c) => (c as unknown as [{ key: string; silent?: boolean }])[0]).map((n) => [n.key, n.silent])).toEqual([
      ["work-now:k:k0", true],
      ["work-now:k:k1", true],
      ["work-now:k:k2", true],
    ]);
  });

  it("a thing told before the window opened is shown without a sound: it is not news to the ear", async () => {
    w().rows.set("box", [tell({ key: "old", title: "Told an hour ago", how: "now", toldAt: at(24, 9) })]);
    await mount();
    expect(bridge.show).toHaveBeenLastCalledWith({ key: "work-now:k:old", title: "Cosmic", body: "Told an hour ago", silent: true, telling: expect.any(String) });
  });

  it("past three at once they are one toast that opens the list", async () => {
    w().rows.set("box", Array.from({ length: 4 }, (_, i) => tell({ key: `k${i}`, title: `Thing ${i}`, how: "now", toldAt: at(24, 9, i) })));
    await mount();
    expect(shown()).toMatchObject([{ id: "work-now", kind: "warning", text: "4 things need you now" }]);
    await act(async () => shown()[0]!.action());
    expect(await screen.findByRole("heading", { name: "Digest" })).toBeTruthy();
    expect(screen.getByText("Thing 3")).toBeTruthy();
  });

  it("a close reads what the toast stands for now: one of four told again under the same words is closed with the rest", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => tell({ key: `k${i}`, title: `Thing ${i}`, how: "now", toldAt: at(24, 9, i) }));
    w().rows.set("box", rows);
    await mount();
    expect(shown()).toMatchObject([{ id: "work-now", text: "4 things need you now" }]);
    // Told again later: the same four, the same words, so the toast is not drawn again.
    await act(async () => push(w(), "box", { row: { ...rows[0]!, toldAt: at(24, 9, 30) } }));
    await settle();
    expect(shown()).toHaveLength(1);
    // He closes it, as sonner's close button does.
    await act(async () => {
      const toast = shown()[0]! as unknown as { dismiss: () => void };
      toasts.shown.clear();
      toast.dismiss();
    });
    await settle();
    // Every row it stood for is closed, the new telling too: nothing comes back.
    expect(shown()).toEqual([]);
  });

  it("its system notification is asked again when its words change, a title alone too", async () => {
    const row = tell({ key: "prep:ev1", sector: "purdue", title: "Budget review starts at 2:00 PM", how: "now", toldAt: at(24, 10) });
    w().rows.set("box", [row]);
    await mount();
    expect(bridge.show).toHaveBeenLastCalledWith({ key: "work-now:k:prep:ev1", title: "Purdue", body: "Budget review starts at 2:00 PM", telling: expect.any(String) });
    bridge.show.mockClear();
    // The same thing, now about another job: only the title changes.
    await act(async () => push(w(), "box", { row: { ...row, sector: "ref" } }));
    await settle();
    // the same telling, heard already: the new words come without a second sound
    expect(bridge.show).toHaveBeenCalledWith({ key: "work-now:k:prep:ev1", title: "Ref", body: "Budget review starts at 2:00 PM", silent: true, telling: expect.any(String) });
  });

  it("a day after it was told it leaves the window on its own", async () => {
    w().rows.set("box", [tell({ key: "old", title: "Old news", how: "now", toldAt: at(23, 9) })]);
    await mount();
    expect(shown()).toEqual([]);
  });
});
