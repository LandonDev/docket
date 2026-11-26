// @vitest-environment jsdom
/**
 * The tracker (docs/agents/work-tracker.md "The page"): a group a job with its projects as work-kit's rows, by
 * target date; one header row for the page; the Waiting on you filter; a down job, an empty job, the bones; the
 * Threads column's held mail; a row opening its project's page in its job and a Threads cell opening its thread.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openWorkView, workOpenPort, workViewNow } from "../../lib/workSwitch";
import type { MergedJob } from "./data";
import { JOBS, NOW } from "./TrackerPage.preview.fixtures";

// The window's own LifeOS session for a down job, faked at its one seam.
const lifeos = vi.hoisted(() => ({ state: "connecting" as string }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosSession: (environmentId: string, sector: string) => ({ environmentId, sector, client: null, state: lifeos.state }),
}));
vi.mock("../shell/DownLine", () => ({ DownLine: ({ session }: { session: { state: string } }) => <p data-downline={session.state} /> }));

const { Head, TrackerBody, resetTrackerFolds, restWords, setWaitingOnly, threadTip, useWaitingOnly } = await import("./TrackerPage");
const { placeOf, resetPlaces } = await import("../projects/place");

const body = (over: Partial<Parameters<typeof TrackerBody>[0]> = {}) => <TrackerBody jobs={JOBS} loading={false} errors={[]} waitingOnly={false} now={NOW} onRetry={() => {}} {...over} />;
const rowsOf = (job: string): string[] => [...document.querySelectorAll(`[data-job='${job}'] [data-project]`)].map((row) => row.getAttribute("data-project")!);

beforeEach(() => {
  lifeos.state = "connecting";
  openWorkView(null);
  resetPlaces();
  resetTrackerFolds();
});
afterEach(() => {
  cleanup();
  setWaitingOnly(false);
  workOpenPort.set(null);
});

describe("the tracker", () => {
  it("draws a group a job, its name and dot over its rows, with one header row for the whole page", () => {
    render(body());
    const groups = [...document.querySelectorAll("section[data-job]")];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Purdue Esports", "Hypixel", "Cosmic", "Referee", "Unify"]);
    expect(groups[0]!.querySelector("[data-sector=purdue]")).toBeTruthy();
    expect(document.querySelectorAll("[data-part=track-head]")).toHaveLength(1);
    expect(document.querySelector("[data-part=track-head]")!.textContent).toBe("NextWaiting onThreadsDoneTarget");
  });

  it("lists active projects by target date, paused and backlog folded under one line a job", () => {
    render(body());
    // FY27 budget's target (Dec 12) comes before Spring LAN's (Feb 14).
    expect(rowsOf("purdue")).toEqual(["p-budget", "p-lan"]);
    fireEvent.click(screen.getByRole("button", { name: "1 paused" }));
    expect(rowsOf("purdue")).toEqual(["p-budget", "p-lan", "p-lights"]);
    expect(restWords([{ state: "paused" }, { state: "backlog" }, { state: "backlog" }])).toBe("1 paused, 2 in backlog");
  });

  it("a held thread reads 1 mail to send in the Threads column, muted with the Outbox's glyph, and its press opens the thread", () => {
    const opened: string[] = [];
    workOpenPort.set((id) => void opened.push(id));
    render(body());
    const cell = document.querySelector("[data-project='p-lan'] [data-part=threads]") as HTMLElement;
    expect(cell.textContent).toBe("1 mail to send");
    expect(cell.querySelector("[data-outcome=held]")).toBeTruthy();
    fireEvent.click(within(cell).getByRole("button", { name: "1 mail to send" }));
    expect(opened).toEqual(["t-itap"]);
    // The thread's press, not the row's: no project page opened.
    expect(workViewNow()).toBeNull();
    // A question is amber; a project with no thread leaves its cell empty.
    expect(document.querySelector("[data-project='p-trailer'] [data-part=threads]")!.textContent).toBe("Asks you");
    expect(document.querySelector("[data-project='p-season'] [data-part=threads]")).toBeNull();
    // The tip carries what a narrow cell cuts short: the thread and what it left him.
    expect(threadTip({ title: "Ask ITaP for two switches", outcome: { words: "1 mail to send", tone: "held" } })).toBe("Ask ITaP for two switches: 1 mail to send");
  });

  it("a row opens its project's page in its job's Projects view", () => {
    render(body());
    fireEvent.click(screen.getByRole("button", { name: "Spring LAN" }));
    expect(workViewNow()).toMatchObject({ workspaceId: "ws-purdue", view: "projects", project: "p-lan" });
  });

  it("Waiting on you keeps the rows with a held act, a question, a failure, a late task or one due today, and the jobs that have one", () => {
    render(body({ waitingOnly: true }));
    expect(rowsOf("purdue")).toEqual(["p-budget", "p-lan"]);
    expect(rowsOf("hypixel")).toEqual(["p-trailer"]);
    // Cosmic waits on no one, the empty Referee has nothing: both go. Unify could not be read and stays.
    expect([...document.querySelectorAll("section[data-job]")].map((g) => g.getAttribute("data-job"))).toEqual(["purdue", "hypixel", "unify"]);
    cleanup();
    render(body({ waitingOnly: true, jobs: JOBS.slice(2, 4) }));
    expect(screen.getByText("Nothing waits on you")).toBeTruthy();
  });

  it("under Waiting on you, a row matched by a late or due waiting task says its count where Next stands; one its facts explain is unchanged", () => {
    const project = (id: string, over: Partial<MergedJob["projects"][number]>): MergedJob["projects"][number] => ({
      id, name: id, state: "active", targetDate: null, next: null, late: 0, dueToday: 0, waiting: null, done: 0, total: 0, mirrorId: null, threads: 0, lead: null, leadHost: null, ...over,
    });
    const jobs: MergedJob[] = [{
      sector: "purdue", name: "Purdue", at: { environmentId: "box", workspaceId: "w" },
      projects: [
        project("p-wait", { late: 1, waiting: { taskId: "t", name: "Sam Ortiz", since: NOW - 86_400_000 }, next: { taskId: "n", key: "P-1", title: "Book the bus" } }),
        project("p-late", { late: 1, next: { taskId: "n2", key: "P-2", title: "Order shirts", due: NOW - 3_600_000 } }),
      ],
    }];
    render(body({ waitingOnly: true, jobs }));
    const next = (id: string) => document.querySelector(`[data-project='${id}'] [data-part=next] .truncate`)?.textContent;
    expect(next("p-wait")).toBe("1 task late");
    expect(next("p-late")).toContain("Order shirts");
    cleanup();
    // Off the filter, Next is LifeOS's own.
    render(body({ jobs }));
    expect(next("p-wait")).toBe("Book the bus");
  });

  it("says no all-clear while a host is missing: its line stands alone, under the filter and with no jobs", () => {
    render(body({ waitingOnly: true, jobs: JOBS.slice(2, 4), errors: ["The box is connecting."] }));
    expect(document.querySelector("[data-host-silent]")!.textContent).toBe("The box is connecting.");
    expect(screen.queryByText("Nothing waits on you")).toBeNull();
    cleanup();
    render(body({ jobs: [], errors: ["The box is not connected."] }));
    expect(screen.queryByText("No jobs yet")).toBeNull();
  });

  it("the header's toggle is the filter, kept for the window", () => {
    const Probe = () => <span data-on={String(useWaitingOnly())} />;
    render(
      <>
        <Head onClose={() => {}} />
        <Probe />
      </>,
    );
    const toggle = screen.getByRole("button", { name: "Waiting on you" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    // At rest it wears the toggle's hairline, so it reads as a press, not a label.
    expect(toggle.getAttribute("data-variant")).toBe("outline");
    fireEvent.click(toggle);
    expect(document.querySelector("[data-on]")!.getAttribute("data-on")).toBe("true");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("an empty job says its name and New project alone, which opens the job's New project dialog", () => {
    render(body());
    const referee = document.querySelector("[data-job=ref]") as HTMLElement;
    expect(referee.textContent).toBe("RefereeNew project");
    fireEvent.click(within(referee).getByRole("button", { name: "New project" }));
    expect(placeOf("ws-ref").at).toBe("new");
    expect(workViewNow()).toMatchObject({ workspaceId: "ws-ref", view: "projects" });
  });

  it("a job LifeOS could not be read for says so: the window's session line where it is down, else the host's words with Retry", () => {
    const onRetry = vi.fn();
    render(body({ onRetry }));
    const unify = document.querySelector("[data-job=unify]") as HTMLElement;
    expect(unify.querySelector("[data-job-down]")!.textContent).toContain("LifeOS did not answer the box.");
    fireEvent.click(within(unify).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    cleanup();
    lifeos.state = "signed-out";
    render(body());
    expect(document.querySelector("[data-job=unify] [data-downline]")!.getAttribute("data-downline")).toBe("signed-out");
  });

  /** Council round 1, sitting E (R1-E19): Retry stayed ready while the hosts were asked again. */
  it("spins a down job's Retry until the hosts answer again", async () => {
    let answer = (): void => {};
    const onRetry = vi.fn(() => new Promise<void>((done) => (answer = done)));
    render(body({ onRetry }));
    const unify = document.querySelector("[data-job=unify]") as HTMLElement;
    const retry = within(unify).getByRole<HTMLButtonElement>("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute("aria-busy") ?? retry.querySelector("[aria-busy], [role=status], svg")).toBeTruthy();
    await act(async () => answer());
    expect(retry.disabled).toBe(false);
  });

  it("a host that did not answer is one quiet line; the rest of the page stands", () => {
    render(body({ errors: ["The Mac did not answer."] }));
    expect(document.querySelector("[data-host-silent]")!.textContent).toBe("The Mac did not answer.");
    expect(rowsOf("purdue")).toEqual(["p-budget", "p-lan"]);
  });

  it("draws bones in the rows' shape while the hosts are asked", () => {
    vi.useFakeTimers();
    try {
      render(body({ loading: true, jobs: [] as MergedJob[] }));
      act(() => void vi.advanceTimersByTime(200));
      const held = document.querySelector("[aria-busy=true]") as HTMLElement;
      expect(held.querySelectorAll(".pk-track-row")).toHaveLength(6);
      expect(document.querySelector("section[data-job]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the all-clear", () => {
  it("waits while a host has not answered", () => {
    render(<TrackerBody jobs={[]} loading={false} errors={[]} pending waitingOnly onRetry={() => {}} now={NOW} />);
    expect(screen.queryByText("Nothing waits on you")).toBeNull();
    cleanup();
    render(<TrackerBody jobs={[]} loading={false} errors={[]} waitingOnly onRetry={() => {}} now={NOW} />);
    expect(screen.getByText("Nothing waits on you")).toBeTruthy();
  });

  it("draws bones, not a blank page, while a pending host leaves the list empty", () => {
    vi.useFakeTimers();
    try {
      render(<TrackerBody jobs={[]} loading={false} errors={[]} pending waitingOnly onRetry={() => {}} now={NOW} />);
      act(() => void vi.advanceTimersByTime(200));
      expect(document.querySelector("[aria-busy=true]")!.querySelectorAll(".pk-track-row").length).toBeGreaterThan(0);
      expect(screen.queryByText("Nothing waits on you")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
