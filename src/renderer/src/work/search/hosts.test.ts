import { describe, expect, it } from "vitest";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { SEARCH_WAIT_MS } from "@shared/work/search";
import { ASK_MS, jobOfWorkspace, jobsOf, searchHosts, type HostsDeps } from "./hosts";

/** Who a search asks: every connected host with Work on, the Work home first, an offline one as a quiet line. */

const ws = (id: string, environmentId: string, sector: string | null, kind: "work" | "code" = "work", name = id): WorkspaceMeta => ({ id, name, path: `/w/${id}`, kind, sector, environmentId }) as unknown as WorkspaceMeta;
const workspaces = [ws("box-purdue", "box", "purdue", "work", "Purdue"), ws("mac-purdue", "mac", "purdue", "work", "Purdue Mac"), ws("box-cosmic", "box", "cosmic", "work", "Cosmic"), ws("box-side", "box", null, "work", "Side job"), ws("box-code", "box", "cosmic", "code")];
const deps = (over: Partial<HostsDeps> = {}): Partial<HostsDeps> => ({
  environments: () => [
    { id: "mac", name: "MacBook" },
    { id: "box", name: "The box" },
    { id: "studio", name: "Studio" },
    { id: "plain", name: "No Work here" },
  ],
  connected: (id) => id !== "studio",
  on: () => new Set(["mac", "box", "studio"]),
  home: () => "box",
  workspaces: () => workspaces,
  ...over,
});

describe("one ask of a host", () => {
  it("is given the host's own wait for a source and the road both ways, far short of the wire's own half minute", () => {
    expect(ASK_MS).toBeGreaterThan(SEARCH_WAIT_MS);
    expect(ASK_MS).toBeLessThanOrEqual(SEARCH_WAIT_MS + 3000);
  });
});

describe("jobs", () => {
  it("are a sector's Work workspaces on every host as one, a workspace with no sector by itself, never a code workspace", () => {
    const jobs = jobsOf(workspaces);
    expect(jobs.map((j) => [j.key, j.name, j.sector, j.ids])).toEqual([
      ["purdue", "Purdue", "purdue", ["box-purdue", "mac-purdue"]],
      ["cosmic", "Cosmic", "cosmic", ["box-cosmic"]],
      ["ws:box-side", "Side job", null, ["box-side"]],
    ]);
    expect(jobOfWorkspace(jobs, "mac-purdue")?.key).toBe("purdue");
    expect(jobOfWorkspace(jobs, "box-code")).toBeNull();
    expect(jobOfWorkspace(jobs, null)).toBeNull();
  });
});

describe("the hosts a search asks", () => {
  it("are every connected host with Work on, the Work home first; one that is not connected is offline, one with Work off is not asked", () => {
    const { hosts, offline } = searchHosts(null, deps());
    expect(hosts).toEqual([
      { id: "box", name: "The box", home: true },
      { id: "mac", name: "MacBook", home: false },
    ]);
    expect(offline).toEqual(["Studio"]);
  });
  it("held to one job, are the hosts that have a workspace of it, each asked for its own", () => {
    const jobs = jobsOf(workspaces);
    expect(searchHosts(jobs[0], deps()).hosts).toEqual([
      { id: "box", name: "The box", home: true, workspaceId: "box-purdue" },
      { id: "mac", name: "MacBook", home: false, workspaceId: "mac-purdue" },
    ]);
    const cosmic = searchHosts(jobs[1], deps());
    expect(cosmic.hosts).toEqual([{ id: "box", name: "The box", home: true, workspaceId: "box-cosmic" }]);
    // a host that has no workspace of the job is not offline for it: it is not asked
    expect(cosmic.offline).toEqual([]);
  });
  it("lets the first connected host stand in for a Work home that is not connected, so LifeOS is still asked", () => {
    const { hosts, offline } = searchHosts(null, deps({ connected: (id) => id === "mac" }));
    expect(hosts).toEqual([{ id: "mac", name: "MacBook", home: true }]);
    expect(offline).toEqual(["The box", "Studio"]);
  });
  it("is nobody with Work off everywhere", () => {
    expect(searchHosts(null, deps({ on: () => new Set() }))).toEqual({ hosts: [], offline: [] });
  });
});
