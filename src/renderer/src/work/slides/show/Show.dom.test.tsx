// @vitest-environment jsdom
/**
 * The show: the slideshow's surface and the presenter's view drawn on pages
 * of words in place of pdf.js, and a whole show run on places that stand in
 * for its windows: one state in two places, the file changing under it, a
 * window closed, the slideshow's display leaving, and a browser's frame.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShowDeck } from "@shared/contract-work-slides";
import { fakeDoc, fakeEngine } from "../../pdf/testkit";
import { Audience, PRESENT_IDLE_MS } from "./Audience";
import { mirrorLook, openFramePlace, type ShowPlace, type Surface } from "./places";
import { Presenter } from "./Presenter";
import { RENDER_CHANGED } from "../deck";
import { RETRY_FIRST_MS, showRunning, startShow, type ShowHost, type ShowNative } from "./Show";
import { NOTES_DEFAULT, showReducer, startShowState, type ShowAct, type ShowState, type Slide } from "./state";
import { startTimer } from "./timer";

const WIDE = { width: 640 * 0.75, height: 360 * 0.75 };
const pages = (count: number, word = "Slide") => fakeDoc(Array.from({ length: count }, (_, i) => ({ size: WIDE, runs: [{ str: `${word} ${i + 1}`, box: [0.1, 0.1, 0.6, 0.2] as [number, number, number, number] }] })));
const slide = (n: number, over: Partial<Slide> = {}): Slide => ({ id: 255 + n, number: n, page: n, title: `Slide ${n}`, notes: "", hidden: false, ...over });
const deck = (count: number, over: Record<number, Partial<Slide>> = {}): Slide[] => Array.from({ length: count }, (_, i) => slide(i + 1, over[i + 1]));
const ROOM = { width: 960, height: 540 };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  document.body.replaceChildren();
});

/** A surface on a state it moves itself, as the show's root does. */
function Held({ initial, children }: { initial: ShowState; children(state: ShowState, dispatch: (act: ShowAct) => void): React.ReactNode }) {
  const [state, setState] = React.useState(initial);
  return <>{children(state, (act) => setState((was) => showReducer(was, act)))}</>;
}
import * as React from "react";

const shownPage = (root: HTMLElement): string | null => root.querySelector("[data-show-picture]")?.getAttribute("data-page") ?? null;

