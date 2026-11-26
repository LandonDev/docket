// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadToast, seatRect, TOAST_WIDTH, Toaster, toastInset } from "./toaster";
import { refreshToastAnchor, registerToastSeat, seatedSession, subscribeToastAnchor, toastAnchor, toastSeatOver } from "../../lib/toastAnchor";
import { QuestionCard } from "../../surfaces/QuestionCard";
import { ChatFooter } from "../../surfaces/threads/chatSlots";
import { SplitShell } from "../../surfaces/threads/SplitShell";
import { BatchFoot } from "../../surfaces/threads/master/BatchFoot";
import { emptyBatch } from "@server/shared/contract-batch";

afterEach(cleanup);

const WINDOW = { width: 1440, height: 900 };
const TOAST_H = 64;

/** The toast's box at the bottom of the stack, from the inset. */
function toastBox(viewport: { width: number; height: number }, inset: { bottom: number; right: number; width: number }) {
  const bottom = viewport.height - inset.bottom;
  const right = viewport.width - inset.right;
  return { top: bottom - TOAST_H, bottom, left: right - inset.width, right };
}

function meets(a: { top: number; bottom: number; left: number; right: number }, b: typeof a): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe("toastInset", () => {
  it("sits 16/16 from the window's corner with no anchor", () => {
    expect(toastInset(WINDOW, null)).toEqual({ bottom: 16, right: 16, width: TOAST_WIDTH });
  });

  it("sits 8px above the anchor's top and 16px inside its right edge", () => {
    // A 28px strip over a 120px composer: the footer starts 148px above the bottom.
    expect(toastInset(WINDOW, { top: 752, right: 1100 })).toEqual({ bottom: 156, right: 356, width: TOAST_WIDTH });
  });

  it("stays clear of a right panel: the column's edge, not the window's", () => {
    const withPanel = toastInset(WINDOW, { top: 752, right: 1440 - 320 });
    expect(withPanel.right).toBe(320 + 16);
  });

  it("rises with a tall composer", () => {
    const short = toastInset(WINDOW, { top: 752, right: 1100 });
    const tall = toastInset(WINDOW, { top: 500, right: 1100 });
    expect(tall.bottom - short.bottom).toBe(252);
  });

  it("never comes closer than 16px to an edge in a narrow window", () => {
    expect(toastInset({ width: 480, height: 600 }, { top: 640, right: 520 })).toEqual({ bottom: 16, right: 16, width: TOAST_WIDTH });
  });

  // Council M F9.1: a bad rect turned into offsets beyond the window. Walk scene 48 (the question thread) is the
  // lost right edge; a hidden or detached pane's footer reads all zeros; a footer scrolled away lies off the window.
  it("takes the corner for a rect that is no footer on screen: a lost side, a hidden pane's zeros, one off the window", () => {
    const corner = { bottom: 16, right: 16, width: TOAST_WIDTH };
    expect(toastInset(WINDOW, { top: 520, right: Number.NaN, left: Number.NaN })).toEqual(corner);
    expect(toastInset(WINDOW, { top: 520, right: undefined as unknown as number })).toEqual(corner);
    expect(toastInset(WINDOW, { top: 0, right: 0, left: 0 })).toEqual(corner);
    expect(toastInset(WINDOW, { top: -40, right: 1168, left: 272 })).toEqual(corner);
    expect(toastInset(WINDOW, { top: 752, right: -10, left: -900 })).toEqual(corner);
    expect(toastInset(WINDOW, { top: 752, right: 2400, left: 1500 })).toEqual(corner);
  });

  it("keeps every toast inside the window and its column, 16px from each edge, whatever the footer's rect", () => {
    for (const viewport of [WINDOW, { width: 800, height: 520 }, { width: 400, height: 700 }]) {
      for (const top of [1, 60, viewport.height / 2, viewport.height - 1, viewport.height]) {
        for (const [left, right] of [[0, viewport.width], [200, viewport.width - 100], [viewport.width - 120, viewport.width + 300], [-200, 180]]) {
          const inset = toastInset(viewport, { top, left, right });
          expect(inset.bottom).toBeGreaterThanOrEqual(16);
          expect(inset.bottom).toBeLessThanOrEqual(viewport.height - 16);
          const box = toastBox(viewport, inset);
          expect(box.right).toBeLessThanOrEqual(viewport.width - 16);
          expect(box.left).toBeGreaterThanOrEqual(16);
          if (inset.width > 0) expect(box.left).toBeGreaterThanOrEqual(Math.max(left, 0) + 16);
        }
      }
    }
  });

  it("in a master's chat beside its board, stays inside the chat's column: no wider than it less 16px a side", () => {
    // 1000px window: the board to 640, the master's chat from 641 to the edge.
    const viewport = { width: 1000, height: 900 };
    const chat = { top: 760, left: 641, right: 1000, bottom: 900 };
    const inset = toastInset(viewport, chat);
    expect(inset.width).toBe(1000 - 641 - 32);
    const box = toastBox(viewport, inset);
    expect(box.left).toBeGreaterThanOrEqual(chat.left + 16);
    expect(box.right).toBe(chat.right - 16);
    // A wide column keeps the full toast.
    expect(toastInset({ width: 1440, height: 900 }, { top: 752, left: 272, right: 1168 }).width).toBe(TOAST_WIDTH);
  });

  it("puts no toast over the composer's Send button", () => {
    for (const [viewport, footer] of [
      [WINDOW, { top: 752, left: 272, right: 1168, bottom: 892 }],
      [WINDOW, { top: 420, left: 272, right: 1168, bottom: 892 }],
      [{ width: 900, height: 700 }, { top: 560, left: 0, right: 900, bottom: 700 }],
    ] as const) {
      const send = { top: footer.bottom - 44, bottom: footer.bottom - 12, left: footer.right - 52, right: footer.right - 20 };
      const inset = toastInset(viewport, footer);
      expect(meets(toastBox(viewport, inset), send)).toBe(false);
    }
  });
});

