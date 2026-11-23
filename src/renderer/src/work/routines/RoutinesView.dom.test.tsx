// @vitest-environment jsdom
/**
 * The Routines view: a failed read of a routine's runs is an error with
 * Retry, never "None yet"; a failed list offers Retry; an empty list is one
 * line, its New routine in the header alone; narrow, a pick opens the detail
 * and its Routines row goes back.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineRow } from "@shared/contract-work-routines";

const host: { list: () => Promise<unknown>; runs: () => Promise<unknown>; plays: () => Promise<unknown>; asked: string[] } = { list: async () => ({ routines: [] }), runs: async () => ({ runs: [] }), plays: async () => ({ plays: [] }), asked: [] };
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  useEnvironments: () => [{ id: "box", name: "The box", platform: "linux" }],
  registry: {
    linkOf: () => ({
      onPush: () => () => {},
      request: (method: string) => {
        host.asked.push(method);
        if (method === "work.outbox.rules") return Promise.resolve({ addons: [] });
        return method === "work.routines.list" ? host.list() : method === "work.routines.plays" ? host.plays() : host.runs();
      },
    }),
  },
}));

const { View } = await import("./RoutinesView");
const { routineJobOpenPort } = await import("./jobOpen");

const row = (over: Partial<RoutineRow> = {}): RoutineRow => ({
  id: "r1",
  workspaceId: "ws",
  projectId: null,
  kind: "routine",
  name: "Morning brief",
  prompt: "Read my mail and list what needs me.",
  model: null,
  reasoning: null,
  trigger: { on: "schedule", days: "weekdays", at: "07:00" },
  words: "Weekdays at 7:00 AM",
  ends: { kind: "never" },
  enabled: true,
  proposed: false,
  resumeSessionId: null,
  madeIn: null,
  nextAt: null,
  lastAt: null,
  lastState: null,
  lastWords: null,
  checkedAt: null,
  waiting: null,
  running: false,
  ended: false,
  createdBy: "owner",
  createdAt: 1,
  host: "box",
  ...over,
}) as RoutineRow;

const props = { env: "box", workspace: { id: "ws", environmentId: "box" }, sector: "purdue", lifeos: {}, startThread: () => {} } as never;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  host.asked.length = 0;
  host.list = async () => ({ routines: [row()] });
  host.runs = async () => ({ runs: [] });
  host.plays = async () => ({ plays: [] });
});
afterEach(cleanup);

describe("the Routines view", () => {
  it("keeps a failed read of the runs apart from a routine that never ran, with Retry", async () => {
    host.runs = () => Promise.reject(new Error("The host did not answer"));
    render(<View {...props} />);
    await settle();
    expect(screen.queryByText("None yet")).toBeNull();
    expect(screen.getByText("The host did not answer")).toBeTruthy();
    host.runs = async () => ({ runs: [] });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(host.asked.filter((m) => m === "work.routines.runs")).toHaveLength(2);
    expect(screen.getByText("None yet")).toBeTruthy();
  });

  it("offers Retry when the list does not load", async () => {
    host.list = () => Promise.reject(new Error("Work is off on this host"));
    render(<View {...props} />);
    await settle();
    expect(screen.getByText("Routines did not load")).toBeTruthy();
    host.list = async () => ({ routines: [row()] });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Morning brief");
  });

  it("says an empty list in one line, leaving New routine to the header", async () => {
    host.list = async () => ({ routines: [] });
    render(<View {...props} />);
    await settle();
    expect(screen.getByText("No routines yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New routine" })).toBeNull();
  });

  it("narrow, shows the list until a pick, then the detail with a way back", async () => {
    render(<View {...props} />);
    await settle();
    const list = document.querySelector("[data-routine-list]") as HTMLElement;
    const detail = document.querySelector("[data-routine-detail]") as HTMLElement;
    expect(list.className).not.toContain("@max-[40rem]/routines:hidden");
    expect(detail.className).toContain("@max-[40rem]/routines:hidden");
    // A plain list of buttons, the picked one current: no listbox that answers no arrow keys.
    expect(screen.queryByRole("listbox")).toBeNull();
    const pick = screen.getByRole("button", { name: /Morning brief/ });
    expect(pick.getAttribute("aria-current")).toBe("true");
    expect(pick.closest("li")).toBeTruthy();
    fireEvent.click(pick);
    expect(list.className).toContain("@max-[40rem]/routines:hidden");
    expect((document.querySelector("[data-routine-detail]") as HTMLElement).className).not.toContain("@max-[40rem]/routines:hidden");
    fireEvent.click(screen.getByRole("button", { name: "Routines" }));
    expect(list.className).not.toContain("@max-[40rem]/routines:hidden");
  });

  it("names the play a routine runs, and shows no empty words of its own", async () => {
    host.list = async () => ({ routines: [row({ prompt: "", playId: "p1" })] });
    host.plays = async () => ({ plays: [{ id: "p1", name: "Weekly pay check", takes: [], proposed: false }] });
    render(<View {...props} />);
    await settle();
    const detail = document.querySelector("[data-routine-detail]") as HTMLElement;
    expect(detail.querySelector("dt")?.textContent).toBe("Runs");
    expect(detail.querySelector("dd")?.textContent).toBe("Weekly pay check");
    expect(detail.querySelector("p.whitespace-pre-wrap")).toBeNull();
  });

  describe("a routine that runs a host job", () => {
    const job = () => row({ name: "Week review", prompt: "", job: "review.make", jobName: "Makes the week's review", model: "opus", words: "Fridays at 4:00 PM", trigger: { on: "schedule", rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0", tz: "UTC" } });

    it("says what its job does, draws no Model, and its form asks only when", async () => {
      host.list = async () => ({ routines: [job()] });
      render(<View {...props} />);
      await settle();
      const detail = document.querySelector("[data-routine-detail]") as HTMLElement;
      expect(detail.textContent).toContain("Makes the week's review");
      expect([...detail.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Starts", "Runs on"]);
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      await settle();
      expect(screen.getByLabelText("Name")).toBeTruthy();
      expect(screen.queryByText("What to do")).toBeNull();
      expect(screen.queryByText("Model")).toBeNull();
      expect(screen.getAllByText("Starts").length).toBeGreaterThan(0);
    });

    it("a run with a page to open calls the port; with no port set, or nothing to open, it is plain text", async () => {
      host.list = async () => ({ routines: [job()] });
      host.runs = async () => ({
        runs: [
          { id: "x1", routineId: "r1", sessionId: null, firedAt: 2, cause: "Run now", folded: 0, state: "quiet", summary: "Review made", open: { place: "review", at: 5 } },
          { id: "x2", routineId: "r1", sessionId: null, firedAt: 1, cause: "Run now", folded: 0, state: "failed", summary: "Failed: its job is not on this host" },
        ],
      });
      const opened: unknown[] = [];
      const off = routineJobOpenPort.set((o) => void opened.push(o));
      render(<View {...props} />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: /Review made/ }));
      expect(opened).toEqual([{ place: "review", at: 5 }]);
      expect(screen.queryByRole("button", { name: /its job is not on this host/ })).toBeNull();
      expect(screen.getByText("Failed: its job is not on this host")).toBeTruthy();
      off();
      cleanup();
      render(<View {...props} />);
      await settle();
      expect(screen.queryByRole("button", { name: /Review made/ })).toBeNull();
      expect(screen.getByText("Review made")).toBeTruthy();
    });
  });
});
