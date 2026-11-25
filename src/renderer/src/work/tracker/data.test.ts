// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrackerJob, TrackerProject } from "@shared/work/tracker";
import { registry } from "../../lib/connection";
import { act, renderHook, waitFor } from "@testing-library/react";
import { workSwitch } from "../../lib/workSwitch";
import { askHosts, closedWords, downWords, mergeOverviews, resetTracker, useTracker } from "./data";

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

  it("every host with Work on answers: an open link is asked, one not open says it is connecting or not connected", async () => {
    rigged();
    const ask = vi.fn(async () => ({ jobs: [job("b-purdue", "purdue", [project("lan")])] }));
    const got = await askHosts(ask, ["box", "mac", "pc"]);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(got.map((a) => [a.environmentId, a.error, a.overview?.jobs.length ?? null])).toEqual([
      ["box", null, 1],
      ["mac", "This Mac is connecting.", null],
      ["pc", "Office PC is not connected.", null],
    ]);
    expect(closedWords("the box", "unauthorized")).toBe("The box is not connected.");
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

  it("only the newest read lands: an older read that answers late never replaces it", async () => {
    rigged();
    resetTracker();
    vi.spyOn(workSwitch, "hosts").mockReturnValue(new Set(["box"]));
    const pending: ((v: unknown) => void)[] = [];
    vi.spyOn(registry, "linkOf").mockReturnValue({ request: () => new Promise((resolve) => void pending.push(resolve)) } as never);
    const view = renderHook(() => useTracker());
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(pending).toHaveLength(2);
    pending[1]!({ jobs: [job("b-purdue", "purdue", [project("new")])] });
    await waitFor(() => expect(view.result.current.jobs[0]?.projects.map((p) => p.id)).toEqual(["new"]));
    await act(async () => pending[0]!({ jobs: [job("b-purdue", "purdue", [project("old")])] }));
    expect(view.result.current.jobs[0]!.projects.map((p) => p.id)).toEqual(["new"]);
    view.unmount();
    resetTracker();
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
