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

const host: { list: () => Promise<unknown>; runs: () => Promise<unknown>; plays: () => Promise<unknown>; forms: () => Promise<unknown>; asked: string[] } = { list: async () => ({ routines: [] }), runs: async () => ({ runs: [] }), plays: async () => ({ plays: [] }), forms: async () => ({ forms: [], offered: true }), asked: [] };
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  useEnvironments: () => [{ id: "box", name: "The box", platform: "linux" }],
  registry: {
    environment: (id: string) => (id === "box" ? { id, name: "The box" } : undefined),
    linkOf: () => ({
      onPush: () => () => {},
      request: (method: string) => {
        host.asked.push(method);
        if (method === "work.outbox.rules") return Promise.resolve({ addons: [] });
        if (method === "work.msforms.list") return host.forms();
        return method === "work.routines.list" ? host.list() : method === "work.routines.plays" ? host.plays() : host.runs();
      },
    }),
  },
}));

vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));
const { GIVEN_KEY, resetTestKey, testKey } = await import("../../lib/linkMay.testkit");
const { Head, View } = await import("./RoutinesView");
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
  host.forms = async () => ({ forms: [], offered: true });
});
afterEach(() => {
  cleanup();
  resetTestKey();
});

describe("the Routines view", () => {
  /** Council round 10, the walk: "waiting on LifeOS" named no computer and offered no press while its LifeOS was down. */
  it("says a routine that waits on its host's LifeOS by the rule, the computer named, from the live status", async () => {
    const { resetLifeos, setLifeosStatus } = await import("../shell/lifeos");
    setLifeosStatus("box", { lifeos: { state: "signed-out" }, keys: [] });
    host.list = async () => ({ routines: [row({ trigger: { on: "mail" } as never, words: "When a mail arrives", waiting: "Waiting on LifeOS" })] });
    render(<View {...props} />);
    await settle();
    const starts = document.querySelector("[data-routine-detail] dl")!;
    expect(starts.textContent).toContain("When a mail arrives");
    expect(starts.textContent).toContain("Not signed in to LifeOS on the box");
    expect(starts.textContent).not.toContain("waiting on LifeOS");
    // Council round 11, the walk: on its way, the one wait with the computer named and no press.
    act(() => setLifeosStatus("box", { lifeos: { state: "connecting" }, keys: [] }));
    expect(starts.textContent).toContain("LifeOS is still connecting on the box");
    expect(starts.textContent).not.toContain("waiting on LifeOS");
    expect(starts.textContent).not.toContain("Not signed in");
    expect(starts.querySelector("[data-lifeos-waits] button")).toBeNull();
    act(() => setLifeosStatus("box", { lifeos: { state: "connected" }, keys: [] }));
    expect(starts.textContent).not.toContain("LifeOS is still connecting");
    resetLifeos();
  });

  it("keeps a failed read of the runs apart from a routine that never ran, with Retry", async () => {
    host.runs = () => Promise.reject(new Error("The host did not answer"));
    render(<View {...props} />);
    await settle();
    expect(screen.queryByText("None yet")).toBeNull();
    // The stand-in names the computer asked (workErrorWords), never "the host".
    expect(screen.getByText(/^The .+ did not answer\. Try again once it is connected\.$/)).toBeTruthy();
    // Council round 12 (the walk): Retry spins in place, the failure kept, until the runs answer; never a bone first.
    let answer!: () => void;
    host.runs = () => new Promise((r) => (answer = () => r({ runs: [] })));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(host.asked.filter((m) => m === "work.routines.runs")).toHaveLength(2);
    expect(screen.getByText(/did not answer\. Try again once it is connected\.$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" }).querySelector("[data-busy]")).not.toBeNull();
    await act(async () => answer());
    expect(screen.getByText("None yet")).toBeTruthy();
  });

  it("offers a given computer's key Pause and Run now, and no New, Edit or a proposal's presses: the proposal says who can", async () => {
    render(<Head {...(props as object as Parameters<typeof Head>[0])} />);
    expect(screen.getByRole("button", { name: "New routine" })).toBeTruthy();
    cleanup();
    testKey.current = GIVEN_KEY;
    render(<Head {...(props as object as Parameters<typeof Head>[0])} />);
    expect(screen.queryByRole("button", { name: "New routine" })).toBeNull();
    render(<View {...props} />);
    await settle();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy();
    cleanup();
    host.list = async () => ({ routines: [row({ proposed: true })] });
    render(<View {...props} />);
    await settle();
    expect(screen.queryByRole("button", { name: "Add…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.getByText("Changed from a computer that manages the box")).toBeTruthy();
    expect(host.asked.filter((m) => m === "work.routines.save" || m === "work.routines.remove")).toEqual([]);
  });

  it("offers Retry when the list does not load", async () => {
    host.list = () => Promise.reject(new Error("Work is off on this host"));
    render(<View {...props} />);
    await settle();
    expect(screen.getByText("Routines did not load")).toBeTruthy();
    // Council round 12 (the walk): Retry spins in place, the failure kept, until the list answers; never bones first.
    let answer!: () => void;
    host.list = () => new Promise((r) => (answer = () => r({ routines: [row()] })));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByText("Routines did not load")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Retry" }).querySelector("[data-busy]")).not.toBeNull();
    await act(async () => answer());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Morning brief");
  });

  it("says a list that did not come in his words, naming the computer, never the link's own text", async () => {
    host.list = () => Promise.reject(new Error("work.routines.list failed: ECONNRESET at /srv/x"));
    render(<View {...props} />);
    await settle();
    expect(screen.getByText("Routines did not load")).toBeTruthy();
    expect(screen.getByText("The box did not answer. Try again once it is connected.")).toBeTruthy();
    cleanup();
    host.list = () => Promise.reject(new Error("work.routines.list: bad row at /srv/agents/x.json"));
    render(<View {...props} />);
    await settle();
    expect(screen.getByText("The box could not list the routines.")).toBeTruthy();
  });

  it("says why Run now is off while its last run's thread waits to wake", async () => {
    const { tooltipChunk, warmTooltips } = await import("../../components/ui/tooltip");
    await act(async () => {
      await tooltipChunk.load();
      warmTooltips();
    });
    host.list = async () => ({ routines: [row({ resumeSessionId: "s1", madeIn: "s1" })] });
    render(<View {...props} />);
    await settle();
    expect((screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(true);
    const at = document.querySelector<HTMLElement>("[data-run-now]")!;
    await act(async () => {
      at.focus();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe("Waits for its last run's thread");
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

    it("a run with a page to open calls the port; with no port it opens a page above the workspaces of that name, and with nothing to open it is plain text", async () => {
      host.list = async () => ({ routines: [job()] });
      host.runs = async () => ({
        runs: [
          { id: "x1", routineId: "r1", sessionId: null, firedAt: 2, cause: "Run now", folded: 0, state: "quiet", summary: "Review made", open: { place: "review", at: 5 } },
          { id: "x2", routineId: "r1", sessionId: null, firedAt: 1, cause: "Run now", folded: 0, state: "failed", summary: "Failed: its job is not on this host" },
          { id: "x3", routineId: "r1", sessionId: null, firedAt: 0, cause: "Run now", folded: 0, state: "quiet", summary: "Made elsewhere", open: { place: "no-such-page" } },
        ],
      });
      const opened: unknown[] = [];
      const off = routineJobOpenPort.set((o) => void opened.push(o));
      render(<View {...props} />);
      await settle();
      // A run that opens something answers the pointer as every row that opens its thing does.
      expect(screen.getByRole("button", { name: /Review made/ }).className).toContain("hover:bg-foreground/5");
      fireEvent.click(screen.getByRole("button", { name: /Review made/ }));
      expect(opened).toEqual([{ place: "review", at: 5 }]);
      expect(screen.queryByRole("button", { name: /its job is not on this host/ })).toBeNull();
      expect(screen.getByText("Its job is not on this host")).toBeTruthy();
      off();
      cleanup();
      render(<View {...props} />);
      await settle();
      // No port: Review is a page above the workspaces, so its run opens it there, at the week it names.
      const { shellStore, initialShellState } = await import("../../stores/shell");
      fireEvent.click(screen.getByRole("button", { name: /Review made/ }));
      expect(shellStore.getState().workPlace).toBe("review");
      shellStore.setState(initialShellState());
      // A page nobody knows is not a button.
      expect(screen.queryByRole("button", { name: /Made elsewhere/ })).toBeNull();
      expect(screen.getByText("Made elsewhere")).toBeTruthy();
    });
  });

  describe("on a Microsoft form's answers", () => {
    const onForm = () =>
      row({ name: "Sign-ups", prompt: "", job: "msforms.tasks", jobName: "Files a task for each new answer", words: "When someone answers Sign-up", trigger: { on: "file", source: { at: "msform", workspaceId: "ws", formId: "F1" }, by: "someone-else" } });

    it("names the form in the File picker and the job in Runs, and asks for no words", async () => {
      host.list = async () => ({ routines: [onForm()] });
      host.forms = async () => ({ forms: [{ formId: "F1", title: "Sign-up" }, { formId: "F2", title: "Feedback" }], offered: true });
      render(<View {...props} />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      await settle();
      expect(host.asked).toContain("work.msforms.list");
      expect(screen.getByText("When someone answers it")).toBeTruthy();
      expect(screen.getAllByText("Sign-up").length).toBeGreaterThan(0);
      expect(screen.getAllByText("File a task for each answer").length).toBeGreaterThan(0);
      expect(screen.queryByText("What to do")).toBeNull();
      // no path while a form is picked
      expect(screen.queryByPlaceholderText("/Users/…/Travel budget.xlsx")).toBeNull();
    });

    it("keeps the File field a path where the job has no forms", async () => {
      host.list = async () => ({ routines: [row({ trigger: { on: "file", source: { at: "file", host: "box", path: "/w/a.xlsx" }, by: "someone-else" }, words: "When someone else changes it" })] });
      render(<View {...props} />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      await settle();
      expect((screen.getByPlaceholderText("/Users/…/Travel budget.xlsx") as HTMLInputElement).value).toBe("/w/a.xlsx");
      expect(screen.queryByText("A file by its path")).toBeNull();
      expect(screen.queryByText("File a task for each answer")).toBeNull();
    });
  });
});
