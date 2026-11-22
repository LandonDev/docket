// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerTile } from "../lib/computers";
import { closeFullWindow, fullWindowTarget } from "../lib/fullWindow";
import { closePopOut, popOutTarget, requestStage } from "../lib/popOut";
import { registry } from "../lib/connection/registry";
import { ComputersPage, ComputersView, RestingVmPicture, Tile, tileLine } from "./ComputersView";
import fixtures from "./ComputersView.fixtures";
import { tile } from "./threads/computer/FullWindow.fixtures";

const h = vi.hoisted(() => ({ tiles: [] as ComputerTile[], desktop: true, streams: [] as { key: string; take: boolean | undefined; run: boolean }[], ended: null as string | null, retried: 0 }));
vi.mock("../lib/computers", async (original) => ({ ...(await original<typeof import("../lib/computers")>()), useComputers: () => h.tiles }));
vi.mock("../lib/computerSessions", async (original) => ({ ...(await original<typeof import("../lib/computerSessions")>()), previewContext: () => ({ desktop: h.desktop, localId: null }) }));
vi.mock("./threads/computer/Viewport", async (original) => {
  const actual = await original<typeof import("./threads/computer/Viewport")>();
  return {
    ...actual,
    // the stream itself is the viewport tests' business: here, what a tile asks of it
    useLiveStream: (entry: { previewKey?: string } | null, run: boolean, _box: unknown, _measure: unknown, opts?: { take?: boolean }) => {
      h.streams.push({ key: entry?.previewKey ?? "", take: opts?.take, run });
      const state = h.ended ? { status: "ended", reason: h.ended } : { status: "live", app: "Chromium", window: "Concur", width: 1280, height: 800, drawn: true };
      return { state, retry: () => void h.retried++, canvas: { current: null }, ring: { current: null }, mode: "video" };
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
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it("a stage's caption says its thread, what it is doing and where, as one comma sentence; its title goes to the thread", () => {
    const opened: [string, string][] = [];
    render(<Tile tile={tile()} onOpenSession={(thread, host) => opened.push([thread, host])} />);
    const facts = screen.getByRole("article").querySelector('[data-slot="facts"]')!;
    expect([...facts.children].map((c) => c.textContent)).toEqual(["Clicking Submit in Chromium", "The box"]);
    fireEvent.click(screen.getByRole("button", { name: "File the March expense report" }));
    expect(opened).toEqual([["t1", "box"]]);
    // a page he drives reads so, in the foreground
    cleanup();
    render(<Tile tile={tile({ driving: true, doing: null })} onOpenSession={() => undefined} />);
    expect(tileLine(tile({ driving: true, doing: "stale" }))).toBe("You are driving");
    expect(screen.getByText("You are driving").className).toContain("text-foreground");
    // between calls there is only where it runs
    cleanup();
    render(<Tile tile={tile({ doing: null })} onOpenSession={() => undefined} />);
    expect([...screen.getByRole("article").querySelector('[data-slot="facts"]')!.children].map((c) => c.textContent)).toEqual(["The box"]);
  });

  it("gives the Windows VM he drives one quiet Keys menu beside Hand back, and the browser none", async () => {
    const pressed: unknown[] = [];
    vi.spyOn(await import("../lib/computerVideo"), "pressKeys").mockImplementation(async (...args) => (pressed.push(args), true));
    const base = tile();
    const vmTile = tile({ browser: false, computer: "vm:windows", driving: true, doing: null, entry: { ...base.entry, previewHost: "box", previewKey: "vm:windows" } });
    render(<Tile tile={vmTile} onOpenSession={() => undefined} />);
    const keys = screen.getByRole("button", { name: "Keys" });
    expect(keys.getAttribute("data-variant")).toBe("ghost");
    expect(screen.getByRole("button", { name: "Hand back" }).getAttribute("data-variant")).toBe("default");
    fireEvent.click(keys);
    expect((await screen.findAllByRole("menuitem")).map((m) => m.textContent)).toEqual(["Windows key", "Ctrl+Alt+Del", "Alt+Tab"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Ctrl+Alt+Del" }));
    await act(async () => {});
    expect(pressed).toEqual([["box", "vm:windows", [224, 226, 76]]]);
    cleanup();
    render(<Tile tile={tile({ driving: true, doing: null })} onOpenSession={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Keys" })).toBeNull();
  });

  it("shows the stage's controls always: Take over only where the computer takes input, Stop unless it is idle, and Hand back alone while he drives", () => {
    render(<Tile tile={tile()} onOpenSession={() => undefined} />);
    const controls = screen.getByRole("article").querySelector<HTMLElement>('[data-slot="computer-controls"]')!;
    // never behind a hover
    expect(controls.parentElement!.className).not.toContain("opacity-0");
    expect(within(controls).getByRole("button", { name: "Take over" }).getAttribute("data-variant")).toBe("secondary");
    expect(within(controls).getByRole("button", { name: "Stop File the March expense report" })).not.toBeNull();
    cleanup();
    // a Mac's own window takes no input; the Windows VM does
    render(<Tile tile={tile({ browser: false, computer: "window:t1" })} onOpenSession={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    cleanup();
    render(<Tile tile={tile({ browser: false, computer: "vm:windows" })} onOpenSession={() => undefined} />);
    expect(screen.getByRole("button", { name: "Take over" })).not.toBeNull();
    cleanup();
    // ...unless it has no window of its own (its tools are missing): its 4 fps picture alone
    render(<Tile tile={tile({ browser: false, computer: "vm:windows", pictureOnly: true })} onOpenSession={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    cleanup();
    // an idle page has nothing to stop
    render(<Tile tile={tile({ idle: true, doing: null })} onOpenSession={() => undefined} />);
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    cleanup();
    render(<Tile tile={tile({ driving: true, doing: null })} onOpenSession={() => undefined} />);
    const back = screen.getByRole("button", { name: "Hand back" });
    expect(back.getAttribute("data-variant")).toBe("default");
    expect(back.hasAttribute("data-hand-back")).toBe(true);
    expect(back.querySelector("kbd")).not.toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).not.toContain("Take over");
  });

  it("plays the stage's stream as the one he watches, a strip tile's without taking the box's display, and opens the full window on a click of the stage's picture", () => {
    h.tiles = [tile(), tile({ id: "box\nt2", computer: "browser:t2", entry: { ...tile().entry, previewKey: "t2", row: { ...tile().entry.row, threadId: "t2", lastCallAt: 0 } } })];
    render(<ComputersView onClose={() => undefined} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />);
    expect(h.streams.findLast((s) => s.key === "t1")).toMatchObject({ take: true, run: true });
    expect(h.streams.findLast((s) => s.key === "t2")).toMatchObject({ take: false, run: true });
    fireEvent.click(screen.getByRole("button", { name: "Live view of Expense report in Chromium" }));
    expect(fullWindowTarget()).toEqual({ host: "box", threadId: "t1", name: "Live view of Expense report in Chromium" });
    closeFullWindow();
  });

  it("says a picture stopped in one line with Retry, and keeps the tile's caption and controls", () => {
    h.tiles = [tile()];
    h.ended = "error";
    render(<ComputersView onClose={() => undefined} onToggleSidebar={() => undefined} onOpenSession={() => undefined} />);
    expect(screen.getByText("The preview stopped")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
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
    expect(box.calls).toEqual(["work.winvm.state", "work.winvm.wake"]);
    expect(within(tile).getByRole("status").textContent).toBe("Waking the Windows VM");
    // the box keeps the picture's 16:10 so nothing moves when it comes
    expect((tile.querySelector('[data-face="none"]') as HTMLElement).style.aspectRatio).toBe("1280 / 800");
    expect(within(tile).getByRole("button", { name: "Take over" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Wake the Windows VM/ })).toBeNull();
    // the caption says where it runs; its state is said once, in the box
    expect(within(tile).queryByText(/^Asleep/)).toBeNull();
  });

  it("says where to set it up when it is not, and offers no Take over; a host that cannot have one shows nothing", async () => {
    const { workSwitch } = await import("../lib/workSwitch");
    vi.spyOn(workSwitch, "hosts").mockReturnValue(new Set(["box"]));
    host(() => state("none"));
    render(view());
    const tile = await screen.findByRole("article", { name: "Windows VM" });
    expect(within(tile).getByText("Not set up: Settings → Work → Windows VM")).not.toBeNull();
    expect(within(tile).queryByRole("button", { name: "Take over" })).toBeNull();
    cleanup();
    host(() => state("none", "The Windows VM runs on the box."));
    render(view());
    await act(async () => {});
    expect(screen.queryByRole("article", { name: "Windows VM" })).toBeNull();
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
    expect(screen.getByText("Couldn't wake the Windows VM: no door")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(tries).toBe(2);
  });
});
