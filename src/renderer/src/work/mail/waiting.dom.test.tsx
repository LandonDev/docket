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
const state: { waiting: MailWaiting; fail: Set<string>; timeout: Set<string>; hold: Map<string, Promise<void>> } = { waiting: { days: 3, routine: false }, fail: new Set(), timeout: new Set(), hold: new Map() };

const { TimeoutError } = await vi.importActual<typeof import("../../lib/connection")>("../../lib/connection");
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    environment: () => ({ name: "The box" }),
    linkOf: () => ({
      onPush: () => () => {},
      request: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        // As the host does (src/main/server/work/mail/waiting.ts): a read takes the routine before it waits on the days.
        const routine = state.waiting.routine;
        const hold = state.hold.get(method);
        if (hold) await hold;
        if (state.timeout.has(method)) throw new TimeoutError(method, 15_000);
        if (state.fail.has(method)) throw new Error("The box did not answer");
        if (method === "work.mail.waiting") return { ...state.waiting, routine };
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
vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));
const { GIVEN_KEY, resetTestKey, testKey } = await import("../../lib/linkMay.testkit");
const { WaitingSection, daysFailure } = await import("./WaitingSection");
const { sessionFailure } = await import("../shell/lifeos");
const { startNudge } = await import("./client");

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  opened.length = 0;
  state.waiting = { days: 3, routine: false };
  state.fail.clear();
  state.timeout.clear();
});
afterEach(() => {
  cleanup();
  resetTestKey();
});