describe("ChatFooter's toast anchor", () => {
  const slots = (anchor: boolean) => ({ transcript: null, strip: <div />, composer: <div />, anchor: anchor ? "s1" : undefined });

  it("marks and registers only the focused pane's footer", () => {
    const view = render(<ChatFooter slots={slots(false)} />);
    expect(view.container.querySelector("[data-toast-anchor]")).toBeNull();
    expect(toastAnchor()).toBeNull();
    view.rerender(<ChatFooter slots={slots(true)} />);
    const footer = view.container.querySelector<HTMLElement>("[data-toast-anchor]");
    expect(footer).not.toBeNull();
    expect(toastAnchor()).toBe(footer);
    view.rerender(<ChatFooter slots={slots(false)} />);
    expect(toastAnchor()).toBeNull();
  });

  it("follows the pane that gained the focus last, and falls back when it leaves", () => {
    const a = render(<ChatFooter slots={slots(true)} />);
    const b = render(<ChatFooter slots={slots(true)} />);
    expect(toastAnchor()).toBe(b.container.firstElementChild);
    b.unmount();
    expect(toastAnchor()).toBe(a.container.firstElementChild);
    a.unmount();
    expect(toastAnchor()).toBeNull();
  });
});

describe("a waiting card's seat", () => {
  const footer = { top: 752, bottom: 892, left: 272, right: 1168 };
  const view = { top: 48, bottom: 752 };

  it("sits the stack 8px above a card wholly in view, inside the footer's column", () => {
    const card = { top: 520, bottom: 744, left: 336, right: 1104 };
    const seat = seatRect(footer, card, view);
    expect(seat).toEqual({ ...footer, top: 520 });
    expect(toastInset(WINDOW, seat)).toEqual({ bottom: WINDOW.height - 520 + 8, right: 1440 - 1168 + 16, width: TOAST_WIDTH });
    // No toast meets the card: its foot (Back, Skip, Next) stays clear.
    expect(meets(toastBox(WINDOW, toastInset(WINDOW, seat)), card)).toBe(false);
  });

  it("keeps the footer's sides when the rects are the browser's own, whose sides are prototype getters", () => {
    // A spread of a DOMRect has no right edge: the stack fell to the window's left, over the rail (council F9.1).
    class Box {
      constructor(private readonly r: { top: number; bottom: number; left: number; right: number }) {}
      get top() { return this.r.top; }
      get bottom() { return this.r.bottom; }
      get left() { return this.r.left; }
      get right() { return this.r.right; }
    }
    const seat = seatRect(new Box(footer), new Box({ top: 520, bottom: 744, left: 336, right: 1104 }), view);
    expect(seat).toEqual({ ...footer, top: 520 });
    expect(toastInset(WINDOW, seat)).toEqual({ bottom: WINDOW.height - 520 + 8, right: 1440 - 1168 + 16, width: TOAST_WIDTH });
  });

  it("gives the seat back to the footer when the card is scrolled out of view, cut by the scroller, or folded shut", () => {
    expect(seatRect(footer, { top: 760, bottom: 980, left: 336, right: 1104 }, view)).toBe(footer);
    expect(seatRect(footer, { top: 20, bottom: 240, left: 336, right: 1104 }, view)).toBe(footer);
    expect(seatRect(footer, { top: 600, bottom: 800, left: 336, right: 1104 }, view)).toBe(footer);
    expect(seatRect(footer, { top: 700, bottom: 700, left: 336, right: 1104 }, view)).toBe(footer);
    expect(seatRect(footer, null, view)).toBe(footer);
  });

  it("a waiting question card seats the stack above itself; answered, back above the strip", async () => {
    const question = { sessionId: "s1", requestId: "q1", questions: [{ header: "Route", question: "Which route?", options: [{ label: "West" }, { label: "River" }] }] };
    const onAnswer = () => new Promise<void>(() => {});
    const pane = render(
      <div>
        <QuestionCard question={question} onAnswer={onAnswer} />
        <ChatFooter slots={{ transcript: null, strip: <div />, composer: <div />, anchor: "s1" }} />
      </div>,
    );
    const anchor = toastAnchor()!;
    expect(anchor).toBe(pane.container.querySelector("[data-toast-anchor]"));
    const seat = toastSeatOver(anchor);
    expect(seat).not.toBeNull();
    expect(seat!.querySelector('[role="button"], button')).not.toBeNull();
    await act(async () => {
      screen.getByRole("button", { name: "Skip" }).click();
    });
    expect(toastSeatOver(anchor)).toBeNull();
    pane.unmount();
  });

  it("only a card in the focused pane takes the seat", () => {
    const other = render(<div><div ref={registerToastSeat} data-card /></div>);
    const pane = render(<div><ChatFooter slots={{ transcript: null, strip: <div />, composer: <div />, anchor: "s1" }} /></div>);
    expect(toastSeatOver(toastAnchor()!)).toBeNull();
    other.unmount();
    pane.unmount();
  });
});

