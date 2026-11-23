// @vitest-environment jsdom
/**
 * The clicker (docs/DESIGN.md "The clicker"): at phone width, while a show of the deck runs elsewhere, the deck's
 * item is the prototype's clicker; each press goes to the show with the state it was made on. And the window that
 * runs the show (remote.ts `usePublish`): it tells its host the state, runs a press made on what it shows, drops
 * one made on a state it has left, and ends the show on the host when it goes. jsdom only: the repo has no WebKit
 * run for /ui.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShowLive, ShowPress, ShowPressAct } from "@shared/contract-work-slides";
import { Clicker, CLICKER_WIDTH, useClickerShow } from "./Clicker";
import { actOf, liveOf, usePublish, type LiveState, type ShowRemote } from "./remote";
import { showReducer, startShowState, type ShowState, type Slide } from "./state";
import { startTimer } from "./timer";

const live = (over: Partial<ShowLive> = {}): ShowLive => ({
  showId: "show-abc12345",
  itemId: "deck1",
  title: "Sponsor deck",
  rev: 7,
  slide: 4,
  count: 12,
  step: 0,
  steps: 0,
  next: { kind: "slide", number: 5, title: "Packages" },
  notes: "Start with the gold package.\nSay the price last.",
  timer: { elapsed: 12 * 60_000 + 40_000, paused: false, target: 20 },
  blank: false,
  ended: false,
  ...over,
});

function fakeRemote() {
  const presses: Array<{ showId: string; act: ShowPressAct; rev: number; at?: number }> = [];
  const runs: Array<{ showId: string; live: LiveState | null; answered?: { seq: number; applied: boolean } }> = [];
  const waiting: Array<(answer: { press: ShowPress | null }) => void> = [];
  const listeners = new Set<(showId: string, live: ShowLive | null) => void>();
  let shows: ShowLive[] = [];
  const remote: ShowRemote = {
    itemId: "deck1",
    run: (showId, l, answered) => {
      runs.push({ showId, live: l, ...(answered ? { answered } : {}) });
      return l ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve({ press: null });
    },
    state: async () => shows,
    press: async (showId, a, rev, at) => {
      presses.push({ showId, act: a, rev, ...(at !== undefined ? { at } : {}) });
      return { applied: true, live: null };
    },
    onLive: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  };
  return {
    remote,
    presses,
    runs,
    waiting,
    set: (next: ShowLive[]) => (shows = next),
    push: (showId: string, l: ShowLive | null) => listeners.forEach((fn) => fn(showId, l)),
  };
}

let width = 390;
beforeEach(() => {
  width = 390;
  window.matchMedia = ((query: string) => ({
    matches: Number(/max-width: (\d+)px/.exec(query)?.[1] ?? 0) >= width,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as never;
});
afterEach(cleanup);

describe("the clicker at 390px", () => {
  it("draws the prototype: End, the deck, Blank; the time against the target and 4 / 12; the notes; Previous; Next as the lower part", () => {
    const { remote } = fakeRemote();
    render(<Clicker live={live()} remote={remote} />);
    const root = document.querySelector<HTMLElement>("[data-clicker]")!;
    // Over the whole page, clear of the screen's safe areas, and nothing that scrolls the page by accident.
    expect(root.parentElement).toBe(document.body);
    expect(root.className).toMatch(/\bfixed\b.*\binset-0\b/);
    expect(root.className).toContain("overscroll-none");
    expect(root.className).toContain("touch-manipulation");
    expect(root.className).toContain("pt-[env(safe-area-inset-top)]");
    expect(screen.getByRole("button", { name: "End" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sponsor deck" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Blank" }).getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("[data-clicker-elapsed]")!.textContent).toBe("12:40");
    expect(screen.getByText("of 20:00")).toBeTruthy();
    expect(document.querySelector("[data-clicker-place]")!.textContent).toBe("4 / 12");
    // The notes scroll inside themselves, never the page.
    const notes = document.querySelector<HTMLElement>("[data-clicker-notes]")!;
    expect(notes.textContent).toBe("Start with the gold package.\nSay the price last.");
    expect(notes.className).toContain("overflow-y-auto");
    expect(notes.className).toContain("overscroll-contain");
    const prev = document.querySelector<HTMLElement>("[data-clicker-prev]")!;
    const next = document.querySelector<HTMLElement>("[data-clicker-next]")!;
    expect(prev.className).toContain("h-14");
    expect(next.className).toContain("h-[42dvh]");
    expect(next.className).toContain("mb-[max(16px,env(safe-area-inset-bottom))]");
    // Next comes last, under Previous: the lower part of the screen, with the next slide's title in it.
    expect(prev.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(next.getAttribute("aria-label")).toBe("Next: slide 5, Packages");
    expect(next.textContent).toContain("Packages");
    // No control waits on a hover.
    expect(root.innerHTML).not.toMatch(/group-hover|hover:opacity|opacity-0/);
  });

  it("sends each press with the state it was made on", () => {
    const { remote, presses } = fakeRemote();
    render(<Clicker live={live()} remote={remote} />);
    fireEvent.click(document.querySelector("[data-clicker-next]")!);
    fireEvent.click(document.querySelector("[data-clicker-prev]")!);
    fireEvent.click(screen.getByRole("button", { name: "Blank" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause the timer" }));
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(presses).toEqual([
      { showId: "show-abc12345", act: "next", rev: 7 },
      { showId: "show-abc12345", act: "prev", rev: 7 },
      { showId: "show-abc12345", act: "blank", rev: 7 },
      { showId: "show-abc12345", act: "pause", rev: 7 },
      { showId: "show-abc12345", act: "end", rev: 7 },
    ]);
  });

  it("says a press that failed in its own line, since it lies over the page's toasts, and drops it once the show moves on", async () => {
    const { remote } = fakeRemote();
    let refusal = new Error("forbidden: work.slides.show.press needs operate");
    remote.press = () => Promise.reject(refusal);
    const { rerender } = render(<Clicker live={live()} remote={remote} />);
    expect(document.querySelector("[data-clicker-failed]")).toBeNull();
    await act(async () => void fireEvent.click(document.querySelector("[data-clicker-next]")!));
    // The wire's refusal of a key that may only read, in his words, inside the clicker.
    const line = document.querySelector<HTMLElement>("[data-clicker] [data-clicker-failed]")!;
    expect(line.getAttribute("role")).toBe("alert");
    expect(line.textContent).toBe("This device can only watch the show.");
    // Between the notes and Previous: Previous and Next keep their places.
    expect(line.previousElementSibling).toBe(document.querySelector("[data-clicker-notes]"));
    expect(line.nextElementSibling).toBe(document.querySelector("[data-clicker-prev]"));
    // Any other failure says its own words; the show moving on takes the line away.
    refusal = new Error("The show did not answer.");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Blank" })));
    expect(document.querySelector("[data-clicker-failed]")!.textContent).toBe("The show did not answer.");
    rerender(<Clicker live={live({ rev: 8, slide: 5 })} remote={remote} />);
    expect(document.querySelector("[data-clicker-failed]")).toBeNull();
  });

  it("says a build, the end and the close as the next press does; Previous rests on the first slide; Blank shows it is on", () => {
    const { remote } = fakeRemote();
    const view = render(<Clicker live={live({ next: { kind: "build", step: 2, of: 4 }, slide: 1, blank: true, timer: { elapsed: 5000, paused: true, target: null } })} remote={remote} />);
    expect(document.querySelector("[data-clicker-build]")!.textContent).toBe("Build 2 of 4");
    expect(screen.getByRole("button", { name: "Blank" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Resume the timer" })).toBeTruthy();
    expect(screen.queryByText(/^of /)).toBeNull();
    view.rerender(<Clicker live={live({ slide: 1, step: 0 })} remote={remote} />);
    expect(document.querySelector<HTMLButtonElement>("[data-clicker-prev]")!.disabled).toBe(true);
    view.rerender(<Clicker live={live({ next: { kind: "end" }, slide: 12 })} remote={remote} />);
    expect(document.querySelector("[data-clicker-next]")!.textContent).toContain("End of show");
    view.rerender(<Clicker live={live({ next: { kind: "close" }, ended: true, notes: "" })} remote={remote} />);
    expect(document.querySelector("[data-clicker-next]")!.getAttribute("aria-label")).toBe("Close the show");
    expect(document.querySelector("[data-clicker-place]")!.textContent).toBe("End");
  });

  it("counts the time on between the host's words, and turns warning past the target", () => {
    vi.useFakeTimers();
    try {
      const { remote } = fakeRemote();
      render(<Clicker live={live({ timer: { elapsed: 20 * 60_000 - 1000, paused: false, target: 20 } })} remote={remote} />);
      const elapsed = document.querySelector("[data-clicker-elapsed]")!;
      expect(elapsed.className).not.toContain("text-warning");
      act(() => void vi.advanceTimersByTime(3000));
      expect(elapsed.textContent).toBe("20:02");
      expect(elapsed.className).toContain("text-warning");
    } finally {
      vi.useRealTimers();
    }
  });
});

function Seat({ remote }: { remote: ShowRemote }) {
  const show = useClickerShow(remote);
  return show ? <Clicker live={show} remote={remote} /> : <div data-canvas />;
}

describe("the deck's item at phone width", () => {
  it("is the clicker while a show of the deck runs elsewhere, and the canvas again when it ends", async () => {
    const wire = fakeRemote();
    wire.set([live()]);
    render(<Seat remote={wire.remote} />);
    expect(await screen.findByRole("region", { name: "Clicker: Sponsor deck" })).toBeTruthy();
    act(() => wire.push("show-abc12345", live({ slide: 5, rev: 8 })));
    expect(document.querySelector("[data-clicker-place]")!.textContent).toBe("5 / 12");
    act(() => wire.push("show-abc12345", null));
    expect(document.querySelector("[data-clicker]")).toBeNull();
    expect(document.querySelector("[data-canvas]")).toBeTruthy();
  });

  it("stays the canvas on a wide page", async () => {
    width = CLICKER_WIDTH + 400;
    const wire = fakeRemote();
    wire.set([live()]);
    render(<Seat remote={wire.remote} />);
    await act(async () => undefined);
    expect(document.querySelector("[data-clicker]")).toBeNull();
  });
});

const slides: Slide[] = Array.from({ length: 4 }, (_, i) => ({ id: 100 + i, number: i + 1, page: i + 1, title: `Point ${i + 1}`, notes: `Notes ${i + 1}`, hidden: false }));

function Runner({ remote }: { remote: ShowRemote }) {
  const [state, setState] = useState<ShowState>(() => startShowState(slides, "start"));
  const [timer] = useState(() => startTimer(0));
  usePublish(
    remote,
    () => liveOf(state, timer, 20, "Talk", 0),
    (press) => {
      const a = actOf(press);
      if (a) setState((was) => showReducer(was, a));
    },
  );
  return <div data-at={state.at} />;
}

describe("the window that runs the show", () => {
  it("tells its host the state, runs a press made on it, drops one made on a state it left, and ends the show when it goes", async () => {
    const wire = fakeRemote();
    const view = render(<Runner remote={wire.remote} />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
    expect(wire.runs[0]).toMatchObject({ live: { rev: 1, slide: 1, count: 4, notes: "Notes 1", next: { kind: "slide", number: 2, title: "Point 2" }, timer: { paused: false, target: 20 } } });
    const showId = wire.runs[0]!.showId;
    // A press made on what it shows runs through the reducer, and the next call says so with the new state.
    await act(async () => {
      wire.waiting.shift()!({ press: { seq: 1, act: "next", rev: 1 } });
      await new Promise((r) => setTimeout(r, 5));
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
    expect(document.querySelector("[data-at]")!.getAttribute("data-at")).toBe("1");
    const told = wire.runs.at(-1)!;
    expect(told).toMatchObject({ answered: { seq: 1, applied: true }, live: { rev: 2, slide: 2 } });
    // One call for the press and the change it made, not two.
    expect(wire.runs).toHaveLength(2);
    // One made on the state before is never applied.
    await act(async () => {
      wire.waiting.at(-1)!({ press: { seq: 2, act: "next", rev: 1 } });
      await new Promise((r) => setTimeout(r, 5));
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
    expect(document.querySelector("[data-at]")!.getAttribute("data-at")).toBe("1");
    expect(wire.runs.at(-1)).toMatchObject({ answered: { seq: 2, applied: false }, live: { rev: 2 } });
    view.unmount();
    expect(wire.runs.at(-1)).toEqual({ showId, live: null });
  });

  it("runs the clicker's acts through the reducer's own, and leaves the timer's to the timer", () => {
    expect(actOf({ act: "goto", at: 3 })).toEqual({ t: "goto", number: 3 });
    expect(actOf({ act: "blank" })).toEqual({ t: "blank" });
    expect(actOf({ act: "pause" })).toBeNull();
    expect(actOf({ act: "resume" })).toBeNull();
  });
});
