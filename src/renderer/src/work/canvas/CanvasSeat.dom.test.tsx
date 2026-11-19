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
import { contextChipsOf, resetContextChips } from "./chips";
import { X } from "../../chrome/icons";
import { openMenus } from "../../chrome/menuRows";
import { BAR_TOOLS_ONLY } from "./KindBar";
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
    expect(rows).toEqual(["Export transcript", "Download recording", "Accept all", "Reject all", "Open from Google…", "Close", "Close others"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Export transcript" }));
    await waitFor(() => expect(exported).toHaveBeenCalledTimes(1));
    act(() => shell.more!(null));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Export transcript" })).toBeNull());
    expect(screen.getByRole("menuitem", { name: "Close" })).toBeTruthy();
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
    // Reject and Accept never shrink; the end group gives up room after the tools, which are clipped to theirs.
    expect(stepper.className).toContain("shrink-0");
    for (const verb of ["Reject", "Accept"]) expect(within(stepper).getByRole("button", { name: verb })).toBeTruthy();
    expect(view.container.querySelector("[data-canvas-tools]")!.className).toContain("overflow-hidden");
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