describe("a page over the board", () => {
  it("an anchor whose parent turns inert gives up the seat after the refresh, and takes it back when inert goes", () => {
    const view = render(<div data-board><ChatFooter slots={{ transcript: null, strip: <div />, composer: <div />, anchor: "s1" }} /></div>);
    const board = view.container.querySelector<HTMLElement>("[data-board]")!;
    const footer = board.querySelector<HTMLElement>("[data-toast-anchor]")!;
    let asked = 0;
    const stop = subscribeToastAnchor(() => asked++);
    board.setAttribute("inert", "");
    refreshToastAnchor();
    expect(asked).toBe(1);
    expect(toastAnchor()).toBeNull();
    expect(seatedSession()).toBeNull();
    board.removeAttribute("inert");
    refreshToastAnchor();
    expect(toastAnchor()).toBe(footer);
    expect(seatedSession()).toBe("s1");
    stop();
    view.unmount();
  });

  it("App asks the stack again whenever a page opens or closes over the board", () => {
    const app = readFileSync(resolve(__dirname, "../../App.tsx"), "utf8");
    expect(app).toMatch(/useLayoutEffect\(refreshToastAnchor, \[searchViewOpen \|\| settingsOpen \|\| inboxViewOpen[^\]]*, workViewShown\]\)/);
  });
});

