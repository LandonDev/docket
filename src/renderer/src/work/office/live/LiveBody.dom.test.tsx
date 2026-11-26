// @vitest-environment jsdom
/** A live file that did not open: his Retry keeps the failure in place, its Retry spinning, until the file comes up or fails again. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveTicketAsk } from "@shared/work/officeLive";
import type { LiveLayer, LiveRect, LiveState } from "./layer";
import { LiveBody, PLACE_EVERY_MS } from "./LiveBody";
import type { LiveApp } from "./liveSwitch";

afterEach(cleanup);

function fakeLayer(first: LiveState) {
  let state = first;
  const heard = new Set<() => void>();
  const set = (next: LiveState): void => {
    state = next;
    for (const fn of heard) fn();
  };
  const layer = {
    can: () => true,
    subscribe: (_key: string, fn: () => void) => (heard.add(fn), () => void heard.delete(fn)),
    state: () => state,
    show: () => undefined,
    hide: () => undefined,
    focus: () => undefined,
    retry: () => set({ stage: "start", site: null, failed: null }),
  } as unknown as LiveLayer;
  return { layer, set };
}

describe("a live file's Retry", () => {
  it("keeps the failure with Retry spinning until the file comes up, then draws nothing over it", () => {
    const host = fakeLayer({ stage: "start", site: null, failed: "It did not load (ERR_TIMED_OUT)." });
    render(<LiveBody itemId="i1" ask="https://x.sharepoint.com/a.docx" app="word" covered={false} full={false} layer={host.layer} />);
    // Titled as every viewer's failure is, with the mode's own name.
    expect(screen.getByText("Couldn't open it in Word for the web")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("It did not load (ERR_TIMED_OUT).")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    act(() => host.set({ stage: "file", site: null, failed: null }));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("says the new failure with Retry at rest when it fails again", () => {
    const host = fakeLayer({ stage: "start", site: null, failed: "It did not load." });
    render(<LiveBody itemId="i1" ask="https://x.sharepoint.com/a.docx" app="word" covered={false} full={false} layer={host.layer} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    act(() => host.set({ stage: "start", site: null, failed: "It did not load (ERR_FAILED)." }));
    expect(screen.getByText("It did not load (ERR_FAILED).")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

/**
 * A guest is drawn only while its seat is on screen (the form that stayed over the page he went to): a seat left mounted
 * in a parked board or tab (content-visibility: hidden keeps its old rectangle) or inert under a Work view hides its
 * guest, once, and the guest comes back in place, still loaded, when the seat shows again.
 */
describe("a guest's seat on screen", () => {
  const RECT = { x: 240, y: 76, width: 900, height: 600 };
  let calls: string[];
  beforeEach(() => {
    calls = [];
    // Chromium's rule: nothing inside a content-visibility: hidden or undrawn subtree is visible. jsdom has no layout.
    HTMLElement.prototype.checkVisibility = function (this: HTMLElement) {
      return !this.closest(".board-parked, .tab-parked, [hidden]");
    };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: RECT.x, top: RECT.y, width: RECT.width, height: RECT.height } as DOMRect);
  });
  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).checkVisibility;
    vi.restoreAllMocks();
  });

  const READY: LiveState = { stage: "ready", site: null, failed: null };
  function recording(): LiveLayer {
    return {
      can: () => true,
      subscribe: () => () => undefined,
      state: () => READY,
      show: (key: string, _ask: unknown, rect: LiveRect) => void calls.push(`show ${key} ${rect.x},${rect.y} ${rect.width}x${rect.height}`),
      hide: (key: string) => void calls.push(`hide ${key}`),
      drop: (key: string) => void calls.push(`drop ${key}`),
      leave: (key: string) => (calls.push(`leave ${key}`), Promise.resolve(true)),
      focus: () => undefined,
    } as unknown as LiveLayer;
  }

  const SHOWN = `show i1 ${RECT.x},${RECT.y} ${RECT.width}x${RECT.height}`;
  const ASKS: Array<[string, LiveTicketAsk, LiveApp]> = [
    ["a Microsoft form", { forms: { tenant: "t1", formId: "f1", page: "design" } }, "forms"],
    ["Word for the web", "https://x.sharepoint.com/a.docx", "word"],
    ["Excel for the web", "https://x.sharepoint.com/b.xlsx", "excel"],
    ["PowerPoint for the web", "https://x.sharepoint.com/c.pptx", "powerpoint"],
  ];

  /** The seat under the board, a thread tab and a pane, as App draws a Files tab or a thread's canvas. */
  function seat(ask: LiveTicketAsk, app: LiveApp) {
    const layer = recording();
    const view = render(
      <div data-board="">
        <div data-tab="">
          <div data-pane="">
            <LiveBody itemId="i1" ask={ask} app={app} covered={false} full={false} layer={layer} />
          </div>
        </div>
      </div>,
    );
    const at = (name: string): HTMLElement => view.container.querySelector(`[data-${name}]`)!;
    const set = async (name: string, attr: string, value: string | null): Promise<void> => {
      await act(async () => {
        if (value === null) at(name).removeAttribute(attr);
        else at(name).setAttribute(attr, value);
      });
    };
    return { view, set };
  }

  for (const [what, ask, app] of ASKS) {
    describe(what, () => {
      it("hides while the board is parked under another page (Settings, Search, the route changed) and comes back in place", async () => {
        const s = seat(ask, app);
        expect(calls).toEqual([SHOWN]);
        await s.set("board", "class", "board-parked flex min-h-0 min-w-0 flex-col");
        expect(calls).toEqual([SHOWN, "hide i1"]);
        await s.set("board", "class", "flex min-h-0 min-w-0 flex-1 flex-col");
        expect(calls).toEqual([SHOWN, "hide i1", SHOWN]);
      });

      it("hides while its thread tab is parked behind another tab", async () => {
        const s = seat(ask, app);
        await s.set("tab", "class", "tab-parked absolute inset-0");
        expect(calls).toEqual([SHOWN, "hide i1"]);
        await s.set("tab", "class", "absolute inset-0");
        expect(calls.at(-1)).toBe(SHOWN);
      });

      it("hides while a Work view lies over its pane (the pane inert), as when he leaves the Files place for another view", async () => {
        const s = seat(ask, app);
        await s.set("pane", "inert", "");
        expect(calls).toEqual([SHOWN, "hide i1"]);
        await s.set("pane", "inert", null);
        expect(calls).toEqual([SHOWN, "hide i1", SHOWN]);
      });

      it("hides once while out of sight, so the slow check does not keep its unload clock from running", async () => {
        vi.useFakeTimers();
        try {
          const s = seat(ask, app);
          await s.set("board", "class", "board-parked");
          await act(async () => void vi.advanceTimersByTime(5 * PLACE_EVERY_MS));
          expect(calls.filter((c) => c === "hide i1")).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("hides when its seat goes (a view or tab switched away), and never unloads the guest", () => {
        const s = seat(ask, app);
        s.view.unmount();
        expect(calls).toEqual([SHOWN, "hide i1"]);
      });
    });
  }
});