describe("the slideshow", () => {
  function mount(initial: ShowState, doc = pages(12)) {
    render(<Held initial={initial}>{(state, dispatch) => <Audience state={state} dispatch={dispatch} doc={doc} room={ROOM} />}</Held>);
    return { root: document.querySelector<HTMLElement>('[data-show="audience"]')!, doc };
  }

  it("draws the slide to fit the window, with the page the next press shows painted ahead", async () => {
    const { root, doc } = mount(startShowState(deck(12), "start"));
    await waitFor(() => expect(shownPage(root)).toBe("1"));
    const picture = root.querySelector<HTMLElement>("[data-show-picture]")!;
    expect([picture.style.width, picture.style.height]).toEqual(["960px", "540px"]);
    await waitFor(() => expect(doc.painted).toContain(2));
    expect(root.querySelector('[data-show-page="2"]')!.className).toContain("invisible");
    // A press on the slide is a next press, and the picture painted ahead is there at once.
    fireEvent.click(root.querySelector("[data-show-slide]")!);
    await waitFor(() => expect(shownPage(root)).toBe("2"));
    expect(within(root).getByText("2 / 12")).toBeTruthy();
  });

  it("calls its bar for a real move of the pointer alone, and lets it go two seconds after the last", () => {
    vi.useFakeTimers();
    const { root } = mount(startShowState(deck(12), "start"));
    const bar = root.querySelector<HTMLElement>("[data-show-bar]")!;
    const on = (): boolean => bar.hasAttribute("data-on");
    expect(on()).toBe(false);
    expect(root.className).toContain("cursor-none");
    // A key never calls it.
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(on()).toBe(false);
    // The first reading only says where the pointer is; the same place again is no move.
    fireEvent.pointerMove(root, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(root, { clientX: 100, clientY: 100 });
    expect(on()).toBe(false);
    fireEvent.pointerMove(root, { clientX: 104, clientY: 100 });
    expect(on()).toBe(true);
    expect(bar.hasAttribute("inert")).toBe(false);
    expect(root.className).not.toContain("cursor-none");
    act(() => void vi.advanceTimersByTime(PRESENT_IDLE_MS - 1));
    expect(on()).toBe(true);
    act(() => void vi.advanceTimersByTime(1));
    expect(on()).toBe(false);
    expect(bar.hasAttribute("inert")).toBe(true);
    // It stays while the pointer rests on it.
    fireEvent.pointerMove(root, { clientX: 110, clientY: 100 });
    fireEvent.pointerEnter(bar);
    act(() => void vi.advanceTimersByTime(PRESENT_IDLE_MS * 2));
    expect(on()).toBe(true);
    fireEvent.pointerLeave(bar);
    expect(on()).toBe(false);
  });

  it("its bar steps, blanks and ends; the picker jumps to a slide and stays up with the bar", async () => {
    const { root } = mount(startShowState(deck(12), "start"));
    const bar = within(root.querySelector<HTMLElement>("[data-show-bar]")!);
    fireEvent.click(bar.getByRole("button", { name: "Next" }));
    expect(bar.getByText("2 / 12")).toBeTruthy();
    fireEvent.click(bar.getByRole("button", { name: "Previous" }));
    expect(bar.getByText("1 / 12")).toBeTruthy();
    fireEvent.click(bar.getByRole("button", { name: "Slides" }));
    const picker = root.querySelector<HTMLElement>("[data-show-picker]")!;
    expect(root.querySelector("[data-show-bar]")!.hasAttribute("data-on")).toBe(true);
    expect(within(picker).getAllByRole("option")).toHaveLength(12);
    expect(document.activeElement).toBe(within(picker).getByRole("option", { name: "Slide 1: Slide 1" }));
    // The arrows move four across.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(picker).getByRole("option", { name: "Slide 5: Slide 5" }));
    fireEvent.click(within(picker).getByRole("option", { name: "Slide 7: Slide 7" }));
    expect(root.querySelector("[data-show-picker]")).toBeNull();
    expect(bar.getByText("7 / 12")).toBeTruthy();
    fireEvent.click(bar.getByRole("button", { name: "Blank" }));
    expect(root.querySelector("[data-show-picture]")).toBeNull();
    expect(bar.getByRole("button", { name: "Blank" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(bar.getByRole("button", { name: "Blank" }));
    await waitFor(() => expect(shownPage(root)).toBe("7"));
  });

  it("a press anywhere on the screen is a next press: on the black of a blank it brings the slide back, on End of show it closes", () => {
    const acts: ShowAct[] = [];
    const ended = showReducer({ ...startShowState(deck(2), "start"), at: 1 }, { t: "next" });
    render(<Audience state={ended} dispatch={(act) => void acts.push(act)} doc={pages(2)} room={ROOM} barOn />);
    const root = document.querySelector<HTMLElement>('[data-show="audience"]')!;
    fireEvent.click(root);
    fireEvent.click(screen.getByText("End of show"));
    expect(acts).toEqual([{ t: "next" }, { t: "next" }]);
    // A press on the bar is the bar's alone.
    fireEvent.click(within(root).getByRole("button", { name: "Blank" }));
    expect(acts).toEqual([{ t: "next" }, { t: "next" }, { t: "blank" }]);
    expect(root.querySelector("[data-show-place]")!.getAttribute("aria-live")).toBe("polite");
  });

  it("keeps the slide on screen while the deck is drawn again after its file changed, and takes the new picture once it is whole", async () => {
    const before = pages(3, "Before");
    const after = pages(3, "After");
    const waiting: Array<() => void> = [];
    const release = (): void => waiting.splice(0).forEach((go) => go());
    const slow = { ...after, paint: (...args: Parameters<typeof after.paint>) => new Promise<void>((done) => void waiting.push(() => void after.paint(...args).then(done))) };
    const view = render(<Audience state={startShowState(deck(3), "start")} dispatch={() => undefined} doc={before} room={ROOM} />);
    const root = document.querySelector<HTMLElement>('[data-show="audience"]')!;
    await waitFor(() => expect(shownPage(root)).toBe("1"));
    view.rerender(<Audience state={startShowState(deck(3), "start")} dispatch={() => undefined} doc={slow} room={ROOM} />);
    // The old render's picture is still the one on screen.
    const visible = (): string[] => [...root.querySelectorAll<HTMLElement>("[data-show-page]")].filter((el) => !el.className.includes("invisible")).map((el) => el.textContent ?? "");
    await waitFor(() => expect(root.querySelectorAll("[data-show-page]").length).toBeGreaterThan(1));
    expect(visible()).toEqual(["Before 1"]);
    await act(async () => release());
    await waitFor(() => expect(visible()).toEqual(["After 1"]));
    expect(shownPage(root)).toBe("1");
  });

  it("says End of show on the matte after the last slide, and why when there is no picture", () => {
    const ended = showReducer({ ...startShowState(deck(2), "start"), at: 1 }, { t: "next" });
    render(<Audience state={ended} dispatch={() => undefined} doc={pages(2)} room={ROOM} />);
    expect(screen.getByText("End of show")).toBeTruthy();
    expect(document.querySelector("[data-show-picture]")).toBeNull();
    cleanup();
    render(<Audience state={startShowState(deck(2), "start")} dispatch={() => undefined} doc={null} error="There is no picture of the slides: LibreOffice is not installed on this host or on one it reaches." room={ROOM} />);
    expect(screen.getByText(/LibreOffice is not installed/)).toBeTruthy();
  });

  it("has no picker where a presenter's view holds it", () => {
    render(<Audience state={{ ...startShowState(deck(3), "start"), picker: true }} dispatch={() => undefined} doc={pages(3)} room={ROOM} picks={false} />);
    expect(screen.queryByRole("button", { name: "Slides" })).toBeNull();
    expect(document.querySelector("[data-show-picker]")).toBeNull();
    expect(document.querySelector("[data-show-bar]")!.hasAttribute("data-on")).toBe(false);
  });
});

describe("the presenter's view", () => {
  const NOW = Date.UTC(2026, 10, 23, 15, 4, 7);
  function mount(initial: ShowState, over: Partial<React.ComponentProps<typeof Presenter>> = {}, room = { width: 864, height: 540 }) {
    const calls: string[] = [];
    render(
      <Held initial={initial}>
        {(state, dispatch) => (
          <Presenter
            state={state}
            dispatch={dispatch}
            doc={pages(12)}
            timer={startTimer(NOW - 247_000)}
            target={20}
            onTimer={(a) => void calls.push(`timer ${a}`)}
            onTarget={(t) => void calls.push(`target ${t}`)}
            notesSize={NOTES_DEFAULT}
            onNotesSize={(by) => void calls.push(`notes ${by}`)}
            now={() => NOW}
            room={room}
            {...over}
          />
        )}
      </Held>,
    );
    return { root: document.querySelector<HTMLElement>('[data-show="presenter"]')!, calls };
  }

  it("shows the slide the room sees, the next press, the notes at his size, the time and the place", async () => {
    const { root } = mount(startShowState(deck(12, { 1: { notes: "Open with the turnout." } }), "start"));
    await waitFor(() => expect(shownPage(root.querySelector("[data-show-now]")!)).toBe("1"));
    await waitFor(() => expect(shownPage(root.querySelector("[data-show-next]")!)).toBe("2"));
    expect(root.querySelector("[data-show-elapsed]")!.textContent).toBe("4:07");
    expect(within(root).getByRole("button", { name: "of 20:00" })).toBeTruthy();
    expect(root.querySelector("[data-show-place]")!.textContent).toBe("1 / 12");
    const notes = root.querySelector<HTMLElement>("[data-show-notes]")!;
    expect(notes.textContent).toBe("Open with the turnout.");
    expect([notes.style.fontSize, notes.style.lineHeight]).toEqual(["20px", "30px"]);
    // The current slide is 528 wide at 864: the column is 288 and the insets and the gap 48.
    expect(root.querySelector<HTMLElement>("[data-show-now] [data-show-picture]")!.style.width).toBe("528px");
    expect(root.querySelector<HTMLElement>("[data-show-next] [data-show-picture]")!.style.width).toBe("288px");
  });

  it("a press on the slide or on the next picture advances; the strip jumps; Blank and End show do as they say", async () => {
    const { root } = mount(startShowState(deck(12), "start"));
    fireEvent.click(root.querySelector("[data-show-now]")!);
    expect(root.querySelector("[data-show-place]")!.textContent).toBe("2 / 12");
    fireEvent.click(root.querySelector("[data-show-next]")!);
    expect(root.querySelector("[data-show-place]")!.textContent).toBe("3 / 12");
    const strip = within(root.querySelector<HTMLElement>("[data-show-strip]")!);
    expect(strip.getAllByRole("option")).toHaveLength(12);
    expect(strip.getByRole("option", { name: "Slide 3: Slide 3" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(strip.getByRole("option", { name: "Slide 9: Slide 9" }));
    expect(root.querySelector("[data-show-place]")!.textContent).toBe("9 / 12");
    fireEvent.click(within(root).getByRole("button", { name: "Blank" }));
    expect(within(root).getByRole("button", { name: "Blank" }).getAttribute("aria-pressed")).toBe("true");
    // The presenter still sees the slide under the black, dimmed.
    expect(root.querySelector("[data-show-now] [data-show-picture]")!.className).toContain("opacity-45");
  });

  it("tells a screen reader which picture is which, and the place when it changes", async () => {
    const { root } = mount(startShowState(deck(12), "start"));
    expect(within(root).getByRole("button", { name: "Current slide 1, Slide 1" })).toBe(root.querySelector("[data-show-now]"));
    expect(within(root).getByRole("button", { name: "Next slide 2, Slide 2" })).toBe(root.querySelector("[data-show-next]"));
    const place = root.querySelector<HTMLElement>("[data-show-place]")!;
    expect([place.getAttribute("aria-live"), place.getAttribute("aria-label")]).toEqual(["polite", "Slide 1 of 12, Slide 1"]);
    fireEvent.click(within(root).getByRole("button", { name: "Blank" }));
    expect(place.getAttribute("aria-label")).toBe("The screen is black. Slide 1 of 12, Slide 1");
  });

  it("names the build the next press plays, and the end", () => {
    const { root } = mount({ ...startShowState(deck(2, { 1: { builds: 4 } }), "start"), step: 1 });
    expect(root.querySelector("[data-show-build]")!.textContent).toBe("Build 2 of 4");
    expect(root.querySelector("[data-show-next]")!.getAttribute("aria-label")).toBe("Next: build 2 of 4");
    cleanup();
    mount({ ...startShowState(deck(2), "start"), at: 1 });
    expect(within(document.querySelector<HTMLElement>('[data-show="presenter"]')!).getByText("End of show")).toBeTruthy();
    cleanup();
    mount({ ...startShowState(deck(2), "start"), at: 1, ended: true });
    expect(screen.getByText("A press closes the show")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
  });

  it("the timer pauses and restarts, the target is picked from its menu, and the notes' size steps", () => {
    const { root, calls } = mount(startShowState(deck(3), "start"));
    fireEvent.click(within(root).getByRole("button", { name: "Pause the timer" }));
    fireEvent.click(within(root).getByRole("button", { name: "Restart the timer" }));
    fireEvent.click(within(root).getByRole("button", { name: "Larger notes" }));
    fireEvent.click(within(root).getByRole("button", { name: "Smaller notes" }));
    fireEvent.click(within(root).getByRole("button", { name: "of 20:00" }));
    const menu = within(root).getByRole("menu", { name: "Target" });
    expect(within(menu).getAllByRole("menuitemradio").map((r) => r.textContent)).toEqual(["10:00", "15:00", "20:00", "30:00", "No target"]);
    expect(document.activeElement).toBe(within(menu).getByRole("menuitemradio", { name: "20:00" }));
    // An arrow in the open menu moves its rows, and never reaches the show.
    const reached = vi.fn();
    document.addEventListener("keydown", reached);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitemradio", { name: "30:00" }));
    expect(reached).not.toHaveBeenCalled();
    document.removeEventListener("keydown", reached);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "No target" }));
    expect(within(root).queryByRole("menu")).toBeNull();
    expect(calls).toEqual(["timer pause", "timer restart", "notes 1", "notes -1", "target null"]);
  });

  it("marks the time once he is past his target, and offers a target when he has none", () => {
    const { root } = mount(startShowState(deck(3), "start"), { timer: startTimer(NOW - 21 * 60_000), target: 20 });
    expect(root.querySelector("[data-show-elapsed]")!.hasAttribute("data-over")).toBe(true);
    cleanup();
    mount(startShowState(deck(3), "start"), { target: null });
    expect(screen.getByRole("button", { name: "Set a target" })).toBeTruthy();
    expect(document.querySelector("[data-show-elapsed]")!.hasAttribute("data-over")).toBe(false);
  });

  it("under 640px the column stacks under the slide and the clock and the timer's buttons go", () => {
    const { root } = mount(startShowState(deck(3), "start"), {}, { width: 400, height: 700 });
    expect(root.querySelector("[data-show-clock]")).toBeNull();
    expect(within(root).queryByRole("button", { name: "Pause the timer" })).toBeNull();
    expect(root.querySelector("[data-show-body]")!.className).toContain("flex-col");
    expect(root.querySelector<HTMLElement>("[data-show-now] [data-show-picture]")!.style.width).toBe("368px");
  });

  it("shows bones while the deck is read, and the line the slideshow's display left", () => {
    const { root } = mount(startShowState([], "start"), { doc: null, loading: true, notice: "The slideshow's display was disconnected" });
    expect(root.querySelectorAll('[data-slot="skeleton"]').length).toBe(2);
    expect(within(root).getByRole("status").textContent).toBe("The slideshow's display was disconnected");
  });
});

// ── a whole show, on places that stand in for its windows ────────────

function place(surface: Surface): ShowPlace & { leave(): void; closed: boolean } {
  const body = document.createElement("div");
  body.dataset.place = surface;
  document.body.appendChild(body);
  const listeners = new Set<() => void>();
  const p = {
    surface,
    win: window,
    body,
    closed: false,
    onGone: (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener)),
    close: () => {
      p.closed = true;
      body.remove();
    },
    leave: () => listeners.forEach((fn) => fn()),
  };
  return p;
}

function showHost(initial: ShowDeck) {
  const listeners = new Set<(rev: string) => void>();
  const readies = new Set<(rev: string) => void>();
  const host = {
    steps: [] as string[],
    step: async (rev: string) => (host.steps.push(rev), new Uint8Array()),
    media: async (_rev: string, _offset: number, length: number) => new Uint8Array(length),
    onReady: (listener: (rev: string) => void) => (readies.add(listener), () => void readies.delete(listener)),
    ready: (rev: string) => readies.forEach((fn) => fn(rev)),
    deck: initial,
    shows: 0,
    reads: [] as string[],
    show: async () => (host.shows++, host.deck),
    read: async (_offset: number, _length: number, rev: string) => (host.reads.push(rev), new Uint8Array()),
    onRev: (listener: (rev: string) => void) => (listeners.add(listener), () => void listeners.delete(listener)),
    change(deck: ShowDeck) {
      host.deck = deck;
      for (const fn of listeners) fn(deck.rev);
    },
    tell: (rev: string) => listeners.forEach((fn) => fn(rev)),
  } satisfies ShowHost & Record<string, unknown>;
  return host;
}

const showDeck = (count: number, over: Partial<ShowDeck> = {}): ShowDeck => ({ itemId: "deck1", name: "Sponsor deck.pptx", rev: "r1", render: { rev: "f1", size: 1000, pages: count }, slides: deck(count), ...over });

function nativeShow(answer: { audience: string | null; presenter: string | null } = { audience: "tc-show-n1", presenter: "tc-show-n1-presenter" }) {
  const gone = new Set<() => void>();
  const native = {
    calls: [] as string[],
    displays: async () => [],
    begin: async (ask: { mode: string; display?: number }) => (native.calls.push(`begin ${ask.mode}${ask.display !== undefined ? ` ${ask.display}` : ""}`), answer),
    end: async () => void native.calls.push("end"),
    onDisplayGone: (cb: () => void) => (gone.add(cb), () => void gone.delete(cb)),
    displayGone: () => gone.forEach((fn) => fn()),
  } satisfies ShowNative & Record<string, unknown>;
  return native;
}

const text = (p: ShowPlace, selector: string): string | null => p.body.querySelector(selector)?.textContent ?? null;

describe("a show", () => {
  async function start(over: Partial<Parameters<typeof startShow>[0]> = {}, count = 12) {
    const host = showHost(showDeck(count));
    const places: Record<string, ReturnType<typeof place>> = {};
    const engine = fakeEngine(() => pages(count));
    let handle!: Awaited<ReturnType<typeof startShow>>;
    await act(async () => {
      handle = await startShow({ host, title: "Sponsor deck", from: "start", mode: "windowed", engine, native: null, open: (surface) => (places[surface] = place(surface)), ...over });
    });
    return { host, places, engine, handle };
  }

  it("is one state in two places: a key in either window moves both", async () => {
    const { places, handle } = await start();
    const { audience, presenter } = places;
    await waitFor(() => expect(text(presenter, "[data-show-place]")).toBe("1 / 12"));
    fireEvent.keyDown(audience.body, { key: "PageDown" });
    expect(text(audience, "[data-show-place]")).toBe("2 / 12");
    expect(text(presenter, "[data-show-place]")).toBe("2 / 12");
    fireEvent.keyDown(presenter.body, { key: "7" });
    fireEvent.keyDown(presenter.body, { key: "Enter" });
    expect(text(audience, "[data-show-place]")).toBe("7 / 12");
    // With a presenter's view the picker is its strip: G hands it the keyboard, the arrows move along it, Return jumps.
    expect(within(audience.body).queryByRole("button", { name: "Slides" })).toBeNull();
    fireEvent.keyDown(presenter.body, { key: "g" });
    const strip = presenter.body.querySelector<HTMLElement>("[data-show-strip]")!;
    expect(document.activeElement).toBe(within(strip).getByRole("option", { name: "Slide 7: Slide 7" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(text(presenter, "[data-show-place]")).toBe("7 / 12");
    fireEvent.click(document.activeElement!);
    expect(text(presenter, "[data-show-place]")).toBe("8 / 12");
    expect(document.activeElement).toBe(presenter.body.querySelector('[data-show="presenter"]'));
    await act(async () => handle.end());
  });

  it("+ and − step the notes' size, kept for the next show; a key with ⌘ is the window's", async () => {
    const { places, handle } = await start();
    await waitFor(() => expect(text(places.presenter, "[data-show-notes-size]")).toBe("20"));
    fireEvent.keyDown(places.presenter.body, { key: "+" });
    expect(text(places.presenter, "[data-show-notes-size]")).toBe("24");
    fireEvent.keyDown(places.presenter.body, { key: "-" });
    fireEvent.keyDown(places.presenter.body, { key: "-" });
    expect(text(places.presenter, "[data-show-notes-size]")).toBe("18");
    const untouched = fireEvent.keyDown(places.audience.body, { key: "ArrowRight", metaKey: true });
    expect(untouched).toBe(true);
    expect(text(places.audience, "[data-show-place]")).toBe("1 / 12");
    // A clicker's F5 is taken, so a browser never reloads on it.
    expect(fireEvent.keyDown(places.audience.body, { key: "F5" })).toBe(false);
    await act(async () => handle.end());
    const again = await start();
    await waitFor(() => expect(text(again.places.presenter, "[data-show-notes-size]")).toBe("18"));
    await act(async () => again.handle.end());
  });

  it("Return and Space on a control he tabbed to press that control; after a press with the pointer they are the show's again", async () => {
    const { places, handle } = await start();
    const { presenter } = places;
    await waitFor(() => expect(text(presenter, "[data-show-place]")).toBe("1 / 12"));
    const blank = within(presenter.body).getByRole("button", { name: "Blank" });
    blank.focus();
    // The key is left to the button: the show neither takes it nor moves.
    expect(fireEvent.keyDown(blank, { key: " " })).toBe(true);
    expect(fireEvent.keyDown(blank, { key: "Enter" })).toBe(true);
    expect(text(presenter, "[data-show-place]")).toBe("1 / 12");
    // An arrow on a focused button is still the show's.
    fireEvent.keyDown(blank, { key: "ArrowRight" });
    expect(text(presenter, "[data-show-place]")).toBe("2 / 12");
    // A press with the pointer hands the keyboard back to the view, so Space is the next slide.
    fireEvent.click(blank, { detail: 1 });
    expect(document.activeElement).toBe(presenter.body.querySelector('[data-show="presenter"]'));
    fireEvent.click(blank, { detail: 1 });
    fireEvent.keyDown(document.activeElement!, { key: " " });
    expect(text(presenter, "[data-show-place]")).toBe("3 / 12");
    // The target's button opens its menu from the keyboard, and the menu keeps the keyboard.
    const target = within(presenter.body).getByRole("button", { name: "Set a target" });
    target.focus();
    expect(fireEvent.keyDown(target, { key: "Enter" })).toBe(true);
    fireEvent.click(target, { detail: 0 });
    expect(within(presenter.body).getByRole("menu", { name: "Target" })).toBeTruthy();
    await act(async () => handle.end());
  });

  it("G in the slideshow's window does nothing while a presenter's view holds the picker", async () => {
    const { places, handle } = await start();
    await waitFor(() => expect(text(places.presenter, "[data-show-place]")).toBe("1 / 12"));
    // The stand-in places share one document, so the listener sees the presenter's: a show with no presenter's view opens its own picker.
    await act(async () => handle.end());
    const alone = await start({ mode: "full" });
    await waitFor(() => expect(text(alone.places.audience, "[data-show-place]")).toBe("1 / 12"));
    fireEvent.keyDown(alone.places.audience.body, { key: "g" });
    expect(alone.places.audience.body.querySelector("[data-show-picker]")).not.toBeNull();
    await act(async () => alone.handle.end());
  });

  it("starts from the slide he is on, and each way of presenting opens its own windows", async () => {
    const here = await start({ from: 260, mode: "full" });
    expect(Object.keys(here.places)).toEqual(["audience"]);
    await waitFor(() => expect(text(here.places.audience, "[data-show-place]")).toBe("5 / 12"));
    // With no presenter's view the slideshow's own bar holds the picker.
    expect(within(here.places.audience.body).getByRole("button", { name: "Slides", hidden: true })).toBeTruthy();
    await act(async () => here.handle.end());
    const rehearsal = await start({ mode: "presenter" });
    expect(Object.keys(rehearsal.places)).toEqual(["presenter"]);
    await act(async () => rehearsal.handle.end());
  });

  it("ends on Escape, closing its windows; a new show ends the one before it", async () => {
    const first = await start();
    expect(showRunning()).toBe(true);
    const second = await start();
    await first.handle.done;
    expect(first.places.audience.closed && first.places.presenter.closed).toBe(true);
    expect(showRunning()).toBe(true);
    await waitFor(() => expect(text(second.places.presenter, "[data-show-place]")).toBe("1 / 12"));
    fireEvent.keyDown(second.places.presenter.body, { key: "Escape" });
    await act(async () => second.handle.done);
    expect(second.places.audience.closed && second.places.presenter.closed).toBe(true);
    expect(showRunning()).toBe(false);
  });

  it("a new show starts in main only after the one before it has ended there; a second press while one starts is that same start", async () => {
    const native = nativeShow();
    const first = await start({ native });
    const made: Array<ReturnType<typeof place>> = [];
    let second!: Awaited<ReturnType<typeof startShow>>;
    await act(async () => {
      const ask = { host: showHost(showDeck(3)), title: "Deck", from: "start" as const, mode: "windowed" as const, engine: fakeEngine(() => pages(3)), native, open: (surface: Surface) => (made.push(place(surface)), made.at(-1)!) };
      const [a, b] = [startShow(ask), startShow(ask)];
      expect(a).toBe(b);
      second = await a;
    });
    await first.handle.done;
    // Main heard the first show end before the second asked for its windows, and the double press began one show.
    expect(native.calls).toEqual(["begin windowed", "end", "begin windowed"]);
    expect(made).toHaveLength(2);
    await act(async () => second.end());
    await second.done;
    expect(native.calls.at(-1)).toBe("end");
  });

  it("ends when he closes one of its windows", async () => {
    const { places, handle } = await start();
    act(() => places.audience.leave());
    await act(async () => handle.done);
    expect(places.presenter.closed).toBe(true);
  });

  it("reads the deck again when its file changes, keeping the slide by its id; a push that changed no byte reads nothing", async () => {
    const { host, places, handle } = await start();
    await waitFor(() => expect(text(places.presenter, "[data-show-place]")).toBe("1 / 12"));
    fireEvent.keyDown(places.presenter.body, { key: "End" });
    expect(text(places.presenter, "[data-show-place]")).toBe("12 / 12");
    act(() => host.tell("r1"));
    expect(host.shows).toBe(1);
    // A slide was added at the front: the show is still on the same slide, now the thirteenth.
    const slides = [slide(13, { id: 999, number: 1, page: 1 }), ...deck(12).map((s) => ({ ...s, number: s.number + 1, page: s.page + 1 }))];
    await act(async () => host.change(showDeck(13, { rev: "r2", render: { rev: "f2", size: 1100, pages: 13 }, slides })));
    await waitFor(() => expect(text(places.presenter, "[data-show-place]")).toBe("13 / 13"));
    expect(host.shows).toBe(2);
    await act(async () => handle.end());
  });

  it("says why when the deck cannot be read, in both windows, and asks again by itself; Escape still ends it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const host = showHost(showDeck(3));
    const real = host.show;
    let fail = true;
    host.show = async () => {
      if (fail) throw new Error("Sponsor deck.pptx is not where it was.");
      return real();
    };
    const { places, handle } = await start({ host });
    await waitFor(() => expect(text(places.audience, "[data-show-error]")).toBe("Sponsor deck.pptx is not where it was."));
    expect(text(places.presenter, "[data-show-error]")).toBe("Sponsor deck.pptx is not where it was.");
    // The file is back: the show reads it again after its first wait, with no press.
    fail = false;
    await act(async () => void vi.advanceTimersByTime(RETRY_FIRST_MS));
    await waitFor(() => expect(text(places.presenter, "[data-show-place]")).toBe("1 / 3"));
    expect(places.audience.body.querySelector("[data-show-error]")).toBeNull();
    fireEvent.keyDown(places.audience.body, { key: "Escape" });
    await act(async () => handle.done);
  });

  it("a first read that the file moved on from is read again at once, never left as an error", async () => {
    const host = showHost(showDeck(3));
    let moved = true;
    const engine = fakeEngine(() => pages(3));
    const open = engine.open.bind(engine);
    engine.open = async (file) => {
      if (moved) {
        moved = false;
        throw new Error(RENDER_CHANGED);
      }
      return open(file);
    };
    const { places, handle } = await start({ host, engine });
    await waitFor(() => expect(text(places.presenter, "[data-show-place]")).toBe("1 / 3"));
    expect(host.shows).toBe(2);
    expect(places.presenter.body.querySelector("[data-show-error]")).toBeNull();
    await act(async () => handle.end());
  });

  it("with a deck already up, a read that fails keeps it up and says it is reconnecting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { host, places, handle } = await start();
    await waitFor(() => expect(text(places.presenter, "[data-show-place]")).toBe("1 / 12"));
    const real = host.show;
    host.show = async () => {
      throw new Error("The socket closed");
    };
    await act(async () => host.tell("r2"));
    await waitFor(() => expect(within(places.presenter.body).getByRole("status").textContent).toBe("Reconnecting to the deck…"));
    expect(text(places.presenter, "[data-show-place]")).toBe("1 / 12");
    expect(places.audience.body.querySelector("[data-show-error]")).toBeNull();
    host.show = real;
    await act(async () => void vi.advanceTimersByTime(RETRY_FIRST_MS));
    await waitFor(() => expect(within(places.presenter.body).queryByRole("status")).toBeNull());
    await act(async () => handle.end());
  });

  it("asks main for its windows and tells it when the show is over", async () => {
    const native = nativeShow({ audience: null, presenter: null });
    await expect(startShow({ host: showHost(showDeck(3)), title: "Deck", from: "start", mode: "full", display: 2, native, engine: fakeEngine(() => pages(3)) })).rejects.toThrow("The show's window did not open");
    expect(native.calls).toEqual(["begin full 2", "end"]);
    expect(showRunning()).toBe(false);
  });

  it("the slideshow's display leaving closes that window alone: the presenter's view goes on and says so", async () => {
    const native = nativeShow();
    const { places, handle } = await start({ native, mode: "windowed" });
    await waitFor(() => expect(text(places.presenter, "[data-show-place]")).toBe("1 / 12"));
    act(() => native.displayGone());
    expect(places.audience.closed).toBe(true);
    expect(places.presenter.closed).toBe(false);
    expect(within(places.presenter.body).getByRole("status").textContent).toBe("The slideshow's display was disconnected");
    // The window main closes in its stead says it left; the show goes on.
    act(() => places.audience.leave());
    fireEvent.keyDown(places.presenter.body, { key: "ArrowRight" });
    expect(text(places.presenter, "[data-show-place]")).toBe("2 / 12");
    await act(async () => handle.end());
    await handle.done;
    expect(native.calls.at(-1)).toBe("end");
  });
});

describe("where a show is drawn", () => {
  it("the slideshow's document is dark whatever the app wears; the presenter's view wears the app's theme and follows it", async () => {
    document.documentElement.className = "theme-light is-mac";
    const style = document.createElement("style");
    style.textContent = ".x{}";
    document.head.appendChild(style);
    const dark = document.implementation.createHTMLDocument("");
    const app = document.implementation.createHTMLDocument("");
    const offs = [mirrorLook(document, dark, "dark"), mirrorLook(document, app, "app")];
    expect(dark.documentElement.className).toBe("is-mac");
    expect(app.documentElement.className).toBe("theme-light is-mac");
    expect(dark.head.querySelectorAll("style")).toHaveLength(document.head.querySelectorAll("style").length);
    expect(dark.body.style.margin).toBe("0px");
    // A lazy chunk's styles and a change of theme reach the other document.
    const late = document.createElement("style");
    late.dataset.late = "";
    document.head.appendChild(late);
    document.documentElement.className = "is-mac";
    await waitFor(() => expect(app.documentElement.className).toBe("is-mac"));
    expect(app.head.querySelector("[data-late]")).not.toBeNull();
    offs.forEach((off) => off());
    document.documentElement.className = "";
    style.remove();
    late.remove();
  });

  it("a document stays unseen until the stylesheets it was given have loaded, so no show opens on bare words", () => {
    vi.useFakeTimers();
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "data:text/css,";
    document.head.appendChild(link);
    const to = document.implementation.createHTMLDocument("");
    const off = mirrorLook(document, to, "dark");
    expect(to.body.style.visibility).toBe("hidden");
    to.head.querySelector("link")!.dispatchEvent(new Event("load"));
    expect(to.body.style.visibility).toBe("");
    // A sheet that never answers does not hold the show for good.
    const slow = document.implementation.createHTMLDocument("");
    const off2 = mirrorLook(document, slow, "app");
    expect(slow.body.style.visibility).toBe("hidden");
    vi.advanceTimersByTime(1500);
    expect(slow.body.style.visibility).toBe("");
    off();
    off2();
    link.remove();
    // With styles in the page itself there is nothing to wait for.
    const plain = document.implementation.createHTMLDocument("");
    mirrorLook(document, plain, "dark")();
    expect(plain.body.style.visibility).toBe("");
  });

  it("in a browser the slideshow is a frame over the page that asks for the page's full screen; leaving full screen ends it", async () => {
    let full: Element | null = null;
    const ask = vi.fn(function (this: Element) {
      full = this;
      return Promise.resolve();
    });
    HTMLIFrameElement.prototype.requestFullscreen = ask as never;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => full });
    const p = openFramePlace("audience", true);
    const frame = document.querySelector<HTMLIFrameElement>("iframe[data-show-frame]")!;
    expect(frame.getAttribute("aria-label")).toBe("Slideshow");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(p.body).toBe(frame.contentDocument!.body);
    const left = vi.fn();
    p.onGone(left);
    await Promise.resolve();
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(left).not.toHaveBeenCalled();
    full = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(left).toHaveBeenCalledTimes(1);
    p.close();
    expect(document.querySelector("iframe[data-show-frame]")).toBeNull();
    // The presenter's view asks for no full screen.
    const q = openFramePlace("presenter", false);
    expect(ask).toHaveBeenCalledTimes(1);
    q.close();
    delete (document as { fullscreenElement?: unknown }).fullscreenElement;
  });
});

// ── builds, transitions, video and sound ─────────────────────────────

describe("a show's builds, its own clock and its clips", () => {
  // Rooms with a size, so the windows paint their pictures.
  const sized = ["clientWidth", "clientHeight"].map((name) => [name, Object.getOwnPropertyDescriptor(Element.prototype, name)!] as const);
  beforeEach(() => {
    Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => 960 });
    Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 600 });
  });
  afterEach(() => sized.forEach(([name, d]) => Object.defineProperty(Element.prototype, name, d)));
  /** The words on the picture a window shows: the layer that is not hidden. */
  const seen = (p: ShowPlace, root = "[data-show-slide]"): string | null => p.body.querySelector(`${root} [data-show-page]:not(.invisible)`)?.textContent ?? null;
  const quad: Array<[number, number]> = [
    [0.1, 0.2],
    [0.5, 0.2],
    [0.5, 0.6],
    [0.1, 0.6],
  ];
  async function start(slides: Slide[]) {
    const host = showHost(showDeck(slides.length, { slides }));
    const places: Record<string, ReturnType<typeof place>> = {};
    // A step's own picture is a one-page render of its own; the deck's render is opened once.
    const opened: number[] = [];
    const engine = {
      async open(file: { size: number }) {
        opened.push(file.size);
        return file.size === 1000 ? pages(slides.length) : fakeDoc([{ size: WIDE, runs: [{ str: `Step picture ${file.size}`, box: [0.1, 0.1, 0.6, 0.2] as [number, number, number, number] }] }]);
      },
    };
    let handle!: Awaited<ReturnType<typeof startShow>>;
    await act(async () => {
      handle = await startShow({ host, title: "Deck", from: "start", mode: "windowed", engine, native: null, open: (surface) => (places[surface] = place(surface)) });
    });
    return { host, places, handle, opened };
  }

  it("shows each step's own picture in both windows, and holds the picture before a step whose picture is not made yet", async () => {
    const { host, places, handle, opened } = await start(
      deck(3, {
        2: { steps: [{ hides: [4, 5], pic: { rev: "0123456789abcdef", size: 101 } }, { hides: [5], pic: { rev: "1123456789abcdef", size: 102 } }, { hides: [] }] },
        3: { steps: [{ hides: [4], missing: "making" }, { hides: [] }] },
      }),
    );
    await waitFor(() => expect(seen(places.audience)).toBe("Slide 1"));
    // the next slide's step pictures are read ahead
    await waitFor(() => expect(opened).toEqual(expect.arrayContaining([101, 102])));
    fireEvent.keyDown(places.audience.body, { key: "ArrowRight" });
    await waitFor(() => expect(seen(places.audience)).toBe("Step picture 101"));
    expect(seen(places.presenter, "[data-show-now]")).toBe("Step picture 101");
    expect(text(places.presenter, "[data-show-build]")).toBe("Build 1 of 2");
    fireEvent.keyDown(places.audience.body, { key: "ArrowRight" });
    await waitFor(() => expect(seen(places.audience)).toBe("Step picture 102"));
    fireEvent.keyDown(places.audience.body, { key: "ArrowRight" });
    // the last step hides nothing: the slide's page
    await waitFor(() => expect(seen(places.audience)).toBe("Slide 2"));
    fireEvent.keyDown(places.audience.body, { key: "ArrowRight" });
    // slide 3's first step has no picture yet: the room keeps the picture before it, never the slide whole with what
    // its build hides, and there is still a press before the end
    await waitFor(() => expect(text(places.presenter, "[data-show-place]")).toBe("3 / 3"));
    expect(seen(places.audience)).toBe("Slide 2");
    expect(text(places.presenter, "[data-show-build]")).toBe("Build 1 of 1");
    // More is ready on the host: the deck is read again and its render kept open.
    const shows = host.shows;
    await act(async () => host.ready("r1"));
    await waitFor(() => expect(host.shows).toBe(shows + 1));
    expect(opened.filter((size) => size === 1000)).toHaveLength(1);
    await act(async () => handle.end());
  });

  it("holds a step whose picture could not be made, says why to the presenter alone, and starts no clock on it", async () => {
    const { places, handle } = await start(deck(3, { 1: { steps: [{ hides: [4], missing: "failed" }, { hides: [] }], transition: { kind: "fade", ms: 500, after: 30 } } }));
    await waitFor(() => expect(within(places.presenter.body).getByRole("status").textContent).toBe("This build could not be drawn here. The room sees the step before it."));
    expect(seen(places.audience)).not.toBe("Slide 1");
    expect(places.audience.body.textContent).not.toContain("could not be drawn");
    await new Promise((r) => setTimeout(r, 80));
    expect(text(places.presenter, "[data-show-place]")).toBe("1 / 3");
    // His press goes on to the last step, which hides nothing: once it is up, the slide's time runs.
    fireEvent.keyDown(places.audience.body, { key: "ArrowRight" });
    await waitFor(() => expect(text(places.presenter, "[data-show-place]")).toBe("2 / 3"));
    expect(within(places.presenter.body).queryByRole("status")).toBeNull();
    await act(async () => handle.end());
  });

  it("moves on by itself after a slide's time, in both windows", async () => {
    const { places, handle } = await start(deck(3, { 1: { transition: { kind: "fade", ms: 500, after: 30 } } }));
    await waitFor(() => expect(text(places.presenter, "[data-show-place]")).toBe("2 / 3"));
    expect(text(places.audience, "[data-show-place]")).toBe("2 / 3");
    await act(async () => handle.end());
  });

  it("plays a slide's video in both windows: started from the presenter's view, heard from the slideshow, the transport in the presenter's view alone", async () => {
    const plays = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", { value: false, configurable: true });
      return Promise.resolve();
    });
    const pauses = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", { value: true, configurable: true });
    });
    const made = vi.fn(() => "blob:clip");
    const revoked = vi.fn();
    Object.assign(URL, { createObjectURL: made, revokeObjectURL: revoked });
    const { places, handle } = await start(deck(3, { 2: { media: [{ shape: 3, kind: "video", quad: quad as never, file: { rev: "2123456789abcdef", size: 10, type: "video/mp4" } }] } }));
    await waitFor(() => expect(seen(places.audience)).toBe("Slide 1"));
    fireEvent.keyDown(places.audience.body, { key: "ArrowRight" });
    const play = await within(places.presenter.body).findByRole("button", { name: "Play the video" });
    await waitFor(() => expect((play as HTMLButtonElement).disabled).toBe(false));
    const [room, own] = [places.audience, places.presenter].map((p) => p.body.querySelector<HTMLVideoElement>('video[data-show-media="3"]')!);
    expect(room.src).toBe("blob:clip");
    expect(own.src).toBe("blob:clip");
    expect(made).toHaveBeenCalledTimes(1);
    // the slideshow's copy is heard, the presenter's plays muted in step; neither shows before it is started
    expect([room.muted, own.muted]).toEqual([false, true]);
    expect(room.className).toContain("invisible");
    // placed over the shape's box: 40% of the slide wide from 10% in
    expect(parseFloat(room.style.width) / parseFloat(room.parentElement!.parentElement!.style.width)).toBeCloseTo(0.4, 2);
    expect(within(places.audience.body).queryByRole("button", { name: /the video/ })).toBeNull();
    fireEvent.click(play);
    await waitFor(() => expect(room.className).not.toContain("invisible"));
    expect(plays.mock.contexts).toEqual(expect.arrayContaining([room, own]));
    expect(within(places.presenter.body).getByRole("button", { name: "Pause the video" })).toBeTruthy();
    // the room's copy reports its place to the transport
    Object.defineProperty(room, "duration", { value: 64, configurable: true });
    room.currentTime = 12;
    fireEvent.timeUpdate(room);
    await waitFor(() => expect(places.presenter.body.querySelector("[data-show-clip]")?.textContent).toContain("0:12 / 1:04"));
    fireEvent.click(within(places.presenter.body).getByRole("button", { name: "Pause the video" }));
    await waitFor(() => expect(pauses.mock.contexts).toEqual(expect.arrayContaining([room, own])));
    // leaving the slide stops its clip; the show's end lets the clip's URL go
    fireEvent.keyDown(places.audience.body, { key: "ArrowRight" });
    await waitFor(() => expect(places.audience.body.querySelector("video")).toBeNull());
    await act(async () => handle.end());
    expect(revoked).toHaveBeenCalledWith("blob:clip");
    plays.mockRestore();
    pauses.mockRestore();
  });

  it("starts and stops a clip from the slideshow itself where there is no presenter's view", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    Object.assign(URL, { createObjectURL: () => "blob:sound", revokeObjectURL: () => undefined });
    const host = showHost(showDeck(2, { slides: deck(2, { 1: { media: [{ shape: 4, kind: "audio", quad: quad as never, file: { rev: "3123456789abcdef", size: 10, type: "audio/wav" } }] } }) }));
    const places: Record<string, ReturnType<typeof place>> = {};
    let handle!: Awaited<ReturnType<typeof startShow>>;
    await act(async () => {
      handle = await startShow({ host, title: "Deck", from: "start", mode: "full", engine: fakeEngine(() => pages(2)), native: null, open: (surface) => (places[surface] = place(surface)) });
    });
    const press = await within(places.audience.body).findByRole("button", { name: "Play the sound" });
    fireEvent.click(press);
    // the press was the clip's, not the next slide's
    expect(text(places.audience, "[data-show-place]")).toBe("1 / 2");
    await waitFor(() => expect(within(places.audience.body).getByRole("button", { name: "Pause the sound" })).toBeTruthy());
    expect(places.audience.body.querySelector<HTMLAudioElement>("audio")!.muted).toBe(false);
    await act(async () => handle.end());
    vi.restoreAllMocks();
  });
});