describe("the master view's seat", () => {
  const slots = { transcript: null, strip: <div />, composer: <div />, anchor: "m1" };
  const shell = (collapsed: boolean, foot: boolean) => (
    <SplitShell
      board={
        <BatchFoot batch={emptyBatch("m1")} titleOf={() => undefined} onSave={async () => {}} onStop={async () => {}} toastAnchor={foot} />
      }
      chat={<ChatFooter slots={slots} />}
      hasBoard
      collapsed={collapsed}
      onToggleChat={() => {}}
      title="Master"
    />
  );

  it("with the chat open the stack sits over the chat; folded, above the board's foot; open again, back over the chat", () => {
    const view = render(shell(false, false));
    const footer = view.container.querySelector<HTMLElement>("[data-toast-anchor]")!;
    expect(toastAnchor()).toBe(footer);
    // MasterView passes toastAnchor={!chatOpen} to the foot.
    view.rerender(shell(true, true));
    expect(footer.closest("[inert]")).not.toBeNull();
    expect(toastAnchor()).toBe(view.container.querySelector("[data-batch-foot]"));
    view.rerender(shell(false, false));
    expect(toastAnchor()).toBe(footer);
  });

  it("a folded chat seats nothing even with no foot to take its place: the window's corner", () => {
    const view = render(shell(true, false));
    expect(toastAnchor()).toBeNull();
    view.unmount();
  });
});

describe("a toast's buttons and motion", () => {
  it("draws its action and cancel as our raised buttons", async () => {
    render(<Toaster />);
    const toast = await loadToast();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      toast("Archived", { action: { label: "Undo", onClick: () => {} }, cancel: { label: "Dismiss", onClick: () => {} } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(undo.classList).toContain("t-raise-primary");
    expect(undo.classList).toContain("!bg-transparent");
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect(dismiss.classList).toContain("t-raise-secondary");
    expect(dismiss.classList).not.toContain("!bg-muted");
  });

  it("draws a sticky toast's close as a 24px ghost at the top right, its words clear of it", async () => {
    render(<Toaster />);
    const toast = await loadToast();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      toast.error("Stop all failed", { closeButton: true, duration: Infinity });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const close = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-close-button]");
      expect(el).not.toBeNull();
      return el!;
    });
    for (const cls of ["!right-2", "!top-3.5", "!size-6", "!transform-none", "!rounded-md", "!bg-transparent", "!shadow-none", "!transition-none"]) expect(close.classList).toContain(cls);
    expect(close.closest("[data-sonner-toast]")!.className).toContain("has-[[data-close-button]]:!pe-10");
    // The app's X, 14px, never sonner's own 12px glyph.
    const glyph = close.querySelector("svg")!;
    expect(glyph.getAttribute("class")).toContain("size-3.5");
    expect(glyph.getAttribute("width")).not.toBe("12");
    const icon = document.querySelector<HTMLElement>("[data-sonner-toast] [data-icon]")!;
    expect(icon.classList).toContain("!m-0");
    expect(icon.classList).toContain("!w-auto");
  });

  it("speaks the status vocabulary: a warning is waiting's amber glyph, an error failed's red one", async () => {
    render(<Toaster />);
    const toast = await loadToast();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      toast.warning("Approve Bash");
      toast.error("Stop all failed");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const warning = await waitFor(() => {
      const el = document.querySelector('[data-toast-glyph="waiting"] [data-slot="status-mark"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const error = document.querySelector('[data-toast-glyph="failed"] [data-slot="status-mark"]')!;
    expect(error).not.toBeNull();
    expect(warning.className).toContain("text-warning");
    expect(error.className).toContain("text-destructive");
    expect(warning.querySelector("svg")!.outerHTML).not.toBe(error.querySelector("svg")!.outerHTML);
    // The title says the words; the glyph is not read twice.
    expect(warning.closest("[aria-hidden]")).not.toBeNull();
  });

  it("rides the motion tokens and the toast layer, out-specifying sonner's stylesheet", () => {
    const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
    const block = css.slice(css.indexOf(":root [data-sonner-toaster] {"), css.indexOf("}\n}", css.indexOf(':where([data-motion="reduced"]) {\n  &:root [data-sonner-toaster]')) + 3);
    expect(block).toContain("z-index: var(--layer-toast)");
    expect(block).toContain("transition-property: transform, opacity;");
    expect(block).toContain("transition-duration: var(--dur-base)");
    expect(block).toMatch(/\[data-removed="true"\] \{[^}]*var\(--dur-fast\) !important[^}]*var\(--ease-exit\) !important/);
    expect(block).toContain("transition: opacity var(--dur-fast) var(--ease-out) !important");
    expect(block).not.toMatch(/\d+m?s\b|height/);
  });
});
