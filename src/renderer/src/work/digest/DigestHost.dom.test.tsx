// @vitest-environment jsdom
/**
 * The digest on the desktop over two hosts that answer from memory: the
 * two toasts, what a press opens, the system notifications, and the port
 * Today registers.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../lib/connection", async (original) => {
  const kit = await import("./world.testkit");
  world.current = kit.makeWorld();
  return kit.connectionMock(world.current as import("./world.testkit").World, await original<object>());
});

type Shown = { id: string; kind: "plain" | "warning"; text: string; description?: string; action: () => void; dismiss: () => void };
const toasts = vi.hoisted(() => ({ shown: new Map<string, unknown>() }));
vi.mock("../../components/ui/toaster", async (original) => {
  const show =
    (kind: "plain" | "warning") =>
    (text: string, o: { id: string; description?: string; duration: number; closeButton: boolean; action: { label: string; onClick: () => void }; onDismiss: () => void }) => {
      toasts.shown.set(o.id, { id: o.id, kind, text, description: o.description, action: o.action.onClick, dismiss: o.onDismiss, sticky: o.duration === Infinity && o.closeButton, label: o.action.label });
    };
  const api = Object.assign(show("plain"), {
    warning: show("warning"),
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
import { digestOpensPort, setWorkOn, workOpenPort, workSwitch, workViewNow } from "../../lib/workSwitch";
import { shell, shellStore } from "../../stores/shell";
import { WORK_PLACE_ROWS } from "../../lib/workPlaces";
import { DigestHost, digestOpens, resetDismissed } from "./DigestHost";
import { loadDigest, resetDigestStore } from "./store";
import { push, resetWorld, tell, type World } from "./world.testkit";

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
});

describe("an interrupt's toast", () => {
  const meeting = () => tell({ key: "prep:ev1", sector: "purdue", workspaceId: "ws-purdue", title: "Budget review starts at 2:00 PM", detail: "With Dana Reyes", how: "now", toldAt: at(24, 9, 50), by: at(24, 14), open: { view: "agenda", workspaceId: "ws-purdue", at: "ev1" } });

  it("is one toast a key though two hosts tell it, in the waiting voice, with its detail as the second line", async () => {
    w().rows.set("box", [meeting()]);
    w().rows.set("mac", [{ ...meeting(), host: "mac" }]);
    await mount();
    expect(shown()).toMatchObject([{ id: "work-now:k:prep:ev1", kind: "warning", text: "Budget review starts at 2:00 PM", description: "With Dana Reyes", sticky: true, label: "Open" }]);
    expect(bridge.show).toHaveBeenCalledWith({ key: "work-now:k:prep:ev1", title: "Purdue", body: "Budget review starts at 2:00 PM: With Dana Reyes" });
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

  it("past three at once they are one toast that opens the list", async () => {
    w().rows.set("box", Array.from({ length: 4 }, (_, i) => tell({ key: `k${i}`, title: `Thing ${i}`, how: "now", toldAt: at(24, 9, i) })));
    await mount();
    expect(shown()).toMatchObject([{ id: "work-now", kind: "warning", text: "4 things need you now" }]);
    await act(async () => shown()[0]!.action());
    expect(await screen.findByRole("heading", { name: "Digest" })).toBeTruthy();
    expect(screen.getByText("Thing 3")).toBeTruthy();
  });

  it("a day after it was told it leaves the window on its own", async () => {
    w().rows.set("box", [tell({ key: "old", title: "Old news", how: "now", toldAt: at(23, 9) })]);
    await mount();
    expect(shown()).toEqual([]);
  });
});
