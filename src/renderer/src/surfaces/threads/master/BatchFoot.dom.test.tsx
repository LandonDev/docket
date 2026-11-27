// @vitest-environment jsdom
/** A step's console stays in its fold while the fold closes. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emptyBatch, type BatchState } from "@server/shared/contract-batch";
// Base UI's panel unmounts its content only after its exit; jsdom runs no exit, so a stand-in
// panel that stays mounted shows what the row hands it while it closes.
vi.mock("../../../components/ui/collapsible", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../components/ui/collapsible")>();
  const { createContext, useContext } = await import("react");
  const Open = createContext(false);
  return {
    ...real,
    Collapsible: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => <Open.Provider value={!!open}>{children}</Open.Provider>,
    CollapsibleContent: ({ children }: { children?: React.ReactNode }) => <div data-panel={useContext(Open) ? "open" : "closed"}>{children}</div>,
  };
});

import { BatchFoot } from "./BatchFoot";

afterEach(cleanup);

const t = Date.now() - 5 * 60_000;

function failedGate(): BatchState {
  const state = emptyBatch("m");
  const [land, gate, release] = state.steps;
  return {
    ...state,
    steps: [
      { ...land, status: "passed", detail: "nothing landed", at: t, startedAt: t, endedAt: t },
      { ...gate, status: "failed", detail: "vitest: 2 failed", at: t, startedAt: t, endedAt: t + 69_000, log: ["✓ typecheck 12s", "✗ vitest 2 failed", "  src/a.test.ts"] },
      release,
    ],
  };
}

const noop = async () => {};

describe("BatchFoot", () => {
  it("keeps a step's console in its fold while the fold closes: the panel, not the row, decides when it goes", () => {
    render(<BatchFoot batch={failedGate()} titleOf={() => undefined} onSave={noop} onStop={noop} />);
    const gate = document.querySelector('[data-step="gate"]') as HTMLElement;
    expect(gate.querySelector("[data-console]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    // The stand-in panel stays mounted while closing, as Base UI's does until its exit ends:
    // what it holds is still the console's lines, never an empty box.
    const panel = gate.querySelector("[data-panel]") as HTMLElement;
    expect(panel.dataset.panel).toBe("closed");
    expect(panel.querySelector("[data-console]")?.textContent).toContain("vitest 2 failed");
  });

  it("the Log toggle keeps no fill while its log is open, as every disclosure trigger", () => {
    render(<BatchFoot batch={failedGate()} titleOf={() => undefined} onSave={noop} onStop={noop} />);
    const log = screen.getByRole("button", { name: "Log" });
    expect(log.getAttribute("aria-expanded")).toBe("true");
    const classes = log.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["aria-expanded:bg-transparent", "aria-expanded:hover:bg-foreground/7"]));
    expect(classes).not.toContain("aria-expanded:bg-foreground/7");
  });

  it("ends Edit…, Stop and Log on the 12px edge the times keep: each takes its own 8px back", () => {
    render(<BatchFoot batch={failedGate()} titleOf={() => undefined} onSave={noop} onStop={noop} />);
    expect(screen.getByRole("button", { name: "Edit…" }).className.split(/\s+/)).toContain("-me-2");
    expect(screen.getByRole("button", { name: "Log" }).className.split(/\s+/)).toContain("-me-2");
  });

    it("an instant step says no time", () => {
    render(<BatchFoot batch={failedGate()} titleOf={() => undefined} onSave={noop} onStop={noop} />);
    expect(document.querySelector('[data-step="land"] [data-step-time]')).toBeNull();
    expect(document.querySelector('[data-step="gate"] [data-step-time]')?.textContent).toBe("1m 9s");
  });
  // boards-03 (D5): a key that may not change the rules or stop a step gets neither press.
  it("draws no Edit… and no Stop where the key may not use them", () => {
    const state = failedGate();
    const running: BatchState = { ...state, steps: state.steps.map((s) => (s.id === "gate" ? { ...s, status: "running", endedAt: undefined } : s)) };
    render(<BatchFoot batch={running} titleOf={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(document.querySelector('[data-step="gate"]')).not.toBeNull();
  });
  // Round 2: both go to the master's host; held in place while it is away, the link's words their tooltip.
  it("holds Edit… and Stop while the master's host is away", () => {
    const state = failedGate();
    const running: BatchState = { ...state, steps: state.steps.map((s) => (s.id === "gate" ? { ...s, status: "running", endedAt: undefined } : s)) };
    render(<BatchFoot batch={running} titleOf={() => undefined} onSave={noop} onStop={noop} held="The box is offline" />);
    for (const name of ["Edit…", "Stop"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.closest("[data-held]")?.className).toContain("-me-2");
    }
  });
  it("a running step's Stop is the word alone, its spinner in the slot BusyLabel holds while the stop runs", async () => {
    let finish: () => void = () => {};
    const onStop = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const state = failedGate();
    const running: BatchState = { ...state, steps: state.steps.map((s) => (s.id === "gate" ? { ...s, status: "running", endedAt: undefined } : s)) };
    render(<BatchFoot batch={running} titleOf={() => undefined} onSave={noop} onStop={onStop} />);
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop.className.split(/\s+/)).toContain("-me-2");
    expect(stop.querySelector("svg")).toBeNull();
    expect(stop.querySelector('[data-slot="busy-label"]')?.getAttribute("data-idle")).toBe("Stop");
    expect(stop.querySelector('[data-slot="busy-label"]')?.getAttribute("data-busy-text")).toBe("Stop");
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledWith("gate");
    expect(stop.querySelector('[data-slot="busy-label"]')?.hasAttribute("data-busy")).toBe(true);
    expect(stop.getAttribute("aria-busy")).toBe("true");
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    expect(stop.querySelector('[data-slot="busy-label"]')?.hasAttribute("data-busy")).toBe(false);
  });

  it("stops at three fifths of the board: twenty steps scroll inside while the heading and the last line stay", () => {
    const state = emptyBatch("m");
    const many: BatchState = {
      ...state,
      steps: [],
      rules: { ...state.rules, steps: [{ id: "land", name: "Land", kind: "land" }, ...Array.from({ length: 19 }, (_, i) => ({ id: `c${i}`, name: `Check ${i}`, kind: "shell" as const, run: "true" }))] },
    };
    render(<BatchFoot batch={many} titleOf={() => undefined} onSave={noop} />);
    const foot = document.querySelector("[data-batch-foot]") as HTMLElement;
    expect(foot.className.split(/\s+/)).toEqual(expect.arrayContaining(["max-h-3/5", "min-h-0"]));
    const list = document.querySelector("[data-steps]") as HTMLElement;
    expect(list.querySelectorAll("[data-step]")).toHaveLength(20);
    expect(list.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-0", "overflow-y-auto", "overflow-x-hidden"]));
    // The heading and the last line never give way to the list.
    expect((screen.getByText("When done").parentElement as HTMLElement).className.split(/\s+/)).toContain("shrink-0");
    expect((document.querySelector("[data-then]") as HTMLElement).className.split(/\s+/)).toContain("shrink-0");
  });

  it("keeps the console's newest line in view when its box gets shorter, unless he scrolled up", () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} });
    try {
      render(<BatchFoot batch={failedGate()} titleOf={() => undefined} onSave={noop} onStop={noop} />);
      const log = document.querySelector("[data-console]") as HTMLElement;
      Object.defineProperty(log, "scrollHeight", { configurable: true, value: 400 });
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 60 });
      log.scrollTop = 0;
      act(() => observers.forEach((cb) => cb()));
      expect(log.scrollTop).toBe(400);
      // Scrolled up: a resize leaves him where he is.
      log.scrollTop = 10;
      fireEvent.scroll(log);
      act(() => observers.forEach((cb) => cb()));
      expect(log.scrollTop).toBe(10);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
