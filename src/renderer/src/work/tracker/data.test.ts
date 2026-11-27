// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrackerJob, TrackerProject } from "@shared/work/tracker";
import { registry } from "../../lib/connection";
import { act, renderHook, waitFor } from "@testing-library/react";
import { workSwitch } from "../../lib/workSwitch";
import { askHosts, closedWords, downWords, mergeOverviews, reconcileKept, resetTracker, useTracker } from "./data";

/** The window's merge: one job a sector, LifeOS's rows from the first host that read them, threads added up across hosts. */
const project = (id: string, over: Partial<TrackerProject> = {}): TrackerProject => ({
  id, name: id, state: "active", targetDate: null, next: null, late: 0, dueToday: 0, waiting: null, done: 0, total: 0, mirrorId: null, threads: 0, lead: null, ...over,
});
const job = (workspaceId: string, sector: string, projects: TrackerProject[], down?: string): TrackerJob => ({ workspaceId, name: `Job ${sector}`, sector, projects, ...(down ? { down } : {}) });
const held = { sessionId: "t-held", title: "Mail Sam", updatedAt: 5, outcome: { words: "1 mail to send", tone: "held" as const } };
const asks = { sessionId: "t-asks", title: "Seats", updatedAt: 1, outcome: { words: "Asks you", tone: "asks" as const } };

describe("merging the hosts' trackers", () => {
  it("one job a sector; a project's threads add up and the most pressing lead wins, with the host it lives on", () => {
    const jobs = mergeOverviews([
      { environmentId: "box", error: null, overview: { jobs: [job("b-purdue", "purdue", [project("lan", { threads: 1, lead: held, targetDate: 9 }), project("gear")])] } },
      { environmentId: "mac", error: null, overview: { jobs: [job("m-purdue", "purdue", [project("lan", { threads: 2, lead: asks, targetDate: 9 }), project("gear")]), job("m-ref", "ref", [project("games")])] } },
    ]);
    expect(jobs.map((j) => j.sector)).toEqual(["purdue", "ref"]);
    const lan = jobs[0]!.projects.find((p) => p.id === "lan")!;
    expect([lan.threads, lan.lead?.sessionId, lan.leadHost]).toEqual([3, "t-asks", "mac"]);
    expect(jobs[0]!.at).toEqual({ environmentId: "box", workspaceId: "b-purdue" });
    // By target, no target last.
    expect(jobs[0]!.projects.map((p) => p.id)).toEqual(["lan", "gear"]);
  });

  it("a job one host could not read stands on the host that could; a job none could read says why", () => {
    const jobs = mergeOverviews([
      { environmentId: "box", error: null, overview: { jobs: [job("b-purdue", "purdue", [], "LifeOS did not answer"), job("b-ref", "ref", [], "LifeOS did not answer")] } },
      { environmentId: "mac", error: null, overview: { jobs: [job("m-purdue", "purdue", [project("lan")])] } },
      { environmentId: "pc", error: "The PC did not answer.", overview: null },
    ]);
    expect(jobs[0]).toMatchObject({ sector: "purdue", at: { environmentId: "mac", workspaceId: "m-purdue" } });
    expect(jobs[0]!.down).toBeUndefined();
    expect(jobs[0]!.projects.map((p) => p.id)).toEqual(["lan"]);
    expect(jobs[1]).toMatchObject({ sector: "ref", projects: [], down: "LifeOS did not answer" });
  });
});

