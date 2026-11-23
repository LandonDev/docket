// @vitest-environment jsdom
/**
 * The canvas pane beside a Work thread (docs/DESIGN.md "The canvas pane"):
 * the tab row, the fold, the kind's bar with the one stepper, the selection
 * bar and Ask, all through `CanvasShell`, with a host that answers from a
 * list and a kind the test drives.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasItem } from "@shared/work";
import { useEffect } from "react";
import { contextChipsOf, resetContextChips } from "./chips";
import { X } from "../../chrome/icons";
import { openMenus } from "../../chrome/menuRows";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
import { BAR_TOOLS_ONLY, NARROW_HIDE } from "./KindBar";
import type { CanvasShell, ReviewAdapter } from "./kind";
import { canvasItem, drivenKinds, fakeHost } from "./testkit";

// One link for the window, as the registry hands the store at load; each test puts its own host behind it.
const host = vi.hoisted(() => ({
  current: null as ReturnType<typeof import("./testkit").fakeHost> | null,
  pushes: new Set<(push: never) => void>(),
  opens: new Set<() => void>(),
}));
// Every kind is built now (mail last, milestone 23): the stub test stands mail on the frame's stub body.
vi.mock("../mail/canvas", async () => {
  const { defineChunk } = await import("../../lib/lazyChunk");
  const { Mail } = await import("../icons");
  return { mailCanvas: { kind: "mail", label: "Mail", icon: Mail, opens: {}, phone: "native", guestable: false, chunk: defineChunk("work-mail-canvas-stub", () => import("./NotBuilt")) } };
});
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "local",
    connected: true,
    request: (method: string, params?: Record<string, unknown>) => host.current!.link.request(method, params),
    onPush: (listener: (push: never) => void) => (host.pushes.add(listener), () => host.pushes.delete(listener)),
    onOpen: (listener: () => void) => (host.opens.add(listener), () => host.opens.delete(listener)),
    onClose: () => () => undefined,
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, onLink: (listener: (l: typeof link, event: string) => void) => (listener(link, "added"), () => undefined) } };
});

import { CanvasSeat } from "./CanvasSeat";
import { applyCanvasPush, canvasOf, resetCanvasStore } from "./store";
import { setOpening } from "./fileDrop";

const session = { id: "t1", environmentId: "local" };
const DOC = canvasItem("doc", { title: "Run of show" });
const SHEET = canvasItem("sheet", { kind: "sheet", title: "Travel budget" });

beforeEach(async () => {
  // jsdom has no pointer capture; a tab's press starts the reorder's drag watch.
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
  HTMLElement.prototype.releasePointerCapture ??= () => undefined;
  localStorage.clear();
  resetCanvasStore();
  resetContextChips();
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

async function seat(items: CanvasItem[], kinds?: Parameters<typeof CanvasSeat>[0]["kinds"]) {
  host.current = fakeHost(items, host as never);
  const view = render(
    <CanvasSeat session={session} kinds={kinds}>
      <div data-testid="thread">
        <div data-composer-input tabIndex={0} />
      </div>
    </CanvasSeat>,
  );
  await waitFor(() => expect(canvasOf("t1").loaded).toBe(true));
  await act(async () => {});
  return view;
}

describe("the state line's words", () => {
  it("says a transport's own words as a person reads them", async () => {
    const { detailWords } = await import("./CanvasPane");
    expect(detailWords("not connected")).toBe("The host is not connected");
    expect(detailWords("request timed out after 15 s")).toBe("The host did not answer in time");
    expect(detailWords("that file is not there any more")).toBe("that file is not there any more");
  });
});

describe("a body that fails", () => {
  /** The document kind with a body that throws while `fail` says so, or whose code never arrives. */
  async function failing(how: "throws" | "no code") {
    const { defineChunk } = await import("../../lib/lazyChunk");
    const { CANVAS } = await import("./registry");
    const state = { fail: true as boolean, error: new Error("the sheet's workbook is damaged") as Error };
    function Body({ item, shell }: { item: CanvasItem; shell: CanvasShell }) {
      useEffect(() => shell.statusLine({ tone: "waiting", word: "Reading the workbook" }), [shell]);
      if (state.fail) throw state.error;
      return <p data-testid="body">The body of {item.title}</p>;
    }
    const chunk = defineChunk(`failing-${how}`, () => (how === "throws" ? Promise.resolve({ Body }) : Promise.reject(new TypeError("Failed to fetch dynamically imported module: tempcode-app://renderer/assets/work-docs-canvas-x1.js"))));
    return { state, kinds: { ...CANVAS, document: { ...CANVAS.document, history: false, chunk } } };
  }

  it("says why on the item's state line with Retry, and Retry shows the body once it can", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { state, kinds } = await failing("throws");
    await seat([DOC], kinds as never);
    const line = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-canvas-state="failed"]');
      expect(found).toBeTruthy();
      return found!;
    });
    expect(line.textContent).toContain("Couldn't open this document");
    expect(line.textContent).toContain("the sheet's workbook is damaged");
    state.fail = false;
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Retry" })));
    expect(await screen.findByTestId("body")).toBeTruthy();
    expect(document.querySelector('[data-canvas-state="failed"]')).toBeNull();
    quiet.mockRestore();
  });

  it("drops what the body fed the frame before it threw, and says a fault in its code plainly", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { state, kinds } = await failing("throws");
    state.fail = false;
    await seat([DOC], kinds as never);
    await screen.findByTestId("body");
    await waitFor(() => expect(document.querySelector('[data-canvas-state="waiting"]')?.textContent).toContain("Reading the workbook"));
    state.fail = true;
    state.error = new TypeError("Cannot read properties of undefined (reading 'rows')");
    await act(async () => applyCanvasPush({ sessionId: "t1", items: [{ ...DOC, title: "Run of show 2" }] }));
    const line = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-canvas-state="failed"]');
      expect(found).toBeTruthy();
      return found!;
    });
    expect(line.textContent).toContain("It could not be shown");
    expect(line.textContent).not.toContain("Cannot read");
    expect(document.querySelector('[data-canvas-state="waiting"]')).toBeNull();
    quiet.mockRestore();
  });

  it("says a viewer whose code did not load in his words, not as a module address", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { kinds } = await failing("no code");
    await seat([DOC], kinds as never);
    const line = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-canvas-state="failed"]');
      expect(found).toBeTruthy();
      return found!;
    });
    expect(line.textContent).toContain("Its viewer did not load");
    expect(line.textContent).not.toContain("tempcode-app://");
    expect(within(line).getByRole("button", { name: "Retry" })).toBeTruthy();
    quiet.mockRestore();
  });
});

