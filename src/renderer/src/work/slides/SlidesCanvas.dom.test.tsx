// @vitest-environment jsdom
/**
 * The slides kind in the real canvas pane, with a host that keeps one deck's
 * view and pages of words in place of pdf.js: a 12-slide deck in the strip,
 * an agent's revision stepped from the bar slide by slide, a move shown
 * where it lands and where it leaves, the notes, a shape asked about, the
 * PowerPoint switch, and a deck with no picture.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckView } from "@shared/contract-work-slides";
import type { CanvasItem } from "@shared/work";
import { openMenus } from "../../chrome/menuRows";
import { defineChunk } from "../../lib/lazyChunk";
import { CANVAS } from "../canvas/registry";
import { canvasItem, fakeHost } from "../canvas/testkit";
import type { CanvasBodyProps, CanvasKindDef } from "../canvas/kind";
import { fakeDoc, fakeEngine } from "../pdf/testkit";
import { changeIndex, renderDetail, slideOfChange, stageWidth } from "./SlidesCanvas";
import { RENDER_CHANGED } from "./deck";
import { change, deckView, fakeDeckHost, slide } from "./testkit";

const host = vi.hoisted(() => ({
  current: null as ReturnType<typeof import("../canvas/testkit").fakeHost> | null,
  pushes: new Set<(push: never) => void>(),
  opens: new Set<() => void>(),
}));
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

import { CanvasSeat } from "../canvas/CanvasSeat";
import { resetCanvasStore } from "../canvas/store";

const WIDE = { width: 640 * 0.75, height: 360 * 0.75 };
const DECK = fakeDoc(Array.from({ length: 12 }, (_, i) => ({ size: WIDE, runs: [{ str: `Slide ${i + 1}`, box: [0.1, 0.1, 0.6, 0.2] as [number, number, number, number] }] })));
const PROPOSED = fakeDoc(Array.from({ length: 13 }, (_, i) => ({ size: WIDE, runs: [{ str: `Proposed ${i + 1}`, box: [0.1, 0.1, 0.6, 0.2] as [number, number, number, number] }] })));

let deckHost: ReturnType<typeof fakeDeckHost>;
let item: CanvasItem;
/** How many of the next picture reads this window refuses, as a socket that closed mid-read would. */
let refuseReads = 0;
let reads = 0;
/** The open (counted from 1) this window refuses, as a socket that closed mid-read of that one render would. */
let refuseAt: number | null = null;
/** While set, every picture open waits on it: a render still being read. */
let gate: Promise<void> | null = null;
/** While set, the next open fails as bytes from another revision would. */
let moved = false;

function kinds(width = 800): Record<string, CanvasKindDef> {
  // Each render a doc of its own: the file's 12 slides, the proposed deck's 13.
  let opened = 0;
  const pictures = fakeEngine(() => (opened++ === 0 ? DECK : PROPOSED));
  const engine: typeof pictures = {
    ...pictures,
    open: async (file) => {
      reads++;
      const at = reads;
      if (gate) await gate;
      if (moved) {
        moved = false;
        throw new Error(RENDER_CHANGED);
      }
      if (refuseAt === at) throw new Error("The socket closed");
      if (refuseReads > 0) {
        refuseReads--;
        throw new Error("The socket closed");
      }
      return pictures.open(file);
    },
  };
  const module = import("./SlidesCanvas").then((m) => ({
    Body: (props: CanvasBodyProps) => <m.Body {...(props as CanvasBodyProps<undefined>)} host={deckHost} engine={engine} width={width} height={700} />,
    Bar: m.Bar as never,
    TabEnd: m.TabEnd as never,
  }));
  return { ...CANVAS, slides: { ...CANVAS.slides, chunk: defineChunk(`test-slides-${Math.random()}`, () => module) } };
}

let n = 0;
function open(view: DeckView, opened?: () => Promise<DeckView>, width?: number) {
  // Each test its own item, so the deck's per-item store starts fresh.
  item = canvasItem(`deck${++n}`, { kind: "slides", title: "Sponsor deck.pptx", source: { at: "file", host: "local", path: "/work/deck.pptx" } });
  deckHost = fakeDeckHost({ ...view, itemId: item.id });
  if (opened) deckHost.open = opened;
  host.current = fakeHost([item], host as never);
  return render(
    <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds(width) as never}>
      <div />
    </CanvasSeat>,
  );
}

