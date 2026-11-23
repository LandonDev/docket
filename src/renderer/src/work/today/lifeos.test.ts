import { describe, expect, it } from "vitest";
import { lackingOf, lifeosHosts, pickHost, reachOf, sessionDown } from "./lifeos";
import type { TodayWorkspace } from "./types";

const job = (environmentId: string, sector: string, open = true): TodayWorkspace => ({ environmentId, workspaceId: `${environmentId}-${sector}`, sector: sector as TodayWorkspace["sector"], name: sector, path: `/w/${sector}`, open });

describe("the host whose LifeOS session Today reads", () => {
  const jobs = [job("mac", "purdue"), job("box", "ref"), job("box", "unify"), job("pc", "life", false)];

  it("is the Work home first, then each open host that holds a job; never a host whose link is down", () => {
    expect(lifeosHosts(jobs, "box")).toEqual(["box", "mac"]);
    expect(lifeosHosts(jobs, null)).toEqual(["mac", "box"]);
    // A home that holds no job, or whose link is down, does not lead.
    expect(lifeosHosts(jobs, "pc")).toEqual(["mac", "box"]);
    expect(lifeosHosts(jobs, "elsewhere")).toEqual(["mac", "box"]);
    expect(lifeosHosts([], "box")).toEqual([]);
  });

  it("falls to the next when one is found wanting; with every host wanting it is the first, whose state the page says", () => {
    expect(pickHost(["box", "mac"], new Set())).toBe("box");
    expect(pickHost(["box", "mac"], new Set(["box"]))).toBe("mac");
    expect(pickHost(["box", "mac"], new Set(["box", "mac"]))).toBe("box");
    expect(pickHost([], new Set())).toBeNull();
  });

  it("a session is down when it has no client and is not on its way", () => {
    expect(sessionDown({ client: null, state: "connecting" })).toBe(false);
    expect(sessionDown({ client: null, state: "connected" })).toBe(false);
    for (const state of ["signed-out", "refused", "unreachable", "off", "pairing"] as const) expect(sessionDown({ client: null, state }), state).toBe(true);
    expect(sessionDown({ client: {} as never, state: "connected" })).toBe(false);
  });

  it("says its reach as the page words it", () => {
    expect(reachOf({ client: {} as never, state: "connected" }, "box")).toBe("ok");
    expect(reachOf({ client: null, state: "connecting" }, "box")).toBe("waiting");
    expect(reachOf({ client: null, state: "connected" }, "box")).toBe("waiting");
    expect(reachOf({ client: null, state: "signed-out" }, "box")).toBe("signed-out");
    expect(reachOf({ client: null, state: "refused" }, "box")).toBe("signed-out");
    expect(reachOf({ client: null, state: "pairing" }, "box")).toBe("signed-out");
    expect(reachOf({ client: null, state: "unreachable" }, "box")).toBe("unreachable");
    expect(reachOf({ client: null, state: "off" }, "box")).toBe("unreachable");
    // No host with an open link holds a job: nothing can reach LifeOS.
    expect(reachOf({ client: null, state: "connecting" }, null)).toBe("unreachable");
  });
});

describe("the sectors the all-sector session lacks", () => {
  const jobs = [job("box", "purdue"), job("box", "ref"), job("mac", "ref"), job("mac", "unify"), job("pc", "life", false), job("box", "cosmic")];

  it("are none while the cover is unknown, and none when the session holds every sector", () => {
    expect(lackingOf(null, jobs, "box").size).toBe(0);
    expect(lackingOf("all", jobs, "box").size).toBe(0);
  });

  it("are each job's sector outside the cover, read on another open host that holds that job", () => {
    const lacking = lackingOf(["purdue"], jobs, "box");
    // ref and unify are held on the Mac; cosmic only on the session's own host, which would refuse it again; life's host is down.
    expect([...lacking]).toEqual([
      ["ref", "mac"],
      ["unify", "mac"],
    ]);
  });

  it("a sector no job has is never read", () => {
    expect(lackingOf(["purdue", "ref", "unify", "cosmic"], jobs, "box").size).toBe(0);
  });
});
