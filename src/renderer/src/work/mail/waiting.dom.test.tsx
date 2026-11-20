// @vitest-environment jsdom
/**
 * Waiting on in TempCode (docs/agents/work-mail.md "Waiting on"): the
 * workspace page's section (the days a question waits, the nudge routine's
 * switch, off until he turns it on) and Draft a nudge, which asks the host for
 * a thread and opens it.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailWaiting } from "@shared/contract-work-mail";

const calls: { method: string; params: Record<string, unknown> }[] = [];
const state: { waiting: MailWaiting; fail: Set<string> } = { waiting: { days: 3, routine: false }, fail: new Set() };

vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: () => ({
      onPush: () => () => {},
      request: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (state.fail.has(method)) throw new Error("The box did not answer");
        if (method === "work.mail.nudge") return { sessionId: "nudge-thread" };
        if (method === "work.mail.setWaiting") {
          state.waiting = { ...state.waiting, ...(params.days !== undefined ? { days: Number(params.days) } : {}), ...(params.routine !== undefined ? { routine: Boolean(params.routine) } : {}) };
        }
        return state.waiting;
      },
    }),
  },
}));
const toasts: { kind: string; text: string }[] = [];
vi.mock("../../components/ui/toaster", async (original) => {
  const toast = Object.assign((text: string) => void toasts.push({ kind: "plain", text }), {
    error: (text: string) => void toasts.push({ kind: "error", text }),
    loading: (text: string) => (toasts.push({ kind: "loading", text }), "t1"),
    dismiss: () => void toasts.push({ kind: "dismiss", text: "" }),
  });
  return { ...(await original<object>()), loadToast: async () => toast };
});
const opened: string[] = [];
vi.mock("../../lib/workSwitch", async (original) => ({
  ...(await original<object>()),
  workOpenPort: { get: () => (id: string) => void opened.push(id) },
}));

const WORKSPACE = { id: "ws", name: "Purdue Esports", environmentId: "box", sector: "purdue", kind: "work", path: "/w" } as never;
const { WaitingSection } = await import("./WaitingSection");
const { startNudge } = await import("./client");

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  opened.length = 0;
  state.waiting = { days: 3, routine: false };
  state.fail.clear();
});
afterEach(cleanup);

describe("the workspace's Waiting on", () => {
  it("waits in its shape, then shows the days and the routine's switch, off", async () => {
    render(<WaitingSection workspace={WORKSPACE} />);
    expect(screen.queryByRole("switch")).toBeNull();
    await settle();
    expect(calls).toEqual([{ method: "work.mail.waiting", params: { workspaceId: "ws" } }]);
    expect(screen.getByText("Questions wait")).toBeTruthy();
    expect(screen.getByLabelText("Working days a question waits").textContent).toContain("3 working days");
    const routine = screen.getByRole("switch", { name: "Draft nudges by themselves" });
    expect(routine.getAttribute("aria-checked")).toBe("false");
  });

  it("turns the routine on through the host, only on his flip", async () => {
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    fireEvent.click(screen.getByRole("switch", { name: "Draft nudges by themselves" }));
    await settle();
    expect(calls.at(-1)).toEqual({ method: "work.mail.setWaiting", params: { workspaceId: "ws", routine: true } });
    expect(screen.getByRole("switch", { name: "Draft nudges by themselves" }).getAttribute("aria-checked")).toBe("true");
  });

  it("says why LifeOS did not answer under the days, and keeps the switch", async () => {
    state.waiting = { days: null, routine: true, error: "LifeOS did not answer: down" };
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByText("LifeOS did not answer: down")).toBeTruthy();
    expect(screen.queryByLabelText("Working days a question waits")).toBeNull();
    expect(screen.getByRole("switch", { name: "Draft nudges by themselves" }).getAttribute("aria-checked")).toBe("true");
  });

  it("says the host did not answer, with Retry", async () => {
    state.fail.add("work.mail.waiting");
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByText("The box did not answer")).toBeTruthy();
    state.fail.clear();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByRole("switch", { name: "Draft nudges by themselves" })).toBeTruthy();
  });
});

describe("Draft a nudge", () => {
  it("asks the host for the thread, says so while it starts, and opens it", async () => {
    await startNudge("box", "ws", "mt1");
    expect(calls).toEqual([{ method: "work.mail.nudge", params: { workspaceId: "ws", threadId: "mt1" } }]);
    expect(toasts.map((t) => t.kind)).toEqual(["loading", "dismiss"]);
    expect(opened).toEqual(["nudge-thread"]);
  });

  it("says it did not start when the host refuses, and opens nothing", async () => {
    state.fail.add("work.mail.nudge");
    await startNudge("box", "ws", "mt1");
    expect(toasts.at(-1)).toEqual({ kind: "error", text: "The nudge did not start" });
    expect(opened).toEqual([]);
  });
});
