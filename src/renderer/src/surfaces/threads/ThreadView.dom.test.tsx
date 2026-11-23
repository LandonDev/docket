// @vitest-environment jsdom
/**
 * The panel yields to the thread (docs/LAYOUT.md "The right side"): in a
 * row too narrow for THREAD_MIN + PANEL_MIN it is not drawn, keeps its open
 * state, and returns when the row widens; between, it shrinks.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PANEL_MIN, rightPanel, THREAD_MIN } from "../../lib/rightPanel";
import type { ReactNode } from "react";
import type { Session } from "../../lib/session";

vi.mock("../chunks", () => ({
  threadViewsChunk: { surface: () => () => null },
  // The canvas seat (work/canvas), asked for by a Work thread alone.
  workCanvasChunk: {
    surface: (name: string) => {
      canvas.asked.push(name);
      return (props: { session: Session; children: ReactNode }) => (
        <div data-canvas-seat data-session={props.session.id}>
          {props.children}
        </div>
      );
    },
  },
  rightPanelChunk: {
    surface: () => (props: { width?: number; motion?: string; onLeft?: () => void; session: Session; paneId?: string }) => (
      <aside
        aria-label="Thread panel"
        data-width={props.width}
        data-motion={props.motion ?? ""}
        data-session={props.session.id}
        data-host={props.session.environmentId}
        data-pane={props.paneId}
        onTransitionEnd={props.onLeft}
      />
    ),
  },
}));
vi.mock("./ChatView", () => ({ ChatView: () => <div data-chat /> }));
// Which threads the store says are Work threads (`SessionMeta.scope`).
const canvas = vi.hoisted(() => ({ asked: [] as string[], work: new Set<string>() }));
vi.mock("../../lib/tcserver/store", () => ({
  useSessionMetaValue: (id: string, read: (meta: { scope?: string }) => unknown) => read({ scope: canvas.work.has(id) ? "work" : undefined }),
}));
vi.mock("../../lib/masterThread", () => ({ isMasterThread: () => false }));
// The store's sessions by id, as useSessionById reads them.
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../lib/threads/agents", () => ({ useSessionById: (id: string | null) => (id ? store.get(id) : undefined) }));

import { ThreadView } from "./ThreadView";

let resize: (width: number) => void = () => {};
class FakeResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe() {
    resize = (width) => this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  rightPanel.reset();
  store.clear();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const session = { id: "t1", parentId: null, threadType: "chat" } as unknown as Session;
const view = () =>
  render(
    <ThreadView
      session={session}
      composing={false}
      onArmNewPass={() => {}}
      onOpenFile={() => {}}
      onOpenDiff={() => {}}
      {...({} as never)}
    />,
  );
const panel = () => screen.queryByRole("complementary", { name: "Thread panel" });

describe("ThreadView's panel", () => {
  it("hides with no room, keeps its open state, and returns when the row widens", () => {
    rightPanel.open("t1");
    view();
    act(() => resize(1200));
    expect(panel()?.getAttribute("data-width")).toBe("320");

    act(() => resize(THREAD_MIN + 280));
    expect(panel()?.getAttribute("data-width")).toBe("280");

    act(() => resize(THREAD_MIN + PANEL_MIN - 1));
    expect(panel()).toBeNull();
    expect(rightPanel.get("t1").open).toBe(true);
    expect(rightPanel.hasRoom("t1")).toBe(false);

    act(() => resize(1000));
    expect(panel()).not.toBeNull();
    expect(rightPanel.hasRoom("t1")).toBe(true);
  });

  it("gives the room back when the thread leaves the screen", () => {
    rightPanel.open("t1");
    const { unmount } = view();
    act(() => resize(400));
    expect(rightPanel.hasRoom("t1")).toBe(false);
    unmount();
    expect(rightPanel.hasRoom("t1")).toBe(true);
  });

  it("slides only on a toggle in place: a pane mounted open is just there, a close leaves until its slide ends", () => {
    rightPanel.open("t1");
    view();
    act(() => resize(1200));
    expect(panel()?.getAttribute("data-motion")).toBe("");
    act(() => rightPanel.close("t1"));
    expect(panel()?.getAttribute("data-motion")).toBe("leave");
    expect(panel()?.getAttribute("data-width")).toBe("320");
    act(() => rightPanel.open("t1"));
    expect(panel()?.getAttribute("data-motion")).toBe("arrive");
    act(() => rightPanel.close("t1"));
    act(() => {
      panel()!.dispatchEvent(new Event("transitionend", { bubbles: true }));
    });
    expect(panel()).toBeNull();
  });

  it("a leave whose slide never ends is gone after twice the exit's time; the row clips on x alone", () => {
    vi.useFakeTimers();
    try {
      rightPanel.open("t1");
      const { container } = view();
      act(() => resize(1200));
      expect((container.firstChild as HTMLElement).className).toContain("overflow-x-clip");
      act(() => rightPanel.close("t1"));
      expect(panel()).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(panel()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the panel follows the thread the pane shows", () => {
  it("draws the pane's own thread, then a shown child on its host, then the tab's again", () => {
    rightPanel.open("t1");
    store.set("kid", { id: "kid", environmentId: "env_box", parentId: null });
    view();
    act(() => resize(1200));
    expect(panel()?.getAttribute("data-session")).toBe("t1");
    act(() => rightPanel.showThread("t1", { id: "kid", environmentId: "env_box" }));
    expect(panel()?.getAttribute("data-session")).toBe("kid");
    expect(panel()?.getAttribute("data-host")).toBe("env_box");
    expect(panel()?.getAttribute("data-pane")).toBe("t1");
    act(() => rightPanel.showThread("t1", null));
    expect(panel()?.getAttribute("data-session")).toBe("t1");
  });

  it("holds a skeleton, never another host's thread of that id, until the shown thread's session is in the store", () => {
    rightPanel.open("t1");
    store.set("kid", { id: "kid", environmentId: "local", parentId: null });
    view();
    act(() => resize(1200));
    act(() => rightPanel.showThread("t1", { id: "kid", environmentId: "env_box" }));
    const aside = panel();
    expect(aside?.getAttribute("data-session")).toBeNull();
    expect(aside?.querySelector("[role='status']")?.getAttribute("aria-label")).toBe("Loading panel");
  });

  it("a bare view draws no panel of its own and leaves the room alone", () => {
    rightPanel.open("t1");
    render(
      <ThreadView session={session} composing={false} onArmNewPass={() => {}} onOpenFile={() => {}} onOpenDiff={() => {}} bare {...({} as never)} />,
    );
    act(() => resize(100));
    expect(panel()).toBeNull();
    expect(rightPanel.hasRoom("t1")).toBe(true);
  });
});

describe("a Work thread's canvas seat", () => {
  it("is not mounted for a code thread, whose view is the tree it always was", () => {
    canvas.work.clear();
    const { container } = view();
    expect(container.querySelector("[data-canvas-seat]")).toBeNull();
    expect(container.querySelector("[data-chat]")).not.toBeNull();
  });

  it("wraps the view of a thread whose row says Work, and of that thread alone", () => {
    canvas.work.add("t1");
    const { container } = view();
    const seat = container.querySelector("[data-canvas-seat]");
    expect(seat?.getAttribute("data-session")).toBe("t1");
    expect(seat?.querySelector("[data-chat]")).not.toBeNull();
    canvas.work.clear();
  });

  it("holds the pane's quiet word in the chat's place while the host has no rows, inside the same seat", () => {
    canvas.work.add("t1");
    const { container } = render(
      <ThreadView session={session} composing={false} onArmNewPass={() => {}} onOpenFile={() => {}} onOpenDiff={() => {}} quiet={<p data-no-rows>No messages yet</p>} {...({} as never)} />,
    );
    const seat = container.querySelector("[data-canvas-seat]");
    expect(seat?.querySelector("[data-no-rows]")?.textContent).toBe("No messages yet");
    expect(seat?.querySelector("[data-chat]")).toBeNull();
    canvas.work.clear();
  });
});
