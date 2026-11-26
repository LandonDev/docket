// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerTile } from "../lib/computers";
import { closeFullWindow, fullWindowTarget, toggleFullScreen } from "../lib/fullWindow";
import { closePopOut, popOutTarget, requestStage } from "../lib/popOut";
import { registry } from "../lib/connection/registry";
import { ComputersPage, ComputersView, LOST_TRIES, lostPlate, pictureFrame, RestingVmPicture, Tile, tileLine } from "./ComputersView";
import fixtures from "./ComputersView.fixtures";
import type { BarReading } from "./threads/computer/ComputerBar";
import { tile } from "./threads/computer/FullWindow.fixtures";
import { restingVmTiles } from "../lib/winvmWake";

const h = vi.hoisted(() => ({ tiles: [] as ComputerTile[], desktop: true, streams: [] as { key: string; take: boolean | undefined; run: boolean }[], ended: null as string | null, retried: 0, readings: {} as Record<string, BarReading> }));
vi.mock("../lib/computers", async (original) => ({ ...(await original<typeof import("../lib/computers")>()), useComputers: () => h.tiles }));
vi.mock("../lib/computerSessions", async (original) => ({ ...(await original<typeof import("../lib/computerSessions")>()), previewContext: () => ({ desktop: h.desktop, localId: null }) }));
vi.mock("./threads/computer/Viewport", async (original) => {
  const actual = await original<typeof import("./threads/computer/Viewport")>();
  return {
    ...actual,
    // the stream itself is the viewport tests' business: here, what a tile asks of it
    useLiveStream: (entry: { previewKey?: string } | null, run: boolean, _box: unknown, _measure: unknown, opts?: { take?: boolean; read?: boolean }) => {
      h.streams.push({ key: entry?.previewKey ?? "", take: opts?.take, run });
      const state = h.ended ? { status: "ended", reason: h.ended } : { status: "live", app: "Chromium", window: "Concur", width: 1280, height: 800, drawn: true };
      return { state, retry: () => void h.retried++, canvas: { current: null }, ring: { current: null }, mode: "video", reading: opts?.read ? h.readings[entry?.previewKey ?? ""] : null };
    },
  };
});
// the window's own buttons belong to the frame's tests
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../chrome/TitleBar", () => ({ OverlayNav: () => null }));