describe("asking the hosts", () => {
  afterEach(() => void vi.restoreAllMocks());
  const names: Record<string, string> = { box: "The box", mac: "This Mac", pc: "Office PC" };
  const linkState: Record<string, string> = { box: "open", mac: "connecting", pc: "offline" };
  const rigged = () => {
    vi.spyOn(registry, "environment").mockImplementation((id) => ({ id, name: names[id] }) as never);
    vi.spyOn(registry, "statusOf").mockImplementation((id) => ({ transport: linkState[id] }) as never);
  };

  it("every host with Work on answers: an open link is asked, one not open past its grace says it is connecting or not connected", async () => {
    rigged();
    const ask = vi.fn(async () => ({ jobs: [job("b-purdue", "purdue", [project("lan")])] }));
    const got = await askHosts(ask, ["box", "mac", "pc"], () => false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(got.map((a) => [a.environmentId, a.error, a.overview?.jobs.length ?? null])).toEqual([
      ["box", null, 1],
      ["mac", "This Mac is connecting.", null],
      ["pc", "Office PC is not connected.", null],
    ]);
    expect(closedWords("the box", "unauthorized")).toBe("The box is not connected.");
  });

  it("a link inside its grace (a cold window's first connect, a drop under 1.5 s old) is pending, never down", async () => {
    rigged();
    const ask = vi.fn(async () => ({ jobs: [] }));
    const got = await askHosts(ask, ["box", "mac", "pc"], (id) => id === "pc");
    expect(got.find((a) => a.environmentId === "pc")).toEqual({ environmentId: "pc", overview: null, error: null });
    expect(got.find((a) => a.environmentId === "mac")?.error).toBe("This Mac is connecting.");
    expect(reconcileKept([{ environmentId: "pc", overview: { jobs: [] }, error: null }], ["pc"], () => "connecting", () => true)).toEqual([{ environmentId: "pc", overview: { jobs: [] }, error: null }]);
  });

  it("keeps the last answer for the window: a second visit draws it at once while the hosts are asked again", async () => {
    rigged();
    resetTracker();
    vi.spyOn(workSwitch, "hosts").mockReturnValue(new Set(["box"]));
    const request = vi.fn(async () => ({ jobs: [job("b-purdue", "purdue", [project("lan")])] }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    const first = renderHook(() => useTracker());
    expect(first.result.current.loading).toBe(true);
    await waitFor(() => expect(first.result.current.jobs.map((j) => j.sector)).toEqual(["purdue"]));
    first.unmount();
    const second = renderHook(() => useTracker());
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.jobs.map((j) => j.sector)).toEqual(["purdue"]);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    second.unmount();
    resetTracker();
  });

  it("a link that drops says so at once, keeping the other hosts' groups, and the hosts are asked again", async () => {
    rigged();
    resetTracker();
    const state: Record<string, string> = { box: "open", mac: "open" };
    vi.spyOn(registry, "statusOf").mockImplementation((id) => ({ transport: state[id] }) as never);
    vi.spyOn(workSwitch, "hosts").mockReturnValue(new Set(["box", "mac"]));
    let hear = (): void => {};
    vi.spyOn(registry, "subscribe").mockImplementation((fn) => ((hear = fn as () => void), () => {}));
    const pending: ((v: unknown) => void)[] = [];
    vi.spyOn(registry, "linkOf").mockImplementation(
      (env) =>
        ({
          request: () =>
            env === "box" ? Promise.resolve({ jobs: [job("b-purdue", "purdue", [project("lan")])] }) : new Promise((resolve) => void pending.push(resolve)),
        }) as never,
    );
    const view = renderHook(() => useTracker());
    pending.shift()!({ jobs: [job("m-ref", "ref", [project("games")])] });
    await waitFor(() => expect(view.result.current.jobs.map((j) => j.sector)).toEqual(["purdue", "ref"]));
    state.mac = "offline";
    act(() => hear());
    // At once, with no answer yet: the Mac's line, the box's group stands.
    expect(view.result.current.errors).toEqual(["This Mac is not connected."]);
    expect(view.result.current.jobs.map((j) => j.sector)).toEqual(["purdue"]);
    view.unmount();
    resetTracker();
  });

  it("a host that joins Work while the page is open holds the all-clear as pending until it answers; one that leaves goes", async () => {
    rigged();
    resetTracker();
    vi.spyOn(registry, "statusOf").mockImplementation(() => ({ transport: "open" }) as never);
    let hosts = new Set(["box"]);
    vi.spyOn(workSwitch, "hosts").mockImplementation(() => hosts);
    let hear = (): void => {};
    vi.spyOn(workSwitch, "subscribe").mockImplementation((fn) => ((hear = fn as () => void), () => {}));
    const pending: ((v: unknown) => void)[] = [];
    vi.spyOn(registry, "linkOf").mockImplementation((env) => ({ request: () => (env === "box" ? Promise.resolve({ jobs: [] }) : new Promise((resolve) => void pending.push(resolve))) }) as never);
    const view = renderHook(() => useTracker());
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.pending).toBe(false);
    hosts = new Set(["box", "mac"]);
    act(() => hear());
    // At once: the Mac is pending, so no all-clear stands.
    expect(view.result.current.pending).toBe(true);
    await act(async () => pending.shift()!({ jobs: [job("m-ref", "ref", [project("games")])] }));
    await waitFor(() => expect(view.result.current.jobs.map((j) => j.sector)).toEqual(["ref"]));
    expect(view.result.current.pending).toBe(false);
    hosts = new Set(["box"]);
    act(() => hear());
    expect(view.result.current.jobs).toEqual([]);
    view.unmount();
    resetTracker();
  });

  it("a host whose link opens again is pending and asked at once, never left on its offline line", async () => {
    rigged();
    resetTracker();
    const state: Record<string, string> = { box: "open", mac: "offline" };
    vi.spyOn(registry, "statusOf").mockImplementation((id) => ({ transport: state[id] }) as never);
    vi.spyOn(workSwitch, "hosts").mockReturnValue(new Set(["box", "mac"]));
    let hear = (): void => {};
    vi.spyOn(registry, "subscribe").mockImplementation((fn) => ((hear = fn as () => void), () => {}));
    const asked: string[] = [];
    vi.spyOn(registry, "linkOf").mockImplementation((env) => ({ request: () => (asked.push(env), Promise.resolve({ jobs: env === "mac" ? [job("m-ref", "ref", [project("games")])] : [] })) }) as never);
    const view = renderHook(() => useTracker());
    await waitFor(() => expect(view.result.current.errors).toEqual(["This Mac is not connected."]));
    state.mac = "open";
    act(() => hear());
    // At once: the Mac's offline line goes and it is pending; then its answer lands.
    expect(view.result.current.errors).toEqual([]);
    expect(view.result.current.pending).toBe(true);
    await waitFor(() => expect(view.result.current.jobs.map((j) => j.sector)).toEqual(["ref"]));
    expect(asked.filter((id) => id === "mac").length).toBeGreaterThan(0);
    view.unmount();
    resetTracker();
  });

  it("a host that joins Work during the first read is asked too: the first read's roster never stands as an all-clear", async () => {
    rigged();
    resetTracker();
    vi.spyOn(registry, "statusOf").mockImplementation(() => ({ transport: "open" }) as never);
    let hosts = new Set(["box"]);
    vi.spyOn(workSwitch, "hosts").mockImplementation(() => hosts);
    let hear = (): void => {};
    vi.spyOn(workSwitch, "subscribe").mockImplementation((fn) => ((hear = fn as () => void), () => {}));
    const slow: ((v: unknown) => void)[] = [];
    vi.spyOn(registry, "linkOf").mockImplementation((env) => ({ request: () => (env === "box" ? new Promise((resolve) => void slow.push(resolve)) : new Promise(() => {})) }) as never);
    const view = renderHook(() => useTracker());
    hosts = new Set(["box", "mac"]);
    act(() => hear());
    // The first read answers late: it is dropped; the roster holds the Mac pending.
    await act(async () => slow.shift()!({ jobs: [] }));
    expect(view.result.current.pending).toBe(true);
    view.unmount();
    resetTracker();
  });

  it("only the newest read lands: an older read that answers late never replaces it", async () => {
    rigged();
    resetTracker();
    vi.spyOn(workSwitch, "hosts").mockReturnValue(new Set(["box"]));
    const pending: ((v: unknown) => void)[] = [];
    vi.spyOn(registry, "linkOf").mockReturnValue({ request: () => new Promise((resolve) => void pending.push(resolve)) } as never);
    const view = renderHook(() => useTracker());
    act(() => void view.result.current.reload());
    expect(pending).toHaveLength(2);
    pending[1]!({ jobs: [job("b-purdue", "purdue", [project("new")])] });
    await waitFor(() => expect(view.result.current.jobs[0]?.projects.map((p) => p.id)).toEqual(["new"]));
    await act(async () => pending[0]!({ jobs: [job("b-purdue", "purdue", [project("old")])] }));
    expect(view.result.current.jobs[0]!.projects.map((p) => p.id)).toEqual(["new"]);
    view.unmount();
    resetTracker();
  });

  /** Council round 1, sitting E (R1-E19): a down job's Retry spins until the read it started has answered. */
  it("settles a Retry's promise when its read answers, not before", async () => {
    rigged();
    resetTracker();
    vi.spyOn(workSwitch, "hosts").mockReturnValue(new Set(["box"]));
    const pending: ((v: unknown) => void)[] = [];
    vi.spyOn(registry, "linkOf").mockReturnValue({ request: () => new Promise((resolve) => void pending.push(resolve)) } as never);
    const view = renderHook(() => useTracker());
    let settled = false;
    act(() => void view.result.current.reload().then(() => (settled = true)));
    expect(pending).toHaveLength(2);
    await act(async () => pending[0]!({ jobs: [] }));
    expect(settled).toBe(false);
    await act(async () => pending[1]!({ jobs: [] }));
    await waitFor(() => expect(settled).toBe(true));
    view.unmount();
    resetTracker();
  });

  it("asks after a quiet spell: a burst of five focuses is one ask, a hidden spell none (perf M11)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      rigged();
      resetTracker();
      vi.spyOn(workSwitch, "hosts").mockReturnValue(new Set(["box"]));
      const request = vi.fn(async () => ({ jobs: [] }));
      vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
      let hidden = false;
      vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
      const view = renderHook(() => useTracker());
      expect(request).toHaveBeenCalledTimes(1);
      const focus = (): void => act(() => void window.dispatchEvent(new Event("focus")));
      // Five focuses inside the minute after a read: none asks.
      for (let i = 0; i < 5; i++) focus();
      expect(request).toHaveBeenCalledTimes(1);
      // A hidden spell of five minutes asks nothing.
      hidden = true;
      act(() => void document.dispatchEvent(new Event("visibilitychange")));
      act(() => void vi.advanceTimersByTime(5 * 60_000));
      expect(request).toHaveBeenCalledTimes(1);
      // Back: the window shows and five focuses land in a burst; one ask in all.
      hidden = false;
      act(() => void document.dispatchEvent(new Event("visibilitychange")));
      for (let i = 0; i < 5; i++) focus();
      expect(request).toHaveBeenCalledTimes(2);
      // A minute shown with no word asks once more.
      act(() => void vi.advanceTimersByTime(60_000));
      expect(request).toHaveBeenCalledTimes(3);
      view.unmount();
      act(() => void vi.advanceTimersByTime(5 * 60_000));
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
      resetTracker();
    }
  });

  it("a job's down words reach the page as a person's, never a store's raw text", async () => {
    rigged();
    const raw = "[CONVEX Q(projects:facts)] [Request ID: 1a2b] Server Error";
    const got = await askHosts(async () => ({ jobs: [job("b-unify", "unify", [], raw)] }), ["box"]);
    expect(got[0]!.overview!.jobs[0]!.down).toBe("The box could not read Job unify's projects from LifeOS.");
    // A host's words that are already plain stand.
    expect(downWords("LifeOS is not signed in", "the box", "Unify")).toBe("Not signed in to LifeOS on the box. Sign in under Settings, Connections.");
  });
});

describe("a visit that opens on kept answers", () => {
  const kept = [{ environmentId: "box", overview: { jobs: [] }, error: null }, { environmentId: "mac", overview: { jobs: [] }, error: null }];
  it("says a host that dropped while the page was shut at once, holds a new host as pending, and drops one no longer Work's", () => {
    const got = reconcileKept(kept, ["box", "mac", "pc"], (id) => (id === "mac" ? "closed" : "open"))!;
    expect(got.map((a) => a.environmentId)).toEqual(["box", "mac", "pc"]);
    expect(got[0]).toBe(kept[0]);
    expect(got[1]!.overview).toBeNull();
    expect(got[1]!.error).toBeTruthy();
    expect(got[2]).toEqual({ environmentId: "pc", overview: null, error: null });
    expect(reconcileKept(kept, ["box"], () => "open")!.map((a) => a.environmentId)).toEqual(["box"]);
    expect(reconcileKept(null, ["box"], () => "open")).toBeNull();
  });
});
