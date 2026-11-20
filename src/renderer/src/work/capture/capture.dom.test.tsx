// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureFileParams, CaptureState } from "@shared/contract-work-capture";
import type { CaptureHost } from "./client";
import { captureHost } from "./client";
import { CapturePage, type CaptureBridge } from "./CapturePage";
import { CaptureKeyRow, type CaptureKeyApi, type CaptureKeyState } from "./CaptureKeyRow";
import { choiceOfDigit, draftRefusal, stepChoice } from "./draft";

/* The capture window's page on a host and a main that stand in: what each
   key does, what is filed, what a failure brings back. */

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

let filed: CaptureFileParams[];
let answer: () => Promise<unknown>;
let state: CaptureState;
let shown: () => void = () => {};
let bridge: CaptureBridge & { hide: ReturnType<typeof vi.fn>; failed: ReturnType<typeof vi.fn> };

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

function host(): CaptureHost {
  return {
    state: () => Promise.resolve(state),
    file: (p) => {
      filed.push(p);
      return answer() as never;
    },
    idle: () => {},
  };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  filed = [];
  answer = () => Promise.resolve({ taskId: "t1", kept: [] });
  state = { host: "env_mac", last: "purdue", homes: ["purdue", "life"], connected: true };
  bridge = {
    hide: vi.fn(),
    failed: vi.fn(),
    size: vi.fn(),
    picture: vi.fn(async () => "/tmp/capture-pictures/x/Pasted image.png"),
    pathOf: (f: File) => (f as File & { path?: string }).path ?? "",
    onShown: (fn: () => void) => {
      shown = fn;
      return () => {};
    },
    onHidden: () => () => {},
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const field = () => screen.getByRole("textbox", { name: "Capture" }) as HTMLTextAreaElement;
const pressed = () => within(screen.getByRole("group", { name: "Sector" })).getAllByRole("button").find((b) => b.getAttribute("aria-pressed") === "true")?.textContent;

async function open() {
  render(<CapturePage host={host()} bridge={bridge} />);
  act(() => shown());
  await flush();
}

describe("the capture window", () => {
  it("starts on the last sector and files on Return, hiding at once", async () => {
    await open();
    expect(pressed()).toBe("Purdue");
    fireEvent.change(field(), { target: { value: "Book the arena" } });
    fireEvent.keyDown(field(), { key: "Enter", code: "Enter" });
    expect(bridge.hide).toHaveBeenCalled();
    await flush();
    expect(filed).toEqual([{ key: expect.any(String), text: "Book the arena", sector: "purdue" }]);
    expect(field().value).toBe("");
  });

  it("starts a thread on mod+Return, keeps Shift+Return a new line, and hides on Escape", async () => {
    await open();
    fireEvent.change(field(), { target: { value: "Plan the LAN" } });
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(filed).toEqual([]);
    fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true, metaKey: true });
    fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true });
    await flush();
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ start: true });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(bridge.hide).toHaveBeenCalledTimes(2);
  });

  it("steps the sector with Tab and picks one with mod and a digit, unsorted first", async () => {
    await open();
    fireEvent.keyDown(field(), { key: "Tab" });
    expect(pressed()).toBe("Ref");
    fireEvent.keyDown(field(), { key: "Tab", shiftKey: true });
    fireEvent.keyDown(field(), { key: "Tab", shiftKey: true });
    expect(pressed()).toBe("Hypixel");
    fireEvent.keyDown(field(), { key: "1", code: "Digit1", ctrlKey: true });
    expect(pressed()).toBe("Unsorted");
    fireEvent.change(field(), { target: { value: "Later" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await flush();
    expect(filed[0]).toMatchObject({ sector: null });
  });

  it("adds a dropped file with its path on this host, and refuses one whose sector has no workspace here", async () => {
    await open();
    const drop = Object.assign(new File(["x"], "plan.pdf"), { path: "/Users/l/plan.pdf" });
    fireEvent.drop(screen.getByText("Start thread").closest("[data-capture]")!, { dataTransfer: { files: [drop], types: ["Files"] } });
    await flush();
    expect(screen.getByRole("list", { name: "Files" }).textContent).toContain("plan.pdf");
    fireEvent.keyDown(field(), { key: "2", code: "Digit2", ctrlKey: true });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("No Cosmic workspace on this computer to keep the file in");
    expect(bridge.hide).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "4", code: "Digit4", ctrlKey: true });
    fireEvent.keyDown(field(), { key: "Enter" });
    await flush();
    expect(filed[0]).toMatchObject({ text: "", sector: "purdue", files: [{ at: "file", host: "env_mac", path: "/Users/l/plan.pdf" }] });
  });

  it("keeps a pasted picture as a file through main", async () => {
    await open();
    fireEvent.paste(field(), { clipboardData: { files: [new File(["png"], "image.png", { type: "image/png" })] } });
    await flush();
    expect(bridge.picture).toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "Files" }).textContent).toContain("Pasted image.png");
  });

  it("clears the draft at the press, and brings a failed one back ahead of what he typed since", async () => {
    let fail: (e: Error) => void = () => {};
    answer = () => new Promise((_, reject) => (fail = reject));
    await open();
    fireEvent.change(field(), { target: { value: "Keep me" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("");
    fireEvent.change(field(), { target: { value: "Typed since" } });
    await act(async () => fail(new Error("LifeOS is not connected on this computer.")));
    await flush();
    expect(bridge.failed).toHaveBeenCalled();
    expect(field().value).toBe("Keep me\nTyped since");
    expect(screen.getByRole("alert").textContent).toBe("LifeOS is not connected on this computer.");
  });

  it("files a second capture while the first is on its way, each with its own key", async () => {
    answer = () => new Promise(() => {});
    await open();
    fireEvent.change(field(), { target: { value: "One" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.change(field(), { target: { value: "Two" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await flush();
    expect(filed.map((f) => f.text)).toEqual(["One", "Two"]);
    expect(filed[0]!.key).not.toBe(filed[1]!.key);
  });

  it("says so when the task is filed but the thread does not start", async () => {
    answer = () => Promise.resolve({ taskId: "t1", kept: [], threadError: "No model is signed in" });
    await open();
    fireEvent.change(field(), { target: { value: "Plan it" } });
    fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true });
    await flush();
    expect(field().value).toBe("");
    expect(screen.getByRole("alert").textContent).toBe("Filed. The thread did not start: No model is signed in");
  });

  it("leaves a dragged link to the field, and ignores keys while a composition is open", async () => {
    await open();
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(drop, { dataTransfer: { files: [], types: ["text/uri-list"] } });
    field().dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    fireEvent.change(field(), { target: { value: "x" } });
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(field(), { key: "Escape", isComposing: true });
    expect(filed).toEqual([]);
    expect(bridge.hide).not.toHaveBeenCalled();
  });

  it("files nothing while LifeOS is away, and says so", async () => {
    state = { ...state, connected: false };
    await open();
    fireEvent.change(field(), { target: { value: "x" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(filed).toEqual([]);
    expect(screen.getByText("LifeOS is not connected")).toBeTruthy();
    expect((screen.getByText("Start thread").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the draft", () => {
  it("steps round, reads digits, and needs words or a file", () => {
    expect(stepChoice("life", 1)).toBe("unsorted");
    expect(stepChoice("unsorted", -1)).toBe("life");
    expect(choiceOfDigit("Digit7")).toBe("life");
    expect(choiceOfDigit("Digit8")).toBeNull();
    expect(draftRefusal({ text: " ", files: [], sector: "life" }, [])).toBe("");
    expect(draftRefusal({ text: "x", files: [], sector: "cosmic" }, [])).toBeNull();
  });
});

describe("the socket", () => {
  it("opens once for several asks, and closes a minute after the window hides", async () => {
    vi.useFakeTimers();
    const made: { closed: boolean }[] = [];
    const make = () => {
      const t = {
        closed: false,
        onClose: () => () => {},
        open: async () => ({}),
        request: async (method: string) => (method === "work.capture.state" ? state : { taskId: "t" }),
        close() {
          this.closed = true;
        },
      };
      made.push(t);
      return t as never;
    };
    const h = captureHost(async () => 4000, make);
    await h.state();
    // As the page does: hidden at the press, filed, then idle once it settles.
    h.idle();
    await h.file({ key: "k-0000001", text: "x", sector: null });
    expect(made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(made[0]!.closed).toBe(false);
    h.idle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(made[0]!.closed).toBe(true);
    await h.state();
    expect(made).toHaveLength(2);
    vi.useRealTimers();
  });
});

describe("the capture key row", () => {
  it("records a chord, keeps the key on Escape and turns it off on Delete", async () => {
    let now: CaptureKeyState = { key: "Alt+Shift+Space", defaultKey: "Alt+Shift+Space", held: true, error: null, workOn: true };
    const api: CaptureKeyApi = { get: async () => now, set: vi.fn(async (key) => (now = { ...now, key })) };
    render(<CaptureKeyRow api={api} />);
    await flush();
    const button = screen.getByRole("button", { name: "Alt+Shift+Space" });
    fireEvent.click(button);
    expect(button.textContent).toBe("Press the keys");
    fireEvent.keyDown(button, { key: "Escape" });
    expect(api.set).not.toHaveBeenCalled();
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    await flush();
    expect(api.set).toHaveBeenCalledWith("Control+Alt+K");
    expect(button.textContent).toBe("Ctrl+Alt+K");
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Delete" });
    await flush();
    expect(api.set).toHaveBeenLastCalledWith(null);
    expect(button.textContent).toBe("Off");
  });
});