const found = (selector: string): Promise<HTMLElement> =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(selector);
    expect(el).not.toBeNull();
    return el!;
  });
const thumbs = () => [...document.querySelectorAll<HTMLElement>("[data-slide]")];

beforeEach(async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollIntoView ??= () => undefined;
  localStorage.clear();
  resetCanvasStore();
  refuseAt = null;
  gate = null;
  moved = false;
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

/** Five changes, as the prototype: three reworded, one moved, one added. */
function revised(): DeckView {
  const order = [1, 2, 6, 3, 4, 5, 13, 7, 8, 9, 10, 11, 12];
  const slides = order.map((id, i) => {
    if (id === 2 || id === 3 || id === 4) return slide(id, { number: i + 1, from: "proposed", page: i + 1, change: `c${id}`, tint: "add", changed: [[0.1, 0.4, 0.8, 0.6]] });
    if (id === 6) return slide(6, { number: i + 1, from: "proposed", page: i + 1, change: "c6", tint: "add" });
    if (id === 13) return slide(13, { number: i + 1, title: "Commit by Dec 15", from: "proposed", page: i + 1, change: "c13", tint: "add" });
    return slide(id, { number: i + 1, from: "proposed", page: i + 1 });
  });
  // The place slide 6 left, after slide 5.
  slides.splice(6, 0, slide(6, { key: "ghost:6", number: null, from: "file", page: 6, change: "c6", tint: "del" }));
  return deckView({
    slides,
    changes: [
      change("c2", 2, { edits: [{ where: "Title", before: "Why sponsor us", after: "Why sponsor Spring LAN" }] }),
      change("c6", 6, { kind: "moved", label: "Last year" }),
      change("c3", 3),
      change("c4", 4),
      change("c13", 13, { kind: "added", label: "Commit by Dec 15" }),
    ],
    renders: { file: { rev: "f1", size: 1000, pages: 12 }, proposed: { rev: "p1", size: 1100, pages: 13 } },
  });
}

describe("the slides kind", () => {
  it("draws a 12-slide deck in the strip and the first slide on the stage, with its notes", async () => {
    open(deckView({ slides: Array.from({ length: 12 }, (_, i) => slide(i + 1, { notes: i === 0 ? "Open with the turnout." : "" })) }));
    await found("[data-slides-stage]");
    expect(thumbs()).toHaveLength(12);
    expect(thumbs()[0].getAttribute("aria-current")).toBe("true");
    await waitFor(() => expect(document.querySelector("[data-slides-stage]")?.textContent).toContain("Slide 1"));
    expect(screen.getByText("Open with the turnout.")).toBeTruthy();
    fireEvent.click(thumbs()[1]);
    await waitFor(() => expect(screen.getByText("None yet")).toBeTruthy());
    expect(screen.queryByRole("toolbar", { name: "Review changes" })).toBeNull();
  });

  it("seats the slide on the theme's slide ground, with the notes under it on the canvas's own", async () => {
    open(deckView({ slides: [slide(1, { notes: "Open with the turnout." })] }));
    const ground = (await found("[data-slides-stage]")).parentElement!;
    // Light makes these `stage` and 16px, as a PDF's page and an image have; dark keeps the bare canvas it had.
    expect(ground.className).toContain("bg-(--slide-stage)");
    expect(ground.className).toContain("pb-(--slide-stage-inset)");
    expect(screen.getByText("Open with the turnout.").closest('[class*="--slide-stage"]')).toBeNull();
  });

  it("is one Tab stop, the slide on the stage, and the arrows down the strip, Home and End move the focus and the stage", async () => {
    open(deckView({ slides: Array.from({ length: 5 }, (_, i) => slide(i + 1)) }));
    await found("[data-slides-stage]");
    const strip = screen.getByRole("listbox", { name: "Slides" });
    expect(strip.getAttribute("aria-orientation")).toBe("vertical");
    expect(thumbs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    thumbs()[0].focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    await waitFor(() => expect(thumbs()[1].getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(thumbs()[1]);
    expect(thumbs().map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    await waitFor(() => expect(document.querySelector("[data-slides-stage]")?.textContent).toContain("Slide 2"));
    // Across the strip does nothing in the vertical form.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(thumbs()[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    await waitFor(() => expect(thumbs()[4].getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(thumbs()[4]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(thumbs()[4].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    await waitFor(() => expect(thumbs()[0].getAttribute("aria-selected")).toBe("true"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(thumbs()[0].getAttribute("aria-selected")).toBe("true");
  });

  it("in a narrow canvas the strip runs across, so Left and Right move along it", async () => {
    open(deckView({ slides: Array.from({ length: 3 }, (_, i) => slide(i + 1)) }), undefined, 360);
    await found("[data-slides-stage]");
    expect(screen.getByRole("listbox", { name: "Slides" }).getAttribute("aria-orientation")).toBe("horizontal");
    thumbs()[0].focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(thumbs()[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    await waitFor(() => expect(thumbs()[1].getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(thumbs()[1]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    await waitFor(() => expect(thumbs()[0].getAttribute("aria-selected")).toBe("true"));
  });

  it("shows an agent's revision as changed slides, a move where it lands and where it leaves, stepped from the bar", async () => {
    open(revised());
    const bar = await screen.findByRole("toolbar", { name: "Review changes" });
    // The stage starts on slide 1, which no change touches.
    // No change in hand: the count alone (the frame's stepper, round 5).
    expect(within(bar).getByText("5")).toBeTruthy();
    expect(thumbs().filter((t) => t.dataset.tint === "add")).toHaveLength(5);
    const ghost = thumbs().find((t) => t.dataset.slide === "ghost:6")!;
    expect(ghost.dataset.tint).toBe("del");
    // The review is held until the proposed render is on screen.
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Next change" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(bar).getByRole("button", { name: "Next change" }));
    await waitFor(() => expect(within(bar).getByText("1/5")).toBeTruthy());
    expect(thumbs().find((t) => t.dataset.slide === "2")!.getAttribute("aria-current")).toBe("true");
    // The words before and after, under the stage, and the changed shape tinted on it.
    const edits = await found("[data-slide-edits]");
    expect(edits.textContent).toContain("Why sponsor us");
    expect(edits.textContent).toContain("Why sponsor Spring LAN");
    expect(document.querySelectorAll("[data-slide-changed]")).toHaveLength(1);
    // The review opens once the stage has painted this change's slide (the frame holds its steps until then too).
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Next change" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(bar).getByRole("button", { name: "Next change" }));
    await waitFor(() => expect(thumbs().find((t) => t.dataset.slide === "6")!.getAttribute("aria-current")).toBe("true"));
    // Each change is decided once the stage has painted its slide.
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(bar).getByRole("button", { name: "Accept" }));
    // The press carries the revision of the proposed render on screen.
    await waitFor(() => expect(deckHost.calls).toContainEqual(["review", { changes: ["c6"], verdict: "accept", rev: "p1" }]));
    await waitFor(() => expect(thumbs().some((t) => t.dataset.slide === "ghost:6")).toBe(false));
    // Four left: "n/4" with a change in hand, the count alone with none.
    expect(within(screen.getByRole("toolbar", { name: "Review changes" })).getByText(/^(\d+\/)?4$/)).toBeTruthy();
  });

  it("puts a shape's words in Ask's chip when he picks it on the stage", async () => {
    open(deckView({ slides: [slide(1, { shapes: [{ id: 3, name: "Figures", bbox: [0.1, 0.4, 0.9, 0.7], text: "6,200 stream viewers" }] })], renders: { file: { rev: "f1", size: 10, pages: 1 }, proposed: null } }));
    const shape = await found('[data-shape="3"]');
    fireEvent.click(shape);
    expect(shape.getAttribute("aria-pressed")).toBe("true");
    // Picked is the selection's fill alone; the accent outline is the focus ring's, not a second mark.
    expect(shape.className).not.toMatch(/outline-2|outline-\(--accent\)/);
    expect(await screen.findByRole("button", { name: /Ask/ })).toBeTruthy();
  });

  it("follows the host's push when the agent revises the deck", async () => {
    open(deckView());
    await found("[data-slides-stage]");
    act(() => deckHost.push(revised()));
    expect(await screen.findByRole("toolbar", { name: "Review changes" })).toBeTruthy();
  });

  it("offers PowerPoint in the tab row for a hosted deck, and says there what waits in TempCode", async () => {
    open({ ...revised(), hosted: true });
    const tabs = await screen.findByRole("tablist", { name: "Open in" });
    // The 24px switch keeps its pill inside the track: the list is the indicator's box at the switch's height.
    expect(tabs.className).toContain("relative");
    expect(tabs.className).toContain("group-data-[orientation=horizontal]/tabs:h-6");
    fireEvent.click(within(tabs).getByRole("tab", { name: "PowerPoint" }));
    const waiting = await screen.findByText("5 suggestions wait in TempCode");
    // In a narrow bar the sentence goes whole and Review stays, never a sentence cut mid-word.
    expect(waiting.hasAttribute("data-narrow-hide")).toBe(true);
    expect(waiting.className).toContain("@max-[560px]/bar:hidden");
    expect(screen.getByText("Not built yet")).toBeTruthy();
    expect(screen.queryByRole("toolbar", { name: "Review changes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("toolbar", { name: "Review changes" })).toBeTruthy();
  });

  it("has no switch for a deck on disk", async () => {
    open(deckView());
    await found("[data-slides-stage]");
    expect(screen.queryByRole("tablist", { name: "Open in" })).toBeNull();
  });

  it("says once when the host cannot draw the slides, and still lists them", async () => {
    open(deckView({ renders: { file: null, proposed: null }, renderError: "LibreOffice is not installed on this host" }));
    const line = await found('[data-canvas-state="failed"]');
    expect(line.textContent).toContain("Can't draw the slides");
    expect(thumbs()).toHaveLength(12);
    expect(thumbs()[2].textContent).toContain("Slide 3");
  });

  it("says a slide pdf.js could not draw in the stage's place, with Retry that draws it again", async () => {
    const paint = DECK.paint;
    let refuse = true;
    DECK.paint = (...args) => (refuse ? Promise.reject(new Error("worker gone")) : paint(...args));
    try {
      open(deckView());
      const failed = await found("[data-slides-stage] [data-slide-failed]");
      expect(failed.textContent).toContain("Couldn't draw this slide");
      // A thumbnail that fails stays a blank: the stage alone says so.
      expect(document.querySelectorAll("[data-slide-failed]")).toHaveLength(1);
      refuse = false;
      fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(document.querySelector("[data-slides-stage] [data-slide-failed]")).toBeNull());
      await waitFor(() => expect(document.querySelector("[data-slides-stage]")?.textContent).toContain("Slide 1"));
    } finally {
      DECK.paint = paint;
    }
  });

  it("a picture this window could not read gets Retry on the state line, which reads it again; the strip and the diffs stay", async () => {
    refuseReads = 1;
    reads = 0;
    open(deckView({ changes: [change("c1", 1, { edits: [{ where: "Title", before: "Hello", after: "Welcome" }] })], slides: deckView().slides.map((s) => (s.id === 1 ? { ...s, change: "c1" } : s)) }));
    const line = await found('[data-canvas-state="failed"]');
    expect(line.textContent).toContain("Can't draw the slides");
    expect(line.textContent).toContain("The socket closed");
    // The strip and the text diff stay drawn under the line.
    expect(thumbs()).toHaveLength(12);
    expect((await found("[data-slide-edits]")).textContent).toContain("Welcome");
    const before = reads;
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(document.querySelector('[data-canvas-state="failed"]')).toBeNull());
    expect(reads).toBe(before + 1);
    await waitFor(() => expect(document.querySelector("[data-slides-stage]")?.textContent).toContain("Slide 1"));
    expect(document.querySelector("[data-slide-edits]")?.textContent).toContain("Welcome");
  });

  it("Retry reads again only the render that failed, so the slides of the other never blank", async () => {
    reads = 0;
    // The file's render opens first and draws; the proposed one (the second open) fails.
    refuseAt = 2;
    open(revised());
    const line = await found('[data-canvas-state="failed"]');
    expect(line.textContent).toContain("The socket closed");
    // The place slide 6 left is the file's picture: on the stage, drawn while the proposed render has failed.
    fireEvent.click(thumbs().find((t) => t.dataset.slide === "ghost:6")!);
    const left = () => document.querySelector("[data-slides-stage]")!;
    await waitFor(() => expect(left().textContent).toContain("Slide 6"));
    const before = reads;
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    // It stays drawn while the proposed render is read again.
    expect(left().textContent).toContain("Slide 6");
    await waitFor(() => expect(document.querySelector('[data-canvas-state="failed"]')).toBeNull());
    expect(reads).toBe(before + 1);
    expect(left().textContent).toContain("Slide 6");
  });

  it("holds the review while the proposed render is being replaced, and binds each press to the one on screen", async () => {
    open(revised());
    const bar = await screen.findByRole("toolbar", { name: "Review changes" });
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Next change" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(bar).getByRole("button", { name: "Next change" }));
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(false));
    // The agent revises again: a new proposed render, still being read.
    let land!: () => void;
    gate = new Promise((done) => (land = done));
    act(() => deckHost.push({ ...deckHost.view, renders: { ...deckHost.view.renders, proposed: { rev: "p2", size: 1100, pages: 13 } } }));
    const held = () => within(screen.getByRole("toolbar", { name: "Review changes" }));
    await waitFor(() => expect(held().getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(true));
    expect(held().getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(true);
    // The stepper stays drawn, its count and steps still there.
    expect(held().getByRole("button", { name: "Next change" })).toBeTruthy();
    gate = null;
    act(() => land());
    await waitFor(() => expect(held().getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(held().getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(deckHost.calls).toContainEqual(["review", { changes: ["c2"], verdict: "reject", rev: "p2" }]));
  });

  it("holds the verdicts until the stage has painted the change's slide from the proposed render on screen", async () => {
    const paint = PROPOSED.paint;
    let paintNow!: () => void;
    let painting: Promise<void> | null = new Promise((done) => (paintNow = done));
    // The stage's paint of the first change's slide (page 2) waits; the rest draw as before.
    PROPOSED.paint = async (...args) => {
      if (painting && args[0] === 2 && args[1].closest("[data-slides-stage]")) await painting;
      return paint(...args);
    };
    try {
      open(revised());
      const bar = await screen.findByRole("toolbar", { name: "Review changes" });
      await waitFor(() => expect(within(bar).getByRole("button", { name: "Next change" }).hasAttribute("disabled")).toBe(false));
      fireEvent.click(within(bar).getByRole("button", { name: "Next change" }));
      await waitFor(() => expect(within(bar).getByText("1/5")).toBeTruthy());
      // The proposed render is open, the stage has not painted the slide: no verdict yet, the stepper still drawn.
      await new Promise((done) => setTimeout(done, 20));
      expect(within(bar).getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(true);
      expect(within(bar).getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      expect((await screen.findByRole("menuitem", { name: "Accept all" })).getAttribute("aria-disabled")).toBe("true");
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      painting = null;
      act(() => paintNow());
      await waitFor(() => expect(within(bar).getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(false));
    } finally {
      PROPOSED.paint = paint;
    }
  });

  it("holds the verdicts through a failed paint of the slide on the stage, and opens them once Retry paints it", async () => {
    const paint = PROPOSED.paint;
    let refuse = true;
    PROPOSED.paint = (...args) => (refuse && args[0] === 2 && args[1].closest("[data-slides-stage]") ? Promise.reject(new Error("worker gone")) : paint(...args));
    try {
      open(revised());
      const bar = await screen.findByRole("toolbar", { name: "Review changes" });
      await waitFor(() => expect(within(bar).getByRole("button", { name: "Next change" }).hasAttribute("disabled")).toBe(false));
      fireEvent.click(within(bar).getByRole("button", { name: "Next change" }));
      const failed = await found("[data-slides-stage] [data-slide-failed]");
      expect(within(bar).getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(true);
      // The change's words stay readable while the stage cannot show it.
      expect((await found("[data-slide-edits]")).textContent).toContain("Why sponsor Spring LAN");
      refuse = false;
      fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(within(bar).getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(false));
      // Every verdict goes with the revision on screen, one change or all of them.
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Reject all" }));
      await waitFor(() => expect(deckHost.calls).toContainEqual(["review", { changes: "all", verdict: "reject", rev: "p1" }]));
    } finally {
      PROPOSED.paint = paint;
    }
  });

  it("with no picture of the changes, the outline and text diffs are the review, decided on the changes' revision", async () => {
    const view = revised();
    open({ ...view, renders: { file: null, proposed: null }, renderError: "There is no picture of the slides: LibreOffice is not installed on this host or on one it reaches.", changesRev: "c9" });
    const bar = await screen.findByRole("toolbar", { name: "Review changes" });
    fireEvent.click(within(bar).getByRole("button", { name: "Next change" }));
    expect((await found("[data-slide-edits]")).textContent).toContain("Why sponsor Spring LAN");
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(bar).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(deckHost.calls).toContainEqual(["review", { changes: ["c2"], verdict: "accept", rev: "c9" }]));
  });

  it("never offers a verdict without a revision: a host that names none keeps the verbs off, the diffs still drawn", async () => {
    const view = revised();
    open({ ...view, renders: { file: null, proposed: null }, renderError: "There is no picture of the slides: LibreOffice is not installed on this host or on one it reaches." });
    const bar = await screen.findByRole("toolbar", { name: "Review changes" });
    // The strip still takes him to the change.
    await waitFor(() => expect(thumbs().length).toBeGreaterThan(0));
    fireEvent.click(thumbs().find((t) => t.dataset.slide === "2")!);
    expect((await found("[data-slide-edits]")).textContent).toContain("Why sponsor Spring LAN");
    await new Promise((done) => setTimeout(done, 20));
    expect(within(bar).getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(true);
    expect(within(bar).getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(true);
    expect(deckHost.calls.some(([m]) => m === "review")).toBe(false);
  });

  it("a press the host refuses because the changes moved on says so and reads the deck again", async () => {
    open(revised());
    const bar = await screen.findByRole("toolbar", { name: "Review changes" });
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Next change" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(bar).getByRole("button", { name: "Next change" }));
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(false));
    deckHost.review = async (changes, verdict, rev) => {
      deckHost.calls.push(["review", { changes, verdict, rev }]);
      throw new Error("The suggestions changed since this preview. Nothing was accepted or rejected; look at them again.");
    };
    const opens = deckHost.calls.filter(([what]) => what === "open").length;
    fireEvent.click(within(bar).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(deckHost.calls.filter(([what]) => what === "open").length).toBe(opens + 1));
  });

  it("bytes from another revision are no failure: the view is read again, with no failed line", async () => {
    moved = true;
    open(deckView());
    await waitFor(() => expect(deckHost.calls.filter(([what]) => what === "open").length).toBe(2));
    await waitFor(() => expect(document.querySelector("[data-slides-stage]")?.textContent).toContain("Slide 1"));
    expect(document.querySelector('[data-canvas-state="failed"]')).toBeNull();
  });

  it("a deck the host has no picture of offers no Retry: there is nothing here to read again", async () => {
    open(deckView({ renders: { file: null, proposed: null }, renderError: "LibreOffice is not installed on this host" }));
    const line = await found('[data-canvas-state="failed"]');
    expect(within(line).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("says why with the host's reason alone, not the line's own word twice", async () => {
    open(deckView({ renders: { file: null, proposed: null }, renderError: "There is no picture of the slides: LibreOffice is not installed on this host or on one it reaches." }));
    const line = await found('[data-canvas-state="failed"]');
    expect(line.textContent).toContain("LibreOffice is not installed on this host or on one it reaches.");
    expect(line.textContent).not.toContain("no picture");
    expect(renderDetail("There is no picture of the slides: the converter stopped.")).toBe("The converter stopped.");
    expect(renderDetail("Something else")).toBe("Something else");
  });

  it("holds the bar's bone and the deck's shape while it loads, the strip under the stage in a narrow canvas", async () => {
    open(deckView(), () => new Promise<DeckView>(() => undefined));
    const bar = await found("[data-canvas-bar]");
    expect(bar.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    const bones = await found("[data-slides-skeleton]");
    expect(bones.className).toContain("@container");
    expect(bones.firstElementChild!.className).toContain("@max-[400px]:flex-col-reverse");
    // The stage row sits on the stage band with its inset, as the loaded slide does, so nothing moves when the deck lands.
    const stage = bones.querySelector("[data-slides-skeleton-stage]")!;
    expect(stage.className).toContain("bg-(--slide-stage)");
    expect(stage.className).toContain("pb-(--slide-stage-inset)");
  });

  it("draws a deck the host could not open as the state line with Retry, with no bones under it", async () => {
    let fail = true;
    open(deckView(), () => (fail ? Promise.reject(new Error("The deck is not where it was.")) : Promise.resolve(deckHost.view)));
    const line = await found('[data-canvas-state="failed"]');
    expect(line.textContent).toContain("Couldn't open this deck");
    expect(line.textContent).toContain("The deck is not where it was.");
    expect(document.querySelector("[data-slides-skeleton]")).toBeNull();
    expect(document.querySelector('[data-canvas-bar] [data-slot="skeleton"]')).toBeNull();
    expect(screen.queryByText("Couldn't open this deck", { selector: "[data-slot=empty] *" })).toBeNull();
    fail = false;
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    expect(await found("[data-slides-stage]")).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-canvas-state="failed"]')).toBeNull());
  });

  it("shows a change to the speaker notes once, in the Notes section", async () => {
    const view = deckView({
      slides: [slide(1, { notes: "Thank the sponsors", change: "c1", tint: "add", from: "proposed" }), ...Array.from({ length: 11 }, (_, i) => slide(i + 2))],
      changes: [change("c1", 1, { edits: [{ where: "Title", before: "Hello", after: "Welcome" }, { where: "Notes", before: "Thank them", after: "Thank the sponsors" }] })],
      renders: { file: { rev: "f1", size: 1000, pages: 12 }, proposed: { rev: "p1", size: 1000, pages: 12 } },
    });
    open(view);
    const edits = await found("[data-slide-edits]");
    expect(edits.textContent).toContain("Welcome");
    expect(edits.textContent).not.toContain("Notes");
    expect(edits.textContent).not.toContain("Thank");
    const notes = await found("[data-slide-notes-edit]");
    expect(notes.querySelector(".line-through")!.textContent).toBe("Thank them");
    expect(notes.textContent).toContain("Thank the sponsors");
    expect(screen.getAllByText(/Thank the sponsors/)).toHaveLength(1);
  });

  it("shows what the agent wrote directly with its Undo", async () => {
    open(deckView({ mode: "writes", written: { id: "w1", text: "Wrote notes for 12 slides", at: Date.now() } }));
    const written = await found("[data-canvas-written]");
    expect(written.textContent).toContain("Wrote notes for 12 slides");
    fireEvent.click(within(written).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(deckHost.calls).toContainEqual(["undo", "w1"]));
  });
});

describe("the stage's rules", () => {
  it("is at most 760px, and short enough for the notes", () => {
    expect(stageWidth(2000, 2000, 16 / 9)).toBe(760);
    expect(stageWidth(500, 2000, 16 / 9)).toBe(468);
    expect(stageWidth(2000, 450, 16 / 9)).toBe(533);
  });
  it("counts the current slide's change and finds a change's slide where it lands", () => {
    const view = revised();
    expect(changeIndex(view, "1")).toBe(-1);
    expect(changeIndex(view, "ghost:6")).toBe(1);
    expect(slideOfChange(view, view.changes[1])!.key).toBe("6");
  });
});
