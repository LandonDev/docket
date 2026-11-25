import { describe, expect, it } from "vitest";
import type { TrackerJob, TrackerProject } from "@shared/work/tracker";
import { mergeOverviews } from "./data";

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
