// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureFileParams, CaptureState } from "@shared/contract-work-capture";
import type { CaptureHost } from "./client";
import { captureHost } from "./client";
import { CapturePage, type CaptureBridge } from "./CapturePage";
import { CaptureKeyRow, type CaptureKeyApi, type CaptureKeyState } from "./CaptureKeyRow";
import { choiceOfDigit, draftRefusal, stepChoice } from "./draft";
import { CaptureView } from "./CaptureView";

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
let hidden: () => void = () => {};
/** The host's `work.lifeos` push, as the capture socket hears it. */
let lifeosPush: () => void = () => {};
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
    onLifeos: (fn) => {
      lifeosPush = fn;
      return () => {};
    },
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
    onHidden: (fn: () => void) => {
      hidden = fn;
      return () => {};
    },
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const field = () => screen.getByRole("textbox", { name: "Capture" }) as HTMLTextAreaElement;
const pressed = () => within(screen.getByRole("group", { name: "Job" })).getAllByRole("button").find((b) => b.getAttribute("aria-pressed") === "true")?.textContent;

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

  it("calls each job by its workspace's name, the sector's word only where no workspace names it", async () => {
    state = { ...state, jobs: [{ sector: "purdue", name: "Purdue Esports" }, { sector: "life", name: "Life" }] };
    await open();
    expect(pressed()).toBe("Purdue Esports");
    const job = screen.getByRole("group", { name: "Job" });
    expect([...job.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Unsorted", "Cosmic", "Hypixel", "Purdue Esports", "Ref", "Unify", "Life"]);
    // Seven long names in 680px: the track shrinks to the row, the chosen name whole, the others cut.
    expect(job.className).toContain("min-w-0");
    const chosen = within(job).getByRole("button", { name: "Purdue Esports" });
    expect(chosen.className).toContain("data-pressed:shrink-0");
    expect(chosen.className).toContain("data-pressed:max-w-none");
    // A short name keeps its width: capped, never shrunk.
    expect(within(job).getByRole("button", { name: "Life" }).className).toContain("max-w-18");
    expect(within(job).getByRole("button", { name: "Life" }).className).toContain("shrink-0");
    expect(chosen.querySelector("span")!.className).toContain("truncate");
  });

  it("adds a dropped file with its path on this host, and refuses one whose sector has no workspace here", async () => {
    await open();
    const drop = Object.assign(new File(["x"], "plan.pdf"), { path: "/Users/l/plan.pdf" });
    fireEvent.drop(screen.getByText("Start thread").closest("[data-capture]")!, { dataTransfer: { files: [drop], types: ["Files"] } });
    await flush();
    expect(screen.getByRole("list", { name: "Files" }).textContent).toContain("plan.pdf");
    fireEvent.keyDown(field(), { key: "2", code: "Digit2", ctrlKey: true });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("No Cosmic workspace on this Mac to keep the file in");
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
    expect(screen.getByRole("alert").textContent).toBe("This computer cannot use LifeOS now. See why under Settings, Connections.");
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

  /** Council round 8 (Opus rest 1, Sol rest 1): every down state read "Not signed in to LifeOS". */
  it.each([
    ["signed-out", /^Not signed in to LifeOS on this (Mac|PC)$/, false],
    ["pairing", /^The LifeOS sign-in on this (Mac|PC) waits for your approval$/, false],
    ["refused", /^LifeOS refused this (Mac|PC)'s sign-in$/, false],
    ["off", /^Work is off on this (Mac|PC)$/, false],
    ["connecting", /^LifeOS is still connecting on this (Mac|PC)$/, false],
    ["unreachable", /^LifeOS did not answer this (Mac|PC)$/, true],
  ] as const)("says LifeOS %s in the rule's words, this computer named, Retry only for silence, the draft kept", async (lifeos, words, retry) => {
    state = { ...state, connected: false, lifeos };
    let asks = 0;
    const counting: CaptureHost = { ...host(), state: () => (++asks, Promise.resolve(state)) };
    render(<CapturePage host={counting} bridge={bridge} />);
    act(() => shown());
    await flush();
    fireEvent.change(field(), { target: { value: "Call the ref assigner" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await flush();
    expect(filed).toEqual([]);
    const line = screen.getByText(words);
    expect(Boolean(line.closest("[role=alert]"))).toBe(retry);
    expect(Boolean(screen.queryByRole("button", { name: "Retry" }))).toBe(retry);
    expect(screen.queryByRole("button", { name: /^Sign in|^Show the code/ })).toBeNull();
    expect((screen.getByText("File").closest("button") as HTMLButtonElement).disabled).toBe(true);
    if (retry) {
      const before = asks;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await flush();
      expect(asks).toBe(before + 1);
    }
    expect(field().value).toBe("Call the ref assigner");
  });

  it("files nothing while LifeOS is away, and says so: a host a build behind, with no state, keeps the old words", async () => {
    state = { ...state, connected: false };
    await open();
    fireEvent.change(field(), { target: { value: "x" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(filed).toEqual([]);
    expect(screen.getByText("Not signed in to LifeOS")).toBeTruthy();
    expect((screen.getByText("Start thread").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * Council round 7 (Sol, the rest 2): a state ask that failed read "Not signed in to LifeOS". Council round 10 (Sol
   * rest 1): File and Start thread stayed live, and Return cleared the draft to file on the old state.
   */
  it("says a state ask that failed as this computer's silence, with Retry, keeps the draft, and holds File and Return until it answers", async () => {
    const real = state;
    let asks = 0;
    const failing: CaptureHost = { ...host(), state: () => (++asks <= 2 ? Promise.reject(new Error("No answer in 15 s")) : Promise.resolve(real)) };
    render(<CapturePage host={failing} bridge={bridge} />);
    act(() => shown());
    await flush();
    fireEvent.change(field(), { target: { value: "Call the ref assigner" } });
    expect(screen.queryByText("Not signed in to LifeOS")).toBeNull();
    expect(screen.getByText(/^This (Mac|PC) did not answer$/)).toBeTruthy();
    expect((screen.getByText("Start thread").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("File").closest("button") as HTMLButtonElement).disabled).toBe(true);
    // Return asks again and files nothing; the draft stays and the window stays.
    fireEvent.keyDown(field(), { key: "Enter" });
    await flush();
    expect(filed).toEqual([]);
    expect(bridge.hide).not.toHaveBeenCalled();
    expect(field().value).toBe("Call the ref assigner");
    expect(asks).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(asks).toBe(3);
    expect((screen.getByText("Start thread").closest("button") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/did not answer/)).toBeNull();
    expect(field().value).toBe("Call the ref assigner");
  });
});

describe("Retry in flight (council round 12, Sol rest 3)", () => {
  it("spins on Retry alone, held, with the line and the draft kept, until its own read answers: then the latest cause, or File", async () => {
    const real = state;
    const asks: { ok(s: CaptureState): void; fail(): void }[] = [];
    const held: CaptureHost = { ...host(), state: () => new Promise<CaptureState>((ok, fail) => void asks.push({ ok, fail: () => fail(new Error("No answer in 15 s")) })) };
    render(<CapturePage host={held} bridge={bridge} />);
    act(() => shown());
    await act(async () => asks[0].fail());
    fireEvent.change(field(), { target: { value: "Call the ref assigner" } });
    const retry = () => screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    const busy = () => retry().querySelector("[data-slot=busy-label]")?.hasAttribute("data-busy") ?? false;
    expect(busy()).toBe(false);
    fireEvent.click(retry());
    expect(asks).toHaveLength(2);
    expect(busy()).toBe(true);
    expect(retry().disabled).toBe(true);
    // A second press while it is out asks nothing more; the line and the draft stand.
    fireEvent.click(retry());
    expect(asks).toHaveLength(2);
    expect(screen.getByText(/^This (Mac|PC) did not answer$/)).toBeTruthy();
    expect(field().value).toBe("Call the ref assigner");
    expect((screen.getByText("File").closest("button") as HTMLButtonElement).disabled).toBe(true);
    // The answer is LifeOS's own silence now: its words in the line's place, Retry at rest.
    await act(async () => asks[1].ok({ ...real, connected: false, lifeos: "unreachable" }));
    expect(screen.getByText(/^LifeOS did not answer this (Mac|PC)$/)).toBeTruthy();
    expect(busy()).toBe(false);
    expect(retry().disabled).toBe(false);
    fireEvent.click(retry());
    expect(busy()).toBe(true);
    await act(async () => asks[2].ok(real));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect((screen.getByText("File").closest("button") as HTMLButtonElement).disabled).toBe(false);
    expect(field().value).toBe("Call the ref assigner");
  });
});

describe("a sign-in made elsewhere while the window shows (council round 9)", () => {
  it("reads the state again on the host's LifeOS push, so the line goes by itself and the draft stays", async () => {
    state = { ...state, connected: false, lifeos: "signed-out" } as CaptureState;
    let asks = 0;
    const counting: CaptureHost = { ...host(), state: () => (++asks, Promise.resolve(state)) };
    render(<CapturePage host={counting} bridge={bridge} />);
    act(() => shown());
    await flush();
    fireEvent.change(field(), { target: { value: "Book the arena" } });
    expect(screen.getByText(/^Not signed in to LifeOS on this (Mac|PC)$/)).toBeTruthy();
    state = { ...state, connected: true, lifeos: "connected" } as CaptureState;
    act(() => lifeosPush());
    await flush();
    expect(asks).toBe(2);
    expect(screen.queryByText(/Not signed in/)).toBeNull();
    expect(field().value).toBe("Book the arena");
    expect((screen.getByText("Start thread").closest("button") as HTMLButtonElement).disabled).toBe(false);
    // Hidden, a push asks nothing: the next show reads afresh.
    act(() => hidden());
    act(() => lifeosPush());
    await flush();
    expect(asks).toBe(2);
  });

  it("hands the socket's work.lifeos push to its listeners, and no other push", async () => {
    let push: (p: unknown) => void = () => {};
    const make = () =>
      ({ onClose: () => () => {}, onPush: (fn: (p: unknown) => void) => ((push = fn), () => {}), open: async () => ({}), request: async () => state, close() {} }) as never;
    const h = captureHost(async () => 4000, make);
    const heard = vi.fn();
    const off = h.onLifeos(heard);
    await h.state();
    push({ push: "work.outbox" });
    expect(heard).not.toHaveBeenCalled();
    push({ push: "work.lifeos", status: { lifeos: { state: "connected" }, keys: [] } });
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    push({ push: "work.lifeos", status: { lifeos: { state: "connected" }, keys: [] } });
    expect(heard).toHaveBeenCalledTimes(1);
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
    const file = [{ id: "a", name: "a.pdf", path: "/a" }];
    expect(draftRefusal({ text: "", files: file, sector: "cosmic" }, [], "This PC")).toBe("No Cosmic workspace on this PC to keep the file in");
    expect(draftRefusal({ text: "", files: file, sector: "cosmic" }, [])).toBe("No Cosmic workspace on this computer to keep the file in");
  });

  it("keeps the field to whole 22px lines: one line empty (14 + 22 + 8 = 44px), twelve at most (286px)", () => {
    const { container } = render(<CaptureView text="" files={[]} sector="life" status="ready" error={null} canFile={false} onText={() => {}} onSector={() => {}} onRemoveFile={() => {}} onFile={() => {}} />);
    const area = container.querySelector("textarea")!;
    for (const cls of ["min-h-11", "max-h-[17.875rem]", "leading-[22px]", "pt-3.5", "pb-2", "field-sizing-content"]) expect(area.className).toContain(cls);
    expect(area.getAttribute("rows")).toBe("1");
    expect(14 + 22 + 8).toBe(44);
    expect(14 + 12 * 22 + 8).toBe(17.875 * 16);
    // The foot's inset is the field's: 16px.
    expect(container.querySelector("[data-capture] > div.border-t")!.className).toContain("px-4");
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
        onPush: () => () => {},
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