describe("the workspace's Waiting on", () => {
  it("waits in its shape, then shows the days and the routine's switch, off", async () => {
    render(<WaitingSection workspace={WORKSPACE} />);
    expect(screen.queryByRole("switch")).toBeNull();
    await settle();
    expect(calls).toEqual([{ method: "work.mail.waiting", params: { workspaceId: "ws" } }]);
    expect(screen.getByText("Count as waiting after")).toBeTruthy();
    expect(screen.getByLabelText("Count as waiting after").textContent).toContain("3 working days");
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

  it("says why LifeOS could not read the days under them, and keeps the switch", async () => {
    state.waiting = { days: null, routine: true, error: "LifeOS did not answer: down" };
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByText("LifeOS could not read the waiting time")).toBeTruthy();
    expect(screen.queryByLabelText("Count as waiting after")).toBeNull();
    expect(screen.getByRole("switch", { name: "Draft nudges by themselves" }).getAttribute("aria-checked")).toBe("true");
  });

  /** Sol round 3 P2: the host prefixes every cause with "LifeOS did not answer"; the row says the true one. */
  it("says a signed-out LifeOS as signed out, never that it did not answer, and keeps did not answer for a wait", async () => {
    state.waiting = { days: null, routine: false, error: "LifeOS did not answer: This host is not signed in to LifeOS" };
    const first = render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByText("Not signed in to LifeOS on the box")).toBeTruthy();
    expect(screen.queryByText(/did not answer/)).toBeNull();
    first.unmount();
    state.waiting = { days: null, routine: false, error: "LifeOS did not answer: no answer in 15 s" };
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByText("LifeOS did not answer the box")).toBeTruthy();
  });

  /** Council round 7 (Sol, Settings 3): a signed-out host's days offered Retry, which reads the same missing session again. */
  it("says a signed-out host as a state with the rule's press, Sign in, never Retry, and keeps the switch usable", async () => {
    state.waiting = { days: null, routine: false, error: "LifeOS did not answer: This host is not signed in to LifeOS" };
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByText("Not signed in to LifeOS on the box")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Draft nudges by themselves" }));
    await settle();
    expect(calls.some((c) => c.method === "work.mail.setWaiting" && c.params.routine === true)).toBe(true);
  });

  it("gives the failed days' read its own Retry, and the switch stays usable while it is out", async () => {
    state.waiting = { days: null, routine: false, error: "LifeOS did not answer: LifeOS is unreachable" };
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    state.waiting = { days: 5, routine: false };
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("switch", { name: "Draft nudges by themselves" })).toBeTruthy();
    await settle();
    expect(calls.filter((c) => c.method === "work.mail.waiting")).toHaveLength(2);
    expect(screen.getByLabelText("Count as waiting after").textContent).toContain("5 working days");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  /** Council round 4 (Sol Settings 1): a Retry's late answer never puts the switch back from a newer save. */
  it.each(["the save first", "the read first"] as const)("keeps the switch he flipped while the days' Retry was out, %s", async (order) => {
    state.waiting = { days: null, routine: false, error: "LifeOS did not answer: LifeOS is unreachable" };
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    const gate = (method: string): (() => void) => {
      let open!: () => void;
      state.hold.set(method, new Promise<void>((r) => (open = r)));
      return open;
    };
    const read = gate("work.mail.waiting");
    const save = order === "the read first" ? gate("work.mail.setWaiting") : () => {};
    state.waiting = { ...state.waiting, days: 5, error: undefined } as MailWaiting;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    fireEvent.click(screen.getByRole("switch", { name: "Draft nudges by themselves" }));
    await settle();
    if (order === "the read first") {
      read();
      await settle();
      save();
    } else read();
    await settle();
    state.hold.clear();
    expect(screen.getByRole("switch", { name: "Draft nudges by themselves" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("Count as waiting after").textContent).toContain("5 working days");
    expect(state.waiting.routine).toBe(true);
  });

  /** Council round 5 (Sol Settings 1): a Retry the host did not answer took the known switch away with the days' row. */
  it("keeps the known switch when the days' Retry is not answered: the failure and Retry stay on the days' row", async () => {
    state.waiting = { days: null, routine: true, error: "LifeOS did not answer: LifeOS is unreachable" };
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    state.fail.add("work.mail.waiting");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByRole("switch", { name: "Draft nudges by themselves" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("The box did not answer")).toBeTruthy();
    expect(screen.queryByText("LifeOS did not answer")).toBeNull();
    // Said once, on the days' row, with its Retry there: once answered, the days come back.
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    state.fail.clear();
    state.waiting = { days: 5, routine: true };
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByLabelText("Count as waiting after").textContent).toContain("5 working days");
    expect(screen.queryByText("The box did not answer")).toBeNull();
  });

  /** Council round 6 (Opus P3): a Retry that timed out names the workspace's host, never "That computer". */
  it("names the workspace's host when the days' Retry times out", async () => {
    state.waiting = { days: null, routine: true, error: "LifeOS did not answer: LifeOS is unreachable" };
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    state.timeout.add("work.mail.waiting");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByText("The box did not answer")).toBeTruthy();
    expect(screen.queryByText(/That computer/)).toBeNull();
    state.timeout.clear();
  });

  it("lays an answer over what is shown half by half, by when its ask started", async () => {
    const { laidOver } = await import("./WaitingSection");
    const first = laidOver(null, 1, { days: null, routine: false, error: "x" }, { days: true, routine: true });
    const saved = laidOver(first, 3, { days: null, routine: true, error: "x" }, { days: false, routine: true });
    // The Retry's read, started 2nd, answers last: its days are taken, the saved routine stays.
    expect(laidOver(saved, 2, { days: 5, routine: false }, { days: true, routine: true }).value).toEqual({ days: 5, routine: true });
    // In the other order the save's answer, newer, takes the routine; the read's days stand.
    const readFirst = laidOver(first, 2, { days: 5, routine: false }, { days: true, routine: true });
    expect(laidOver(readFirst, 3, { days: 5, routine: true }, { days: false, routine: true }).value).toEqual({ days: 5, routine: true });
  });

  it("words every reason the host gives for a LifeOS it could not ask in the shared LifeOS line's words", async () => {
    const { UNAVAILABLE_WORDS } = await import("../../../../main/server/work/lifeos/session");
    for (const [name, words] of Object.entries(UNAVAILABLE_WORDS)) {
      const said = daysFailure(`LifeOS did not answer: ${words}`);
      expect(said, name).toBe(name === "connecting" ? "LifeOS is still connecting" : sessionFailure(name as never));
    }
  });

  it("is not drawn for a given computer's key, which may not change it, and asks nothing", async () => {
    testKey.current = GIVEN_KEY;
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    expect(screen.queryByText("Waiting on")).toBeNull();
    expect(calls).toEqual([]);
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
