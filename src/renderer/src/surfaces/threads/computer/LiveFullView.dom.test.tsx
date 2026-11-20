// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../../lib/connection/registry";
import { sharpSize, sharpWidth } from "../../../lib/video/support";
import { FullView, drivesWords } from "./LiveFullView";
import fixtures, { streamOf, tile } from "./LiveFullView.fixtures";

const calls: { host: string; method: string; params: unknown }[] = [];
let fail: string | null = null;
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@renderer/components/ui/toaster", () => ({ loadToast: async () => Object.assign(() => undefined, { error: toastError }) }));

beforeEach(() => {
  calls.length = 0;
  fail = null;
  toastError.mockReset();
  vi.spyOn(registry, "link").mockImplementation(
    (host: string) =>
      ({
        request: async (method: string, params: unknown) => {
          calls.push({ host, method, params });
          if (fail === method) throw new Error("no");
          return null;
        },
      }) as never,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const flush = () => act(async () => {});

describe("a picture at its own pixels", () => {
  it("is one frame pixel to one device pixel, or exactly two where the room allows, and never a fraction above one", () => {
    const frame = { width: 1280, height: 800 };
    // a 2× screen: 640 by 400 points at its own pixels
    expect(sharpSize(frame, 2, { width: 700, height: 500 })).toEqual({ width: 640, height: 400 });
    expect(sharpSize(frame, 2, { width: 1400, height: 900 })).toEqual({ width: 640, height: 400 });
    // the full view doubles where the window has the room, and only then
    expect(sharpSize(frame, 2, { width: 1400, height: 900 }, 2)).toEqual({ width: 1280, height: 800 });
    expect(sharpSize(frame, 2, { width: 1279, height: 900 }, 2)).toEqual({ width: 640, height: 400 });
    expect(sharpSize(frame, 2, { width: 1400, height: 799 }, 2)).toEqual({ width: 640, height: 400 });
    // a room too small for its own size: scaled down whole, in its shape
    expect(sharpSize(frame, 2, { width: 320, height: 500 })).toEqual({ width: 320, height: 200 });
    expect(sharpSize(frame, 1, { width: 2000, height: 400 })).toEqual({ width: 640, height: 400 });
    expect(sharpWidth(1280, 2)).toBe(640);
    expect(sharpWidth(1280, 1)).toBe(1280);
  });
});

describe("the full view of a computer being driven", () => {
  it("draws every fixture: the picture or its line, and one row under it", () => {
    for (const fixture of fixtures) {
      const view = render(<FullView {...fixture.props} />);
      const surface = view.container.querySelector<HTMLElement>('[data-slot="live-full-view"]')!;
      expect(surface, fixture.name).not.toBeNull();
      expect(surface.querySelectorAll('[data-slot="live-full-row"]'), fixture.name).toHaveLength(1);
      const over = fixture.props.stream.state.status === "ended" || fixture.props.tile === null;
      expect(!!surface.querySelector('[data-face="live"]'), fixture.name).toBe(!over);
      expect(!!surface.querySelector('[data-face="none"]'), fixture.name).toBe(over);
      view.unmount();
    }
  });

  it("holds the picture at its own pixels in the room it has, and the surface at the picture's width", () => {
    const { container } = render(<FullView tile={tile()} all={[]} stream={streamOf({ status: "live", app: "Chromium", window: "Concur", width: 1280, height: 800, drawn: true })} room={{ width: 1400, height: 900 }} name="Live view" dpr={2} />);
    const box = container.querySelector<HTMLElement>('[data-face="live"]')!;
    expect([box.style.width, box.style.height]).toEqual(["1280px", "800px"]);
    expect(container.querySelector<HTMLElement>('[data-slot="live-full-view"]')!.style.width).toBe("1304px");
    cleanup();
    const small = render(<FullView tile={tile()} all={[]} stream={streamOf({ status: "live", app: "Chromium", window: "Concur", width: 1280, height: 800, drawn: true })} room={{ width: 900, height: 700 }} name="Live view" dpr={2} />);
    expect(small.container.querySelector<HTMLElement>('[data-face="live"]')!.style.width).toBe("640px");
  });

  it("says who drives in the canvas bar's words, and nothing for a window with no driver", () => {
    expect(drivesWords(tile())).toBe("The agent is driving");
    expect(drivesWords(tile({ driving: true }))).toBe("You are driving");
    expect(drivesWords(tile({ browser: false }))).toBeNull();
    render(<FullView tile={tile({ driving: true })} all={[]} stream={streamOf({ status: "starting" })} room={{ width: 900, height: 700 }} name="Live view" />);
    expect(screen.getByText("You are driving").className).toContain("text-foreground");
    expect(screen.getByText("File the March expense report")).not.toBeNull();
  });

  it("Take over takes the wheel, then stops the pane's live sessions on its host; Hand back gives it back; Stop stops the one", async () => {
    const mine = tile();
    const sub = tile({ id: "box\nt1-sub", pane: "t1", entry: { ...mine.entry, row: { ...mine.entry.row, threadId: "t1-sub" } } });
    const other = tile({ id: "box\nt9", pane: "t9", entry: { ...mine.entry, row: { ...mine.entry.row, threadId: "t9" } } });
    const view = render(<FullView tile={mine} all={[mine, sub, other]} stream={streamOf({ status: "starting" })} room={{ width: 900, height: 700 }} name="Live view" />);
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await flush();
    expect(calls).toEqual([
      { host: "box", method: "work.browser.drive", params: { sessionId: "t1", driver: "owner" } },
      { host: "box", method: "computer.stop", params: { sessionId: "t1" } },
      { host: "box", method: "computer.stop", params: { sessionId: "t1-sub" } },
    ]);
    calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Stop File the March expense report" }));
    await flush();
    expect(calls).toEqual([{ host: "box", method: "computer.stop", params: { sessionId: "t1" } }]);
    // he drives: Hand back alone, since there is no session to stop
    calls.length = 0;
    view.rerender(<FullView tile={tile({ driving: true })} all={[]} stream={streamOf({ status: "starting" })} room={{ width: 900, height: 700 }} name="Live view" />);
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hand back" }).hasAttribute("data-hand-back")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Hand back" }));
    await flush();
    expect(calls).toEqual([{ host: "box", method: "work.browser.drive", params: { sessionId: "t1", driver: "agent" } }]);
  });

  it("a window on a Mac has Stop alone, and a press that fails says so once", async () => {
    fail = "computer.stop";
    render(<FullView tile={tile({ browser: false, title: "Tidy the Downloads folder" })} all={[]} stream={streamOf({ status: "starting" })} room={{ width: 900, height: 700 }} name="Live view" />);
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    const stop = screen.getByRole("button", { name: "Stop Tidy the Downloads folder" });
    fireEvent.click(stop);
    fireEvent.click(stop);
    await flush();
    await flush();
    expect(calls).toHaveLength(1);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("Couldn't stop it", { description: "Tidy the Downloads folder" });
  });

  it("offers Retry only for an end that trying again can help", () => {
    const retry = vi.fn();
    render(<FullView tile={tile()} all={[]} stream={{ ...streamOf({ status: "ended", reason: "error" }), retry }} room={{ width: 900, height: 700 }} name="Live view" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
    cleanup();
    render(<FullView tile={tile()} all={[]} stream={streamOf({ status: "ended", reason: "permission" })} room={{ width: 900, height: 700 }} name="Live view" />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