describe("a file from outside", () => {
  it("says what is opening: alone in an empty pane, and the bar once it is big", async () => {
    const { container } = await seat([]);
    const cancel = vi.fn();
    const token = {};
    act(() => setOpening("t1", token, { name: "Cut 3.mov", sent: 4 * 1024 * 1024, total: 8 * 1024 * 1024, cancel }));
    await waitFor(() => expect(container.querySelector("[data-file-opening]")).toBeTruthy());
    expect(screen.getByText("Opening Cut 3.mov")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Uploading Cut 3.mov" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
    // A small file has the spinner and its name alone.
    act(() => setOpening("t1", token, { name: "Brief.pdf", sent: 0, total: 30_000, cancel }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    act(() => setOpening("t1", token, null));
    await waitFor(() => expect(container.querySelector("[data-board]")).toBeNull());
  });

  it("beside an item it is a row at the pane's foot, and each open keeps its own line", async () => {
    const { container } = await seat([DOC]);
    const big = {};
    const small = {};
    act(() => setOpening("t1", big, { name: "Cut 3.mov", sent: 1, total: 8 * 1024 * 1024, cancel: () => undefined }));
    act(() => setOpening("t1", small, { name: "Brief.pdf", sent: 0, total: 10, cancel: () => undefined }));
    await waitFor(() => expect(screen.getByText("Opening Brief.pdf")).toBeTruthy());
    expect(container.querySelector("[data-canvas-pane]")).toBeTruthy();
    // The small one landing leaves the big one's line, with its Cancel.
    act(() => setOpening("t1", small, null));
    expect(screen.getByText("Opening Cut 3.mov")).toBeTruthy();
    act(() => setOpening("t1", big, null));
    expect(container.querySelector("[data-file-opening]")).toBeNull();
  });
});

describe("a Work thread's canvas", () => {
  it("leaves the thread alone in the pane while no item is open", async () => {
    const { container } = await seat([]);
    expect(screen.getByTestId("thread")).toBeTruthy();
    expect(container.querySelector("[data-board]")).toBeNull();
    expect(container.querySelector("[data-view-header]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Conversation" })).toBeNull();
  });

  it("shows two stub items as tabs, the first shown, each saying it is not built", async () => {
    // Mail stands on the stub body here (the mock above).
    const { container } = await seat([{ ...DOC, kind: "mail" }, SHEET]);
    const tabs = within(screen.getByRole("tablist", { name: "Open items" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Run of show", "Travel budget"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    await waitFor(() => expect(screen.getByText("Not built yet")).toBeTruthy());
    expect(container.querySelector("[data-canvas-pane]")?.getAttribute("data-kind")).toBe("mail");
    // A stub feeds the frame nothing, so its bar is not drawn.
    expect(container.querySelector("[data-canvas-bar]")).toBeNull();
    // The thread stays beside it, in the same element.
    expect(screen.getByTestId("thread")).toBeTruthy();

    fireEvent.pointerDown(tabs[1], { button: 0 });
    expect(canvasOf("t1").selected).toBe("sheet");
    await waitFor(() => expect(container.querySelector("[data-canvas-pane]")?.getAttribute("data-kind")).toBe("sheet"));
  });

  it("names one item alone as a title, with the kind's one fact after it", async () => {
    let shell: CanvasShell | null = null;
    const { container } = await seat([DOC], drivenKinds((s) => (shell = s)));
    await waitFor(() => expect(shell).not.toBeNull());
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(container.querySelector("[data-view-title]")?.textContent).toBe("Run of show");
    act(() => shell!.detail("Landon's MacBook"));
    expect(container.querySelector("[data-view-detail]")?.textContent).toBe("Landon's MacBook");
  });

  it("folds the thread away and brings it back, and remembers the fold", async () => {
    const { container, unmount } = await seat([DOC, SHEET]);
    const chat = container.querySelector<HTMLElement>("[data-chat]")!;
    expect(chat.hasAttribute("inert")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(chat.hasAttribute("inert")).toBe(true);
    expect(canvasOf("t1").folded).toBe(true);
    // The thread is still mounted: its transcript keeps its place.
    expect(screen.getByTestId("thread")).toBeTruthy();

    // A restart: the window forgot everything but what it stored, and the host still has the items.
    unmount();
    resetCanvasStore();
    const again = await seat([DOC, SHEET]);
    expect(again.container.querySelector("[data-chat]")!.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(again.container.querySelector("[data-chat]")!.hasAttribute("inert")).toBe(false);
  });

  it("follows the host: a push opens a tab and shows it, and closing the last gives the pane back", async () => {
    const { container } = await seat([DOC]);
    act(() => host.current!.push([DOC, SHEET], "sheet"));
    expect(within(screen.getByRole("tablist")).getAllByRole("tab")).toHaveLength(2);
    expect(canvasOf("t1").selected).toBe("sheet");
    act(() => host.current!.push([]));
    expect(container.querySelector("[data-board]")).toBeNull();
    expect(screen.getByTestId("thread")).toBeTruthy();
  });

  it("asks the host a thread moved to, so the host it left never answers for it again", async () => {
    const view = await seat([DOC]);
    const lists = (): number => host.current!.calls.filter((c) => c.method === "work.canvas.list").length;
    expect(lists()).toBe(1);
    // The thread is now another host's: the same thread id, shown from there.
    view.rerender(
      <CanvasSeat session={{ id: "t1", environmentId: "box" }}>
        <div data-testid="thread" />
      </CanvasSeat>,
    );
    await waitFor(() => expect(lists()).toBe(2));
    // The host it left reconnects: nothing is asked of it for this thread.
    view.rerender(
      <CanvasSeat session={{ id: "t1", environmentId: "box" }}>
        <div data-testid="thread" />
      </CanvasSeat>,
    );
    await act(async () => {});
    expect(lists()).toBe(2);
  });

  it("scrolls ten tabs in the row rather than over More and the toggle, fades the cut edge, and brings the selected tab into view", async () => {
    const reveal = vi.fn();
    const was = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = reveal;
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-canvas-tabs") ? 900 : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-canvas-tabs") ? 300 : 0;
    });
    try {
      const ten = Array.from({ length: 10 }, (_, i) => canvasItem(`item${i}`, { title: `Item ${i}` }));
      const { container } = await seat(ten);
      const list = screen.getByRole("tablist", { name: "Open items" });
      for (const c of ["overflow-x-auto", "scrollbar-none", "overscroll-none", "data-overflow-end:[--fade-end:24px]"]) expect(list.className).toContain(c);
      // More and the toggle sit outside the scroller, in the header's fixed end.
      const actions = container.querySelector("[data-view-actions]")!;
      expect(list.contains(within(actions as HTMLElement).getByRole("button", { name: "More" }))).toBe(false);
      expect(actions.contains(screen.getByRole("button", { name: "Conversation" }))).toBe(true);
      // More past the right edge: that edge fades; none past the left.
      expect(list.hasAttribute("data-overflow-end")).toBe(true);
      expect(list.hasAttribute("data-overflow-start")).toBe(false);
      // The last tab, chosen, comes into view.
      reveal.mockClear();
      fireEvent.pointerDown(within(list).getAllByRole("tab")[9], { button: 0 });
      await waitFor(() => expect(reveal).toHaveBeenCalled());
      expect((reveal.mock.instances.at(-1) as unknown as HTMLElement).getAttribute("data-canvas-tab")).toBe("item9");
      expect(reveal).toHaveBeenLastCalledWith({ inline: "nearest", block: "nearest" });
      // A mouse wheel turns sideways.
      fireEvent.wheel(list, { deltaY: 120, deltaX: 0 });
      expect(list.scrollLeft).toBe(120);
    } finally {
      Element.prototype.scrollIntoView = was;
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it("ties the shown tab to its panel: the tab controls the pane, the pane is named by its tab", async () => {
    await seat([DOC, SHEET]);
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    const panel = screen.getByRole("tabpanel", { name: "Run of show" });
    expect(panel.hasAttribute("data-canvas-pane")).toBe(true);
    expect(tabs[0]!.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0]!.id);
    // A tab whose panel is not drawn names none.
    expect(tabs[1]!.hasAttribute("aria-controls")).toBe(false);
    fireEvent.pointerDown(tabs[1]!, { button: 0 });
    await waitFor(() => expect(screen.getByRole("tabpanel", { name: "Travel budget" })).toBeTruthy());
    expect(within(screen.getByRole("tablist")).getAllByRole("tab")[1]!.getAttribute("aria-controls")).toBe(screen.getByRole("tabpanel").id);
  });

  it("gives one item alone, which has no tabs, no panel role", async () => {
    await seat([DOC]);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });

  it("closes a tab on a middle click, and from More", async () => {
    await seat([DOC, SHEET]);
    const [, second] = within(screen.getByRole("tablist")).getAllByRole("tab");
    fireEvent(second, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    await waitFor(() => expect(host.current!.calls.some((c) => c.method === "work.canvas.close" && c.params.itemId === "sheet")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("tablist")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close" }));
    await waitFor(() => expect(host.current!.calls.some((c) => c.method === "work.canvas.close" && c.params.itemId === "doc")).toBe(true));
  });
});

describe("an item of a kind this build does not know", () => {
  // A host a release ahead holds an item of a kind added since; this window's registry has no row for it.
  const NEWER = canvasItem("newer", { kind: "hologram" as never, title: "Stage plot.holo" });

  it("draws it as a tab by its name beside the others, and the pane says to update", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = await seat([DOC, NEWER]);
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Run of show", "Stage plot.holo"]);
    expect(tabs[1].querySelector("svg")).not.toBeNull();
    fireEvent.pointerDown(tabs[1], { button: 0 });
    await waitFor(() => expect(container.querySelector("[data-canvas-pane]")?.getAttribute("data-kind")).toBe("hologram"));
    await waitFor(() => expect(container.querySelector("[data-canvas-body]")?.textContent).toBe("Update TempCode to open this"));
    // No bar of its own, no History, no failure line: one quiet line and nothing else.
    expect(container.querySelector("[data-canvas-bar]")).toBeNull();
    expect(container.querySelector("[data-canvas-state]")).toBeNull();
    expect(quiet).not.toHaveBeenCalled();
    quiet.mockRestore();
    // The tab it sits beside still opens.
    fireEvent.pointerDown(within(screen.getByRole("tablist")).getAllByRole("tab")[0], { button: 0 });
    await waitFor(() => expect(container.querySelector("[data-canvas-pane]")?.getAttribute("data-kind")).toBe("document"));
  });

  it("names it alone as a title, and it closes from More like any other", async () => {
    const { container } = await seat([NEWER]);
    expect(container.querySelector("[data-view-title]")?.textContent).toBe("Stage plot.holo");
    await waitFor(() => expect(container.querySelector("[data-canvas-body]")?.textContent).toBe("Update TempCode to open this"));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close" }));
    await waitFor(() => expect(host.current!.calls.some((c) => c.method === "work.canvas.close" && c.params.itemId === "newer")).toBe(true));
  });
});

describe("the frame a kind drives through its shell", () => {
  const review = (over: Partial<ReviewAdapter> = {}): ReviewAdapter => ({
    groups: [{ id: "g1", label: "Venue for the spring LAN", by: "agent:box:t1", count: 6 }],
    index: 1,
    count: 6,
    step: vi.fn(),
    accept: vi.fn(async () => undefined),
    reject: vi.fn(async () => undefined),
    ...over,
  });

  async function driven(parts?: Parameters<typeof drivenKinds>[1]) {
    let shell: CanvasShell | null = null;
    const view = await seat([DOC, SHEET], drivenKinds((s) => (shell = s), parts));
    await waitFor(() => expect(shell).not.toBeNull());
    return { ...view, shell: shell! as CanvasShell };
  }

  it("steps through the changes and accepts or rejects the one the caret is in", async () => {
    const { shell, container } = await driven();
    expect(container.querySelector("[data-canvas-bar]")).toBeNull();
    const adapter = review();
    act(() => shell.review(adapter));
    const stepper = screen.getByRole("toolbar", { name: "Review changes" });
    expect(within(stepper).getByText("2/6")).toBeTruthy();
    fireEvent.click(within(stepper).getByRole("button", { name: "Next change" }));
    expect(adapter.step).toHaveBeenCalledWith(2);
    fireEvent.click(within(stepper).getByRole("button", { name: "Previous change" }));
    expect(adapter.step).toHaveBeenCalledWith(0);
    fireEvent.click(within(stepper).getByRole("button", { name: "Accept" }));
    expect(adapter.accept).toHaveBeenCalledWith(1);
    await act(async () => {});
    fireEvent.click(within(stepper).getByRole("button", { name: "Reject" }));
    expect(adapter.reject).toHaveBeenCalledWith(1);
    await act(async () => {});

    // At the ends a step has nowhere to go; with the caret in no change there is nothing to decide.
    act(() => shell.review(review({ index: 0 })));
    expect(within(stepper).getByRole("button", { name: "Previous change" }).hasAttribute("disabled")).toBe(true);
    act(() => shell.review(review({ index: -1 })));
    expect(within(stepper).getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(true);

    // Nothing left to review leaves no dead controls.
    act(() => shell.review(review({ index: -1, count: 0, groups: [] })));
    expect(screen.queryByRole("toolbar", { name: "Review changes" })).toBeNull();
  });

  it("names the group the change is in when there is more than one, and offers Accept all in More", async () => {
    const { shell } = await driven();
    const adapter = review({
      groups: [
        { id: "a", label: "Venue for the spring LAN", by: "agent:box:t1", count: 2 },
        { id: "b", label: "Dana Lee", by: "external:Dana Lee", count: 4 },
      ],
      index: 3,
    });
    act(() => shell.review(adapter));
    expect(within(screen.getByRole("toolbar", { name: "Review changes" })).getByText("Dana Lee")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Accept all" }));
    expect(adapter.accept).toHaveBeenCalledWith("all");
  });

  it("draws the bar in its one order: people, the mode, the kind's tools, then the changes", async () => {
    const { shell, container } = await driven({ bar: true, tabEnd: true });
    act(() => {
      shell.presence([
        { id: "sam", name: "Sam Ortiz" },
        { id: "dana", name: "Dana Lee" },
      ]);
      shell.mode({ value: "suggests", set: vi.fn(), note: "Others can edit this, so changes wait for you" });
      shell.review(review());
    });
    const bar = container.querySelector("[data-canvas-bar]")!;
    const order = [...bar.querySelectorAll("[data-person], [aria-haspopup='menu'], [data-testid='kind-tools'], [role='toolbar']")].map(
      (el) => el.getAttribute("data-person") ?? el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.textContent,
    );
    expect(order).toEqual(["sam", "dana", "Agent suggests", "kind-tools", "Review changes"]);
    expect(within(bar as HTMLElement).getByRole("group", { name: "Sam Ortiz, Dana Lee" })).toBeTruthy();
    // The kind's slot in the tab row sits before More.
    const actions = container.querySelector("[data-view-actions]")!;
    expect([...actions.children].map((el) => el.getAttribute("data-testid") ?? el.getAttribute("aria-label"))).toEqual(["tab-end", "More", "Conversation"]);
  });

  it("draws no bar while a kind's Bar renders nothing and nothing else is fed, and draws it once something is", async () => {
    const { shell, container } = await driven({ bar: "empty" });
    // The Bar stays mounted, so it can fill the bar later; the bar is hidden while its tools slot is empty.
    const bar = container.querySelector("[data-canvas-bar]")!;
    expect(bar.className).toContain(BAR_TOOLS_ONLY);
    expect(bar.querySelector("[data-canvas-tools]:empty")).not.toBeNull();
    expect(bar.matches(":has([data-canvas-tools]:empty)")).toBe(true);
    act(() => shell.mode({ value: "writes" }));
    expect(container.querySelector("[data-canvas-bar]")!.className).not.toContain(BAR_TOOLS_ONLY);
  });

  it("lets the kind's tools take the free room, so a tool can sit at the end before the stepper", async () => {
    const { shell, container } = await driven({ bar: "end" });
    act(() => shell.review(review()));
    const tools = container.querySelector("[data-canvas-tools]")!;
    expect(tools.className).toContain("flex-1");
    expect(within(tools as HTMLElement).getByTestId("kind-end").className).toContain("ms-auto");
    // A bar with tools that render is drawn whatever else is fed.
    expect(container.querySelector("[data-canvas-bar]")!.className).not.toContain(BAR_TOOLS_ONLY);
    const order = [...container.querySelectorAll("[data-canvas-bar] [data-testid], [data-canvas-bar] [role='toolbar']")].map((el) => el.getAttribute("data-testid") ?? el.getAttribute("aria-label"));
    expect(order).toEqual(["kind-tools", "kind-end", "Review changes"]);
  });

  it("puts a kind's own verbs first in More, runs the one picked, and takes them back with null", async () => {
    const { shell } = await driven();
    const exported = vi.fn();
    act(() => {
      shell.review(review());
      shell.more!([
        { id: "export", label: "Export transcript", icon: X, run: exported },
        { id: "download", label: "Download recording", icon: X, disabled: true, run: vi.fn() },
      ]);
    });
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const rows = (await screen.findAllByRole("menuitem")).map((row) => row.textContent);
    expect(rows).toEqual(["Export transcript", "Download recording", "Accept all", "Reject all", "Open file…", "Open from Google…", "Close", "Close others"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Export transcript" }));
    await waitFor(() => expect(exported).toHaveBeenCalledTimes(1));
    act(() => shell.more!(null));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Export transcript" })).toBeNull());
    expect(screen.getByRole("menuitem", { name: "Close" })).toBeTruthy();
  });

  it("lists a pillar's verb for the item after its own rows and before Close, and runs it with the item's host", async () => {
    const { registerItemVerb } = await import("./itemVerbs");
    const run = vi.fn();
    const off = registerItemVerb({ id: "file", label: "File as receipt", icon: X, when: (_item, kind) => kind === "document", run });
    try {
      await seat([DOC, SHEET]);
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      const rows = (await screen.findAllByRole("menuitem")).map((row) => row.textContent);
      expect(rows.slice(-3)).toEqual(["File as receipt", "Close", "Close others"]);
      fireEvent.click(screen.getByRole("menuitem", { name: "File as receipt" }));
      await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: DOC.id }), { environmentId: "local" }));
    } finally {
      off();
    }
  });

  it("switches the mode from its menu, and shows a mode that cannot be switched as words", async () => {
    const { shell, container } = await driven();
    const set = vi.fn();
    act(() => shell.mode({ value: "suggests", set, note: "Others can edit this, so changes wait for you" }));
    fireEvent.click(screen.getByRole("button", { name: "Agent suggests" }));
    expect(await screen.findByText("Others can edit this, so changes wait for you")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Agent writes" }));
    expect(set).toHaveBeenCalledWith("writes");
    act(() => shell.mode({ value: "writes" }));
    expect(screen.queryByRole("button", { name: "Agent writes" })).toBeNull();
    expect(container.querySelector("[data-canvas-bar]")!.textContent).toContain("Agent writes");
  });

  it("says what the agent wrote, with its way back, in the stepper's place", async () => {
    const { shell, container } = await driven();
    const undo = vi.fn(async () => undefined);
    act(() => shell.written({ text: "Changed 6 cells, 2:04 PM", undo }));
    const line = container.querySelector<HTMLElement>("[data-canvas-written]")!;
    expect(line.textContent).toContain("Changed 6 cells, 2:04 PM");
    fireEvent.click(within(line).getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
    await act(async () => {});
    // Changes to review take the slot back.
    act(() => shell.review(review()));
    expect(container.querySelector("[data-canvas-written]")).toBeNull();
  });

  it("draws one state line for a source that did not answer, with its one action", async () => {
    const { shell, container } = await driven();
    const run = vi.fn();
    act(() => shell.statusLine({ tone: "failed", word: "LifeOS did not answer", detail: "Read only, as of 2:04 PM", action: { label: "Retry", run } }));
    const line = container.querySelector<HTMLElement>("[data-canvas-state='failed']")!;
    expect(line.textContent).toContain("LifeOS did not answer");
    expect(line.textContent).toContain("Read only, as of 2:04 PM");
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    expect(run).toHaveBeenCalledOnce();
    act(() => shell.statusLine(null));
    expect(container.querySelector("[data-canvas-state]")).toBeNull();
  });

  it("floats the bar over a selection; Ask puts the chip in the thread's composer, unfolds the thread and drops the selection", async () => {
    const { shell, container } = await driven();
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(canvasOf("t1").folded).toBe(true);
    const chip = { kind: "selection" as const, label: "“Pools run on 24 stations”, Run of show", ref: DOC.source, quote: "Pools run on 24 stations" };
    act(() => shell.selection({ chip, rect: new DOMRect(40, 200, 120, 20), tools: <button type="button">Comment</button> }));
    const bar = await screen.findByRole("toolbar", { name: "Selection" });
    // Ask is first, then the kind's own controls.
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual([expect.stringMatching(/^Ask/), "Comment"]);
    fireEvent.click(within(bar).getByRole("button", { name: /^Ask/ }));
    expect(contextChipsOf("t1")).toEqual([chip]);
    expect(canvasOf("t1").folded).toBe(false);
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Selection" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector("[data-composer-input]")));
  });

  it("takes Ask's key while a selection is fed, and not without one", async () => {
    const { shell } = await driven();
    const chip = { kind: "selection" as const, label: "B4:C9, Travel budget", ref: DOC.source };
    fireEvent.keyDown(document, { key: "l", ctrlKey: true });
    expect(contextChipsOf("t1")).toEqual([]);
    act(() => shell.selection({ chip, rect: new DOMRect(0, 0, 10, 10) }));
    fireEvent.keyDown(document, { key: "l", ctrlKey: true });
    expect(contextChipsOf("t1")).toEqual([chip]);
  });

  it("takes what a kind says of saving and draws it nowhere: beside a thread there is no save line", async () => {
    const { shell, container } = await driven();
    const before = container.querySelector("[data-canvas-pane]")!.innerHTML;
    act(() => shell.saved?.({ state: "saved", at: 1_700_000_000_000, where: "Events" }));
    act(() => shell.saved?.({ state: "conflict", detail: "Dana changed this at 2:04 PM", actions: [{ id: "reload", label: "Reload", run: () => undefined }] }));
    expect(container.querySelector("[data-canvas-pane]")!.innerHTML).toBe(before);
    expect(container.textContent).not.toContain("Reload");
    act(() => shell.saved?.(null));
    expect(container.querySelector("[data-canvas-pane]")!.innerHTML).toBe(before);
  });

  it("starts another item from nothing: what one kind fed does not show on the next tab", async () => {
    const { shell, container } = await driven();
    act(() => shell.review(review()));
    expect(container.querySelector("[data-canvas-bar]")).not.toBeNull();
    fireEvent.pointerDown(within(screen.getByRole("tablist")).getAllByRole("tab")[1], { button: 0 });
    await waitFor(() => expect(container.querySelector("[data-canvas-pane]")?.getAttribute("data-kind")).toBe("sheet"));
    // The sheet kind draws History in its bar (milestone 27); what the first kind fed is gone.
    expect(screen.queryByRole("toolbar", { name: "Review changes" })).toBeNull();
    // A late call from the body that left is dropped.
    act(() => shell.statusLine({ tone: "failed", word: "Late" }));
    expect(container.querySelector("[data-canvas-state]")).toBeNull();
  });

  it("takes its narrow form under 560px of canvas by a container query: the group's name goes, History is its glyph, Reject and Accept stay whole", async () => {
    let shell: CanvasShell | null = null;
    const kinds = drivenKinds((s) => (shell = s), { bar: true });
    const view = await seat([DOC, SHEET], { ...kinds, document: { ...kinds.document, history: true } });
    await waitFor(() => expect(shell).not.toBeNull());
    act(() =>
      shell!.review(
        review({
          groups: [
            { id: "a", label: "Venue for the spring LAN", by: "agent:box:t1", count: 2 },
            { id: "b", label: "Dana Lee", by: "external:Dana Lee", count: 4 },
          ],
          index: 3,
        }),
      ),
    );
    const bar = view.container.querySelector<HTMLElement>("[data-canvas-bar]")!;
    // The same form wherever the bar is drawn, a static render included: CSS decides, not a measurement.
    expect(bar.className).toContain("@container/bar");
    const stepper = screen.getByRole("toolbar", { name: "Review changes" });
    expect(within(stepper).getByText("Dana Lee").className).toContain("@max-[560px]/bar:hidden");
    // History keeps its name for a screen reader, and only its word hides.
    const history = within(bar).getByRole("button", { name: "History" });
    expect(within(history).getByText("History").className).toContain("@max-[560px]/bar:hidden");
    // The end group gives up room after the tools, which are clipped to theirs, and only through the group's name: the verbs never shrink.
    expect(within(stepper).getByText("Dana Lee").className).toContain("truncate");
    for (const verb of ["Reject", "Accept"]) expect(within(stepper).getByRole("button", { name: verb }).className).toContain("shrink-0");
    for (const verb of ["Reject", "Accept"]) expect(within(stepper).getByRole("button", { name: verb })).toBeTruthy();
    expect(view.container.querySelector("[data-canvas-tools]")!.className).toContain("overflow-hidden");
  });

  it("sheds in its narrow form, by the same query, until the stepper and its verbs fit: the people go, the mode is short, Previous and Next go and 1/3 stays", async () => {
    let shell: CanvasShell | null = null;
    const kinds = drivenKinds((s) => (shell = s), { bar: "narrow" });
    const view = await seat([DOC, SHEET], { ...kinds, document: { ...kinds.document, history: true } });
    await waitFor(() => expect(shell).not.toBeNull());
    act(() => {
      shell!.presence([{ id: "sam", name: "Sam Ortiz" }]);
      shell!.mode({ value: "suggests", set: vi.fn() });
      shell!.review(review({ index: 0, count: 3 }));
    });
    const bar = view.container.querySelector<HTMLElement>("[data-canvas-bar]")!;
    const narrow = (el: Element) => expect(el.className).toContain(NARROW_HIDE);
    // Nothing spills past the bar; the count and the verbs never shrink (measured in Chromium from 340px to 864px of bar, Accept ends 8px from the edge).
    expect(bar.className).toContain("overflow-hidden");
    narrow(within(bar).getByRole("group", { name: "Sam Ortiz" }));
    // The mode keeps its full words as its name and in its menu; the bar shows the short word.
    const mode = within(bar).getByRole("button", { name: "Agent suggests" });
    expect(within(mode).getByText("Suggests").className).toContain("@max-[560px]/bar:inline");
    expect(within(mode).getByText("Agent suggests").className).toContain("@max-[560px]/bar:sr-only");
    const stepper = within(bar).getByRole("toolbar", { name: "Review changes" });
    narrow(within(stepper).getByRole("button", { name: "Previous change" }));
    narrow(within(stepper).getByRole("button", { name: "Next change" }));
    expect(within(stepper).getByText("1/3").className).not.toContain(NARROW_HIDE);
    expect(within(stepper).getByText("1/3").className).toContain("shrink-0");
    for (const verb of ["Reject", "Accept"]) {
      const button = within(stepper).getByRole("button", { name: verb });
      expect(button.className).not.toContain(NARROW_HIDE);
      expect(button.className).toContain("shrink-0");
    }
    // A tool its kind marks goes whole in the narrow form; one it does not stays, clipped to its room.
    const tools = view.container.querySelector<HTMLElement>("[data-canvas-tools]")!;
    expect(tools.className).toContain("@max-[560px]/bar:[&_[data-narrow-hide]]:hidden");
    expect(within(tools).getByTestId("kind-wide").hasAttribute("data-narrow-hide")).toBe(true);
  });

  it("drops the marked tools whole while the slot cannot hold its tools, above the narrow form too, and brings them back once it can", async () => {
    let room = 100;
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-canvas-tools") ? 180 : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-canvas-tools") ? room : 0;
    });
    try {
      let shell: CanvasShell | null = null;
      const view = await seat([DOC, SHEET], drivenKinds((s) => (shell = s), { bar: "narrow" }));
      await waitFor(() => expect(shell).not.toBeNull());
      const tools = () => view.container.querySelector<HTMLElement>("[data-canvas-tools]")!;
      act(() => shell!.mode({ value: "writes" }));
      expect(tools().hasAttribute("data-tight")).toBe(true);
      expect(tools().className).toContain("data-tight:[&_[data-narrow-hide]]:hidden");
      // Wider, but not as wide as the tools needed: still tight, so the tool does not come back to be cut.
      room = 150;
      act(() => shell!.mode({ value: "suggests" }));
      expect(tools().hasAttribute("data-tight")).toBe(true);
      room = 180;
      act(() => shell!.mode({ value: "writes" }));
      expect(tools().hasAttribute("data-tight")).toBe(false);
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it("holds History back while the kind says its item has not opened, so a loading or failed item has no bar for it alone", async () => {
    let shell: CanvasShell | null = null;
    const kinds = drivenKinds((s) => (shell = s));
    const view = await seat([DOC, SHEET], { ...kinds, document: { ...kinds.document, history: true } });
    await waitFor(() => expect(shell).not.toBeNull());
    const history = () => view.container.querySelector("[data-canvas-bar] button[aria-label='History']");
    // A kind that never says is drawn as opened.
    expect(history()).not.toBeNull();
    act(() => shell!.ready?.(false));
    expect(history()).toBeNull();
    expect(view.container.querySelector("[data-canvas-bar]")).toBeNull();
    act(() => shell!.ready?.(true));
    expect(history()).not.toBeNull();
  });

  it("with no change in hand, prints the count alone; Next takes the first change, unless the kind cannot show it from there", async () => {
    const { shell } = await driven();
    const adapter = review({ index: -1, count: 3 });
    act(() => shell.review(adapter));
    const stepper = screen.getByRole("toolbar", { name: "Review changes" });
    expect(within(stepper).queryByText(/\//)).toBeNull();
    expect(within(stepper).getByText("3")).toBeTruthy();
    expect(within(stepper).getByRole("button", { name: "Previous change" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(stepper).getByRole("button", { name: "Next change" }));
    expect(adapter.step).toHaveBeenCalledWith(0);
    // A form on its Responses: stepping shows nothing there, so Next is not lit.
    act(() => shell.review(review({ index: -1, count: 3, enter: false })));
    expect(within(stepper).getByRole("button", { name: "Next change" }).hasAttribute("disabled")).toBe(true);
    expect(within(stepper).getByText("3")).toBeTruthy();
  });

  it("while the kind holds its changes, keeps the stepper drawn with its steps, Reject and Accept off, and More's Accept all and Reject all off", async () => {
    const { shell } = await driven();
    const adapter = review({ index: 1, count: 3, held: true });
    act(() => shell.review(adapter));
    const stepper = screen.getByRole("toolbar", { name: "Review changes" });
    expect(within(stepper).getByText("2/3")).toBeTruthy();
    expect(within(stepper).getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(true);
    expect(within(stepper).getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(true);
    // The body draws no change to step to while it holds, so the steps rest too (round 9).
    fireEvent.click(within(stepper).getByRole("button", { name: "Next change" }));
    expect(adapter.step).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const all = await screen.findByRole("menuitem", { name: "Accept all" });
    expect(all.getAttribute("aria-disabled") ?? all.getAttribute("data-disabled")).not.toBeNull();
    fireEvent.click(all);
    fireEvent.click(screen.getByRole("menuitem", { name: "Reject all" }));
    expect(adapter.accept).not.toHaveBeenCalled();
    expect(adapter.reject).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    // Let go: the verbs come back on the same stepper.
    act(() => shell.review(review({ index: 1, count: 3 })));
    expect(within(stepper).getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(false);
  });

  it("while the kind holds only its verdicts, rests Reject, Accept and More's Accept all and Reject all, and leaves Previous and Next live", async () => {
    const { shell } = await driven();
    const adapter = review({ index: 1, count: 3, verdictsHeld: true });
    act(() => shell.review(adapter));
    const stepper = screen.getByRole("toolbar", { name: "Review changes" });
    expect(within(stepper).getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(true);
    expect(within(stepper).getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(true);
    // The steps stay live, so a keyboard review keeps its place in the bar and the other changes stay reachable.
    const next = within(stepper).getByRole("button", { name: "Next change" });
    const previous = within(stepper).getByRole("button", { name: "Previous change" });
    expect(next.hasAttribute("disabled")).toBe(false);
    expect(previous.hasAttribute("disabled")).toBe(false);
    fireEvent.click(next);
    expect(adapter.step).toHaveBeenCalledWith(2);
    fireEvent.click(previous);
    expect(adapter.step).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const all = await screen.findByRole("menuitem", { name: "Accept all" });
    expect(all.getAttribute("aria-disabled") ?? all.getAttribute("data-disabled")).not.toBeNull();
    fireEvent.click(all);
    fireEvent.click(screen.getByRole("menuitem", { name: "Reject all" }));
    expect(adapter.accept).not.toHaveBeenCalled();
    expect(adapter.reject).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  });

  it("holds the bar's place with a bone while a kind's code loads, so the body does not drop when it lands", async () => {
    const { defineChunk } = await import("../../lib/lazyChunk");
    let land: (module: unknown) => void = () => {};
    const chunk = defineChunk("test-kind-late", () => new Promise((resolve) => (land = resolve)));
    const kinds = drivenKinds(() => {}, { bar: true });
    const view = await seat([DOC, SHEET], { ...kinds, document: { ...kinds.document, chunk: chunk as never } });
    const bar = () => view.container.querySelector<HTMLElement>("[data-canvas-bar]");
    expect(bar()?.querySelector("[data-bar-bone]")).not.toBeNull();
    // The kind's own bar takes its place.
    await act(async () => land({ Body: () => <p>The body</p>, Bar: () => <span data-testid="kind-tools">Zoom</span> }));
    await waitFor(() => expect(bar()?.querySelector("[data-testid='kind-tools']")).not.toBeNull());
    expect(bar()!.querySelector("[data-bar-bone]")).toBeNull();
  });

  it("lets the keyboard reach a cut state detail and its whole words, and leaves a whole one out of the tab order", async () => {
    const { shell, container } = await driven();
    const cut = { value: false };
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return cut.value && this.classList.contains("truncate") ? 400 : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => 100);
    try {
      act(() => shell.statusLine({ tone: "failed", word: "Couldn't open this document", detail: "short" }));
      const whole = within(container.querySelector<HTMLElement>("[data-canvas-state]")!).getByText("short");
      expect(whole.hasAttribute("tabindex")).toBe(false);
      act(() => shell.statusLine(null));
      cut.value = true;
      act(() => shell.statusLine({ tone: "failed", word: "Couldn't open this document", detail: "The host refused the read: the file moved while it was being opened" }));
      const detail = within(container.querySelector<HTMLElement>("[data-canvas-state]")!).getByText(/The host refused/);
      expect(detail.getAttribute("tabindex")).toBe("0");
      expect(detail.className).toContain("focus-ring");
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  async function historyIn(narrow: boolean) {
    // The tooltips wake only once no control holds the focus and no press is held (an earlier test's composer and tab press may).
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.pointerUp(document);
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    await act(async () => {
      await tooltipChunk.load();
      warmTooltips();
    });
    let shell: CanvasShell | null = null;
    const kinds = drivenKinds((s) => (shell = s));
    const view = await seat([DOC, SHEET], { ...kinds, document: { ...kinds.document, history: true } });
    await waitFor(() => expect(shell).not.toBeNull());
    const history = within(view.container.querySelector<HTMLElement>("[data-canvas-bar]")!).getByRole("button", { name: "History" });
    // The container query hides the word in a narrow bar; jsdom draws no CSS, so the test hides it as the query would.
    if (narrow) within(history).getByText("History").style.display = "none";
    for (const pass of [0, 1]) {
      fireEvent.pointerEnter(history);
      fireEvent.mouseEnter(history);
      fireEvent.focus(history);
      await act(async () => {});
      fireEvent.pointerMove(history);
      fireEvent.mouseMove(history);
      if (pass === 0) {
        fireEvent.pointerLeave(history);
        fireEvent.mouseLeave(history);
      }
    }
    return () => [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((el) => el.textContent).find((t) => t === "History") ?? null;
  }

  it("gives History's glyph alone, in a narrow bar, the standard tip", async () => {
    const tip = await historyIn(true);
    await waitFor(() => expect(tip()).toBe("History"), { timeout: 2000 });
  });

  it("gives History no tip while its word shows", async () => {
    const tip = await historyIn(false);
    await new Promise((r) => setTimeout(r, 900));
    expect(tip()).toBeNull();
  });

  it("keeps one step in the narrow bar: the next change, and from the last back round to the first", async () => {
    const { shell } = await driven();
    const adapter = review({ index: 0, count: 3 });
    act(() => shell.review(adapter));
    const stepper = screen.getByRole("toolbar", { name: "Review changes" });
    const step = within(stepper).getByRole("button", { name: "Step to the next change" });
    // Drawn only by the narrow form; Previous and Next are the wide form's.
    expect(step.className).toContain("hidden");
    expect(step.className).toContain("@max-[560px]/bar:inline-flex");
    fireEvent.click(step);
    expect(adapter.step).toHaveBeenLastCalledWith(1);
    act(() => shell.review({ ...adapter, index: 2 }));
    fireEvent.click(within(stepper).getByRole("button", { name: "Step to the next change" }));
    expect(adapter.step).toHaveBeenLastCalledWith(0);
    // With none in hand, it takes the first, unless the kind cannot show it from there.
    act(() => shell.review({ ...adapter, index: -1 }));
    fireEvent.click(within(stepper).getByRole("button", { name: "Step to the next change" }));
    expect(adapter.step).toHaveBeenLastCalledWith(0);
    act(() => shell.review({ ...adapter, index: -1, enter: false }));
    expect(within(stepper).getByRole("button", { name: "Step to the next change" }).hasAttribute("disabled")).toBe(true);
  });

  it("rests every step while the kind holds its review, the count still drawn", async () => {
    const { shell } = await driven();
    act(() => shell.review(review({ index: 1, count: 3, held: true })));
    const stepper = screen.getByRole("toolbar", { name: "Review changes" });
    for (const name of ["Previous change", "Next change", "Step to the next change", "Reject", "Accept"]) expect(within(stepper).getByRole("button", { name }).hasAttribute("disabled"), name).toBe(true);
    expect(within(stepper).getByText("2/3")).toBeTruthy();
    act(() => shell.review(review({ index: 1, count: 3 })));
    expect(within(stepper).getByRole("button", { name: "Next change" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows one change already in hand as its two verbs alone: nowhere to step", async () => {
    const { shell } = await driven();
    act(() => shell.review(review({ groups: [{ id: "rewrite", label: "Rewrite", by: "agent:box:t1", count: 1 }], index: 0, count: 1 })));
    const stepper = screen.getByRole("toolbar", { name: "Review changes" });
    expect(within(stepper).queryByRole("button", { name: "Previous change" })).toBeNull();
    expect(within(stepper).queryByText("1/1")).toBeNull();
    expect(within(stepper).getAllByRole("button").map((b) => b.textContent)).toEqual(["Reject", "Accept"]);
  });

  it("spins the state line's action while it runs", async () => {
    const { shell, container } = await driven();
    let done: () => void = () => {};
    act(() => shell.statusLine({ tone: "failed", word: "Did not open", action: { label: "Retry", run: () => new Promise<void>((r) => (done = r)) } }));
    const retry = within(container.querySelector<HTMLElement>("[data-canvas-state]")!).getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(retry.hasAttribute("disabled")).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    await act(async () => done());
    expect(retry.hasAttribute("disabled")).toBe(false);
  });

  it("takes a kind's own Ask through the frame: the chip goes in, a folded thread unfolds, its composer takes the caret", async () => {
    const { shell, container } = await driven();
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(canvasOf("t1").folded).toBe(true);
    const chip = { kind: "selection" as const, label: "“Doors at noon”, Run of show", ref: DOC.source, quote: "Doors at noon" };
    act(() => shell.ask?.(chip));
    expect(contextChipsOf("t1")).toEqual([chip]);
    expect(canvasOf("t1").folded).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector("[data-composer-input]")));
  });

  it("opens an item's versions beside it as a history item on the same source", async () => {
    const { shell } = await driven();
    await act(async () => shell.openHistory());
    const open = host.current!.calls.find((c) => c.method === "work.canvas.open");
    expect(open?.params).toEqual({ sessionId: "t1", kind: "history", source: DOC.source, title: "Run of show" });
  });

  it("keeps a kind's view state for an item while another tab shows", async () => {
    const seen: unknown[] = [];
    let keep: ((next: unknown) => void) | null = null;
    await seat(
      [DOC, SHEET],
      drivenKinds((_shell, props) => {
        seen.push(props.state);
        keep = props.setState;
      }),
    );
    await waitFor(() => expect(keep).not.toBeNull());
    act(() => keep!({ scroll: 420 }));
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    fireEvent.pointerDown(tabs[1], { button: 0 });
    fireEvent.pointerDown(tabs[0], { button: 0 });
    await waitFor(() => expect(seen.at(-1)).toEqual({ scroll: 420 }));
  });

  it("applies a push that came before the pane ever asked", () => {
    host.current = fakeHost([], host as never);
    applyCanvasPush({ sessionId: "t9", items: [canvasItem("x", { sessionId: "t9" })], opened: "x" });
    expect(canvasOf("t9")).toMatchObject({ loaded: true, selected: "x" });
  });
});