beforeEach(() => {
  h.tiles = [];
  h.desktop = true;
  h.streams.length = 0;
  h.ended = null;
  h.retried = 0;
  h.readings = {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** One computer on the stage, its bar in the header, with no picture drawn: what the bar holds. */
const staged = (t: ComputerTile, onOpenSession: (thread: string, host: string) => void = () => undefined, picture?: React.ReactNode) =>
  render(<ComputersPage tiles={[t]} onOpenSession={onOpenSession} pictureOf={() => picture ?? null} size={{ width: 1200, height: 800 }} />);
const bar = (): HTMLElement => document.querySelector<HTMLElement>('[data-slot="computer-bar"]')!;

describe("the Computers page", () => {
  it("keeps the same picture through Take over: one call, and the page's tile, box and canvas stay as its row moves to the pane's thread", async () => {
    const calls: { method: string; params: unknown }[] = [];
    vi.spyOn(registry, "link").mockImplementation(() => ({ request: async (method: string, params: unknown) => void calls.push({ method, params }) }) as never);
    const page = (): React.ReactElement => <ComputersView onClose={() => undefined} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />;
    // a subagent's thread drives the page of the pane t1
    const base = tile();
    h.tiles = [tile({ id: "box\nsub", pane: "t1", entry: { ...base.entry, row: { ...base.entry.row, threadId: "sub" }, previewKey: "sub" } })];
    const view = render(page());
    const article = screen.getByRole("article");
    const face = document.querySelector<HTMLElement>('[data-face="live"]')!;
    const canvas = face.querySelector("canvas")!;
    expect(canvas.className).not.toContain("invisible");
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await act(async () => {});
    // one call: the host hands him the wheel, then stops the agent's session itself
    expect(calls).toEqual([{ method: "computer.drive", params: { computer: "browser:t1", driver: "owner" } }]);
    // what the host lists once the session is stopped: the page under the pane's own thread, his
    h.tiles = [tile({ id: "box\nt1", pane: "t1", driving: true, doing: null, entry: { ...base.entry, row: { ...base.entry.row, threadId: "t1", running: null, driver: "owner" }, previewKey: "t1" } })];
    view.rerender(page());
    expect(screen.getByRole("article")).toBe(article);
    expect(document.querySelector('[data-face="live"]')).toBe(face);
    expect(face.querySelector("canvas")).toBe(canvas);
    // still playing: the stream of the pane's page runs on it, and its frame is not hidden
    expect(h.streams.at(-1)).toMatchObject({ key: "t1", run: true });
    expect(canvas.className).not.toContain("invisible");
    expect(screen.getByText("You are driving")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Hand back" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("uses the selected picture’s live readings in the stage bar", async () => {
    const live = tile();
    h.tiles = [live];
    h.readings[live.entry.previewKey!] = { delayMs: 31, fps: 48, picture: { width: 1280, height: 800 }, link: "good" };
    const page = () => <ComputersView onClose={() => undefined} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />;
    const view = render(page());
    const delay = screen.getByRole("button", { name: "Delay 31 ms, details" });
    fireEvent.click(delay);
    expect(await screen.findByText("48 a second")).not.toBeNull();
    expect(screen.getByText("1280 × 800")).not.toBeNull();
    h.readings = {};
    view.rerender(page());
    expect(screen.queryByRole("button", { name: "Delay 31 ms, details" })).toBeNull();
  });

  it("draws every fixture: a tile for each computer, or the one empty state", () => {
    for (const fixture of fixtures) {
      const view = render(<ComputersPage {...fixture.props} />);
      expect(view.container.querySelectorAll('[data-slot="computer-tile"]'), fixture.name).toHaveLength(fixture.props.tiles.length);
      if (!fixture.props.tiles.length) expect(view.container.textContent, fixture.name).toContain("Nothing is being driven");
      view.unmount();
    }
  });

  it("says nothing is being driven, with one line and no action", () => {
    render(<ComputersPage tiles={[]} onOpenSession={() => undefined} />);
    expect(screen.getByText("Nothing is being driven")).not.toBeNull();
    expect(screen.getByText("A browser or an app an agent is using shows here, live.")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("gives one computer the stage, with the others in a strip beside it, or under it on a narrow page", () => {
    const layout = (n: number, width: number): { strip: string | undefined; stage: number } => {
      const view = render(<ComputersPage tiles={Array.from({ length: n }, (_, i) => tile({ id: `box\nt${i}`, computer: `browser:t${i}` }))} onOpenSession={() => undefined} pictureOf={() => null} size={{ width, height: 860 }} />);
      const found = { strip: view.container.querySelector<HTMLElement>('[data-slot="computer-tiles"]')!.dataset.strip, stage: view.container.querySelectorAll("[data-stage]").length };
      view.unmount();
      return found;
    };
    expect(layout(1, 1200)).toEqual({ strip: "none", stage: 1 });
    expect(layout(3, 1200)).toEqual({ strip: "side", stage: 1 });
    expect(layout(3, 520)).toEqual({ strip: "below", stage: 1 });
  });

  it("puts on the stage the one that needs him, else the one that acted last, and a press on a strip tile puts that one there with the same element", () => {
    const row = tile().entry.row;
    const older = tile({ id: "box\na", title: "Older", computer: "browser:a", entry: { ...tile().entry, row: { ...row, threadId: "a", lastCallAt: 1 } } });
    const newer = tile({ id: "box\nb", title: "Newer", computer: "browser:b", entry: { ...tile().entry, row: { ...row, threadId: "b", lastCallAt: 9 } } });
    const view = render(<ComputersPage tiles={[older, newer]} onOpenSession={() => undefined} pictureOf={() => null} size={{ width: 1200, height: 860 }} />);
    const staged = (): string | null => view.container.querySelector("[data-stage]")!.getAttribute("aria-label");
    expect(staged()).toBe("Newer");
    const olderTile = screen.getByRole("article", { name: "Older" });
    fireEvent.click(screen.getByRole("button", { name: "Show Older" }));
    expect(staged()).toBe("Older");
    // the same element: only its place changed, so its picture is never made again
    expect(screen.getByRole("article", { name: "Older" })).toBe(olderTile);
    // nothing moves by itself: the newer one acting again leaves his pick where it is
    view.rerender(<ComputersPage tiles={[older, { ...newer, entry: { ...newer.entry, row: { ...row, threadId: "b", lastCallAt: 50 } } }]} onOpenSession={() => undefined} pictureOf={() => null} size={{ width: 1200, height: 860 }} />);
    expect(staged()).toBe("Older");
    view.unmount();
    // one that waits on him takes the stage when he opens the page
    const asking = tile({ id: "local\nc", title: "Asks", computer: "window:c", browser: false, entry: { ...tile().entry, row: { ...row, threadId: "c", lastCallAt: 0, asking: { line: "Allow Frame.io to be used?" } } } });
    render(<ComputersPage tiles={[newer, asking]} onOpenSession={() => undefined} pictureOf={() => null} size={{ width: 1200, height: 860 }} />);
    expect(document.querySelector("[data-stage]")!.getAttribute("aria-label")).toBe("Asks");
    // its question leads the caption, and where it runs follows it
    expect(screen.getByText("Allow Frame.io to be used?").className).toContain("text-foreground");
    // the strip tile of the other carries no buttons of its own but the press
    const strip = screen.getByRole("article", { name: "Newer" });
    expect(within(strip).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Show Newer"]);
  });

  it("pops the stage's computer out, and puts the computer he came back from on the stage", () => {
    const row = tile().entry.row;
    const a = tile({ id: "box\na", title: "First", computer: "browser:a", pane: "a", entry: { ...tile().entry, row: { ...row, threadId: "a", lastCallAt: 9 } } });
    const b = tile({ id: "box\nb", title: "Second", computer: "browser:b", pane: "b", entry: { ...tile().entry, row: { ...row, threadId: "b", lastCallAt: 1 } } });
    h.tiles = [a, b];
    render(<ComputersView onClose={() => undefined} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Pop out" }));
    expect(popOutTarget()).toMatchObject({ host: "box", threadId: "a" });
    act(() => closePopOut());
    act(() => requestStage({ host: "box", threadId: "b" }));
    expect(document.querySelector("[data-stage]")!.getAttribute("aria-label")).toBe("Second");
  });

  it("the header is the stage's bar: its thread, what it is doing and where, as one comma sentence; its title goes to the thread; the page's name stays its heading", () => {
    const opened: [string, string][] = [];
    staged(tile(), (thread, host) => opened.push([thread, host]));
    expect(screen.getByRole("heading", { name: "Computers" }).className).toContain("sr-only");
    // the picture has the stage alone: no caption under it
    expect(screen.getByRole("article").querySelector('[data-slot="computer-bar"]')).toBeNull();
    const facts = bar().querySelector('[data-slot="facts"]')!;
    expect([...facts.children].map((c) => c.textContent)).toEqual(["Clicking Submit in Chromium", "the box"]);
    fireEvent.click(screen.getByRole("button", { name: "File the March expense report" }));
    expect(opened).toEqual([["t1", "box"]]);
    // a page he drives reads so, in the foreground
    cleanup();
    staged(tile({ driving: true, doing: null }));
    expect(tileLine(tile({ driving: true, doing: "stale" }))).toBe("You are driving");
    expect(screen.getByText("You are driving").className).toContain("text-foreground");
    // between calls there is only where it runs
    cleanup();
    staged(tile({ doing: null }));
    expect([...bar().querySelector('[data-slot="facts"]')!.children].map((c) => c.textContent)).toEqual(["The box"]);
    // nothing driven: the header says the page's name
    cleanup();
    render(<ComputersPage tiles={[]} onOpenSession={() => undefined} />);
    expect(screen.getByRole("heading", { name: "Computers" }).className).not.toContain("sr-only");
  });

  it("gives the Windows VM he drives one quiet Keys menu beside Hand back, and the browser none", async () => {
    const pressed: unknown[] = [];
    vi.spyOn(await import("../lib/computerVideo"), "pressKeys").mockImplementation(async (...args) => (pressed.push(args), true));
    const base = tile();
    const vmTile = tile({ browser: false, computer: "vm:windows", driving: true, doing: null, entry: { ...base.entry, previewHost: "box", previewKey: "vm:windows" } });
    staged(vmTile);
    const keys = screen.getByRole("button", { name: "Keys" });
    expect(keys.getAttribute("data-variant")).toBe("ghost");
    expect(screen.getByRole("button", { name: "Hand back" }).getAttribute("data-variant")).toBe("default");
    fireEvent.click(keys);
    expect((await screen.findAllByRole("menuitem")).map((m) => m.textContent)).toEqual(["Windows key", "Ctrl+Alt+Del", "Alt+Tab"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Ctrl+Alt+Del" }));
    await act(async () => {});
    expect(pressed).toEqual([["box", "vm:windows", [224, 226, 76]]]);
    cleanup();
    staged(tile({ driving: true, doing: null }));
    expect(screen.queryByRole("button", { name: "Keys" })).toBeNull();
  });

  it("shows the stage's controls always: Take over only where the computer takes input, Stop unless it is idle, and Hand back alone while he drives", () => {
    staged(tile());
    const controls = bar().querySelector<HTMLElement>('[data-slot="computer-controls"]')!;
    // never behind a hover
    expect(controls.parentElement!.className).not.toContain("opacity-0");
    expect(within(controls).getByRole("button", { name: "Take over" }).getAttribute("data-variant")).toBe("secondary");
    expect(within(controls).getByRole("button", { name: "Stop File the March expense report" })).not.toBeNull();
    cleanup();
    // a Mac's own window takes no input; the Windows VM does
    staged(tile({ browser: false, computer: "window:t1" }));
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    cleanup();
    staged(tile({ browser: false, computer: "vm:windows" }));
    expect(screen.getByRole("button", { name: "Take over" })).not.toBeNull();
    cleanup();
    // ...unless it has no window of its own (its tools are missing): its 4 fps picture alone
    staged(tile({ browser: false, computer: "vm:windows", pictureOnly: true }));
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    cleanup();
    // an idle page has nothing to stop
    staged(tile({ idle: true, doing: null }));
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    cleanup();
    staged(tile({ driving: true, doing: null }));
    const back = screen.getByRole("button", { name: "Hand back" });
    expect(back.getAttribute("data-variant")).toBe("default");
    expect(back.hasAttribute("data-hand-back")).toBe(true);
    expect(back.querySelector("kbd")).not.toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).not.toContain("Take over");
  });

  it("plays the stage's stream as the one he watches, a strip tile's without taking the box's display, and opens full screen on a click of the stage's picture, from where it is", () => {
    h.tiles = [tile(), tile({ id: "box\nt2", computer: "browser:t2", entry: { ...tile().entry, previewKey: "t2", row: { ...tile().entry.row, threadId: "t2", lastCallAt: 0 } } })];
    render(<ComputersView onClose={() => undefined} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />);
    expect(h.streams.findLast((s) => s.key === "t1")).toMatchObject({ take: true, run: true });
    expect(h.streams.findLast((s) => s.key === "t2")).toMatchObject({ take: false, run: true });
    fireEvent.click(screen.getByRole("button", { name: "Live view of Expense report in Chromium" }));
    expect(fullWindowTarget()).toEqual({ host: "box", threadId: "t1", name: "Live view of Expense report in Chromium", from: { x: 0, y: 0, width: 0, height: 0 } });
    closeFullWindow();
    // ⌃⌘F takes the stage's computer full screen, with no place to grow from
    toggleFullScreen();
    expect(fullWindowTarget()).toEqual({ host: "box", threadId: "t1", name: "Live view of Expense report in Chromium" });
    closeFullWindow();
  });

  it("says a picture stopped on a plate with Retry as its press, as every face of the stage, and keeps the bar's controls", () => {
    h.tiles = [tile()];
    h.ended = "error";
    render(<ComputersView onClose={() => undefined} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />);
    const plate = document.querySelector<HTMLElement>('[data-slot="computer-plate"]')!;
    expect(within(plate).getByText("The preview stopped")).not.toBeNull();
    expect(document.querySelector('[data-slot="computer-line"]')).toBeNull();
    fireEvent.click(within(plate).getByRole("button", { name: "Retry" }));
    expect(h.retried).toBe(1);
    expect(screen.getByRole("button", { name: "Take over" })).not.toBeNull();
    // a stream that ended because the window closed has nothing to try again
    cleanup();
    h.ended = "ended";
    render(<ComputersView onClose={() => undefined} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("draws one muted line in place of a picture this desktop may not draw, naming the machine", () => {
    h.tiles = [tile({ shownOn: "Studio", where: "Studio", browser: false })];
    render(<ComputersView onClose={() => undefined} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />);
    expect(screen.getByText("Shown on Studio only")).not.toBeNull();
    // the machine is named once: the caption under it does not say it again
    expect(document.body.textContent!.match(/Studio/g)).toHaveLength(1);
    expect(h.streams).toEqual([]);
  });

  it("is a region named Computers; its title press closes the page and goes to the thread; the browser /ui draws no picture", () => {
    h.tiles = [tile()];
    const closed = vi.fn();
    const opened = vi.fn();
    const view = render(<ComputersView onClose={closed} onToggleSidebar={() => undefined} onOpenSession={opened} />);
    expect(screen.getByRole("region", { name: "Computers" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "File the March expense report" }));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith("t1", "box");
    view.unmount();
    h.desktop = false;
    h.streams.length = 0;
    render(<ComputersView onClose={closed} onToggleSidebar={() => undefined} onOpenSession={opened} />);
    expect(screen.getByRole("article")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Live view/ })).toBeNull();
    expect(h.streams).toEqual([]);
  });
});

describe("the Windows VM in every state", () => {
  it("lays its stage out in the page's measured room when its tile comes after the first paint (1.0.382's sliver)", async () => {
    // the body measures 1200 by 800; its VM tile arrives from the keeper's state, after the empty page painted
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    vi.spyOn(registry, "link").mockReturnValue({ request: () => new Promise(() => undefined) } as never);
    const page = (tiles: ComputerTile[]) => <ComputersPage tiles={tiles} onOpenSession={() => undefined} />;
    const view = render(page([]));
    view.rerender(page(restingVmTiles({ box: { state: "asleep", cannot: null, error: null } }, [], () => "The box")));
    await act(async () => {});
    // 16px in on every side, in the VM's 16:10: 1168 wide, never 0
    expect(document.querySelector<HTMLElement>('[data-stage] [data-slot="computer-picture-room"]')!.style.width).toBe("1168px");
  });

  const view = (): React.ReactElement => <ComputersView onClose={() => undefined} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />;
  const state = (s: string, cannot: string | null = null) => ({ state: s, step: null, error: null, cannot, sleepAfter: "30m", since: 1 });
  function host(answer: () => unknown) {
    const calls: string[] = [];
    let opened: (() => void) | null = null;
    vi.spyOn(registry, "link").mockImplementation(
      () =>
        ({
          request: async (method: string) => (calls.push(method), method === "work.winvm.state" ? answer() : null),
          onPush: () => () => undefined,
          onOpen: (fn: () => void) => ((opened = fn), () => undefined),
        }) as never,
    );
    return { calls, reopen: () => opened?.() };
  }

  it("is a tile while it sleeps, and the stage wakes it by itself with one waiting line: no Wake in the header", async () => {
    const { workSwitch } = await import("../lib/workSwitch");
    vi.spyOn(workSwitch, "hosts").mockReturnValue(new Set(["box"]));
    const box = host(() => state("asleep"));
    render(view());
    const tile = await screen.findByRole("article", { name: "Windows VM" });
    await act(async () => {});
    expect(box.calls.filter((m) => m !== "work.winvm.still")).toEqual(["work.winvm.state", "work.winvm.wake"]);
    expect(within(tile).getByRole("status").textContent).toBe("Waking the Windows VM");
    // the box keeps the picture's 16:10 so nothing moves when it comes
    expect((tile.querySelector('[data-face="plate"]') as HTMLElement).style.aspectRatio).toBe("1280 / 800");
    // its bar is the header's: Take over wakes it and takes over, one press; no Wake beside it
    expect(within(bar()).getByRole("button", { name: "Take over" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Wake/ })).toBeNull();
    // the caption says where it runs; its state is said once, in the box
    expect(within(tile).queryByText(/^Asleep/)).toBeNull();
  });

  it("says where to set it up when it is not, and offers no Take over; a host that cannot have one shows nothing", async () => {
    const { workSwitch } = await import("../lib/workSwitch");
    vi.spyOn(workSwitch, "hosts").mockReturnValue(new Set(["box"]));
    host(() => state("none"));
    render(view());
    const tile = await screen.findByRole("article", { name: "Windows VM" });
    expect(within(tile).getByRole("status").textContent).toBe("The Windows VM is not set up");
    // no picture to keep: the plate stands on the bare box; the bar's one press goes to Settings
    expect(tile.querySelector('[data-slot="computer-wash"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Settings" })).not.toBeNull();
    cleanup();
    host(() => state("none", "The Windows VM runs on the box."));
    render(view());
    await act(async () => {});
    expect(screen.queryByRole("article", { name: "Windows VM" })).toBeNull();
  });

  it("after his own Sleep the stage waits for his Wake: the desk washed back, Asleep since when, and Wake in the bar", async () => {
    const { workSwitch } = await import("../lib/workSwitch");
    vi.spyOn(workSwitch, "hosts").mockReturnValue(new Set(["box"]));
    const since = new Date(2026, 10, 24, 13, 14).getTime();
    const box = host(() => ({ ...state("asleep"), since, heldAsleep: true }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request: async (m: string) => (box.calls.push(m), null) } as never);
    vi.spyOn(Date, "now").mockReturnValue(since + 60_000);
    render(view());
    const tile = await screen.findByRole("article", { name: "Windows VM" });
    await act(async () => {});
    expect(box.calls).not.toContain("work.winvm.wake");
    expect(within(tile).getByRole("status").textContent).toBe("Asleep");
    expect(within(tile).getByText(/^Since 1:14/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    await act(async () => {});
    expect(box.calls).toContain("work.winvm.wake");
  });

  it("shows the picture it slept on, washed back under its plate, where the host kept one", async () => {
    vi.spyOn(registry, "link").mockReturnValue({ request: async (m: string) => (m === "work.winvm.still" ? { still: { data: "AAAA", width: 1920, height: 1200, at: 5 } } : null) } as never);
    render(<RestingVmPicture host="box" vm={{ state: "asleep", cannot: null, error: null, since: 5 }} place={{ stage: false }} />);
    await act(async () => {});
    expect(document.querySelector<HTMLImageElement>('[data-slot="computer-plate"] img')!.src).toBe("data:image/jpeg;base64,AAAA");
    expect(document.querySelector('[data-slot="computer-wash"]')!.className).toContain("bg-background/80");
  });

  it("counts a wake against the usual one", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    render(<RestingVmPicture host="nohost" vm={{ state: "waking", cannot: null, error: null, since: 4_000, wakeMs: 13_200 }} place={{ stage: false }} />);
    expect(screen.getByRole("status").textContent).toBe("Waking the Windows VM");
    expect(screen.getByText("6 s of about 13")).not.toBeNull();
  });

  it("says the keeper's own work in its words, with no count and no press: a restart, a move to live resize", () => {
    render(<RestingVmPicture host="nohost" vm={{ state: "waking", cannot: null, error: null, step: "Restarting Windows", since: 1, wakeMs: 13_000 }} place={{ stage: true, room: { width: 800, height: 500 } }} />);
    expect(screen.getByRole("status").textContent).toBe("Restarting Windows");
    expect(screen.queryByText(/ s of about /)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("in the strip waits for his press: asleep, no wake asked", async () => {
    const calls: string[] = [];
    render(<RestingVmPicture host="box" vm={{ state: "asleep", cannot: null, error: null }} place={{ stage: false }} wake={async () => void calls.push("wake")} />);
    await act(async () => {});
    expect(calls).toEqual([]);
    expect(screen.getByText("Asleep")).not.toBeNull();
  });

  it("says a failed wake, and Retry asks again", async () => {
    let tries = 0;
    render(<RestingVmPicture host="box" vm={{ state: "asleep", cannot: null, error: null }} place={{ stage: true, room: { width: 800, height: 500 } }} wake={async () => void (tries++, (() => { throw new Error("no door"); })())} />);
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toBe("Couldn't wake the Windows VM");
    expect(screen.getByText("no door")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(tries).toBe(2);
  });

  it("on a build with no helper, asks no wake on the stage and says the cause once, with no press (the page looped on 2026-11-25)", async () => {
    const calls: string[] = [];
    const blocked = "This update left out the Windows VM's helper. Redeploy the box from master.";
    render(<RestingVmPicture host="box" vm={{ state: "asleep", cannot: null, error: null, blocked }} place={{ stage: true, room: { width: 800, height: 500 } }} wake={async () => void calls.push("wake")} />);
    await act(async () => {});
    expect(calls).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe("Can't wake the Windows VM");
    expect(screen.getAllByText(blocked)).toHaveLength(1);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("driving from the page", () => {
  const vmTile = (over: Partial<ComputerTile> = {}): ComputerTile => {
    const base = tile();
    return tile({ browser: false, computer: "vm:windows", driving: true, doing: null, entry: { ...base.entry, previewHost: "box", previewKey: "vm:windows" }, ...over });
  };

  it("gives the keyboard back to the picture after a pick from the Keys menu", async () => {
    vi.spyOn(await import("../lib/computerVideo"), "pressKeys").mockResolvedValue(true);
    staged(vmTile(), undefined, <div role="application" tabIndex={0} aria-label="Live view of Windows VM" />);
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Windows key" }));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(document.activeElement).toBe(screen.getByRole("application"));
  });

  it("hands the computer back by itself when the last place of his that shows it goes, and not when he handed back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const calls: { method: string; params: unknown }[] = [];
    vi.spyOn(registry, "link").mockReturnValue({ request: async (method: string, params: unknown) => void calls.push({ method, params }) } as never);
    const view = render(<Tile tile={vmTile()} />);
    view.unmount();
    await act(async () => void vi.advanceTimersByTime(1500));
    expect(calls).toEqual([{ method: "computer.drive", params: { computer: "vm:windows", driver: "agent" } }]);
    // handed back with its own button (the row says so): nothing more is sent when the tile goes
    calls.length = 0;
    const again = render(<Tile tile={vmTile()} />);
    again.rerender(<Tile tile={vmTile({ driving: false })} />);
    again.unmount();
    await act(async () => void vi.advanceTimersByTime(3000));
    expect(calls).toEqual([]);
    vi.useRealTimers();
  });

  it("keeps a stray Escape from closing the page while he drives: it is the computer's key then", () => {
    const closed = vi.fn();
    h.tiles = [vmTile()];
    const view = render(<ComputersView onClose={closed} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(closed).not.toHaveBeenCalled();
    h.tiles = [vmTile({ driving: false })];
    view.rerender(<ComputersView onClose={closed} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("fills the stage with the VM's screen in its shape, and holds a window's picture to twice its pixels, drawn crisp", () => {
    const room = (): HTMLElement => document.querySelector<HTMLElement>('[data-slot="computer-picture-room"]')!;
    const view = render(<ComputersPage tiles={[vmTile({ driving: false })]} onOpenSession={() => undefined} size={{ width: 3200, height: 1800 }} />);
    // the room is 3168 by 1768, all of the page 16px in: the screen takes its full height
    expect(room().style.width).toBe("2828px");
    expect(room().className).not.toContain("pixelated");
    view.rerender(<ComputersPage tiles={[tile()]} onOpenSession={() => undefined} size={{ width: 3200, height: 1800 }} />);
    expect(room().style.width).toBe("2560px");
    expect(room().className).toContain("[image-rendering:pixelated]");
    expect(screen.getByRole("button", { name: "Full screen" })).not.toBeNull();
  });

  it("waits for a host whose link is down in the picture's own box, with no stream asked for and no Retry", () => {
    vi.spyOn(registry, "statuses").mockReturnValue(new Map([["box", {}]]) as never);
    const status = vi.spyOn(registry, "statusOf").mockReturnValue({ transport: "reconnecting" } as never);
    const tree = () => <ComputersPage tiles={[vmTile({ driving: false })]} vms={{ box: { state: "awake", cannot: null, error: null } }} onOpenSession={() => undefined} size={{ width: 1200, height: 800 }} />;
    const shown = render(tree());
    expect(screen.getByRole("status").textContent).toMatch(/^Reconnecting to /);
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Windows VM" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(h.streams.every((s) => !s.run)).toBe(true);
    // the box keeps the picture's size
    expect((document.querySelector('[data-face="plate"]') as HTMLElement).style.aspectRatio).toBe("1280 / 800");
    status.mockReturnValue({ transport: "open" } as never);
    shown.rerender(tree());
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Windows VM" })).toBeTruthy();
  });

  it("says a lost link's tries, then that the picture stopped, with Retry", () => {
    expect(lostPlate("The box", 1)).toMatchObject({ title: "Reconnecting to The box", detail: "Try 2 of 5", spin: true, retry: false });
    expect(lostPlate("The box", LOST_TRIES)).toMatchObject({ title: "The picture stopped", retry: true });
    vi.spyOn(registry, "statuses").mockReturnValue(new Map([["box", {}]]) as never);
    vi.spyOn(registry, "statusOf").mockReturnValue({ transport: "reconnecting", attempts: 5 } as never);
    const retried = vi.spyOn(registry, "retry").mockImplementation(() => undefined);
    render(<ComputersPage tiles={[vmTile({ driving: false })]} onOpenSession={() => undefined} size={{ width: 1200, height: 800 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retried).toHaveBeenCalledWith("box");
  });

  it("sizes every face of a picture by one rule: the stream's frame, else the last one seen, else the VM's 1280 by 800", () => {
    expect(pictureFrame("box\nbrowser:t9", null, false)).toBeNull();
    expect(pictureFrame("box\nvm:x", null, true)).toEqual({ width: 1280, height: 800 });
    expect(pictureFrame("box\nvm:x", { width: 1920, height: 1200 }, true)).toEqual({ width: 1920, height: 1200 });
    // the stream ended or the link dropped: the box keeps the size it had
    expect(pictureFrame("box\nvm:x", null, true)).toEqual({ width: 1920, height: 1200 });
  });
});

