// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEFT, type ReviewBody } from "@shared/work/review";
import { registry, type EnvironmentStatus } from "../../lib/connection";
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { AFTER, fixtureView, TZ, WEEK } from "./fixtures";
import { loadRoutine, loadWeek, loadZone, markSeen, resetReviewStore, reviewNow, reviewZone, settleHost, settleRow, thisWeek, undoSettle } from "./store";

/**
 * The page's store: every host with Work on is asked for its part, the parts are merged by sector with LifeOS taken
 * once, a host that is off is one line, and each press goes to the host that owns the row.
 */

const open = { transport: "open" } as EnvironmentStatus;
const offline = { transport: "offline" } as EnvironmentStatus;
type Answer = (method: string, params: Record<string, unknown>) => unknown;
let links: Record<string, { status: EnvironmentStatus; answer: Answer; calls: { method: string; params: Record<string, unknown> }[] }>;

/** The two parts the made-up week has: the box's and the Mac's. */
const parts = () => {
  const { view } = fixtureView("full");
  const made = (host: "box" | "mac"): ReviewBody => bodies[host]!;
  return { view, made };
};
let bodies: Record<string, ReviewBody>;

beforeEach(async () => {
  // The fixture's own bodies, read back out of a merge: one a host.
  const fixtures = await import("./fixtures");
  const full = fixtures.fixtureView("full").view.review!;
  const boxJobs = full.jobs.map((j) => ({ workspaceId: j.at.find((a) => a.environmentId === "env-box")!.workspaceId, sector: j.sector, name: j.name }));
  const base: ReviewBody = { host: "box", from: WEEK.from, to: WEEK.to, tz: TZ, madeAt: AFTER, by: "routine", over: true, jobs: boxJobs, lifeos: { events: [], sent: [{ id: "m1", threadId: "t1", subject: "Season 12 patch notes", to: ["Riley Okafor"], addresses: [], at: WEEK.from + 3_600_000, sector: "cosmic" }], done: [], answered: [], answeredSince: null }, points: [[WEEK.from + 3_600_000, 0, "said"]], ran: [[0, 3_600_000]], slipped: { at: AFTER, rows: [{ key: "task:k1", ref: { kind: "task", id: "k1", dueAt: WEEK.from }, sector: "hypixel", workspaceId: null, title: "Send the thumbnail drafts", at: WEEK.from, people: [], others: 0, open: true }, { key: "mail:tw1", ref: { kind: "mail", threadId: "tw1", since: WEEK.from }, sector: "cosmic", workspaceId: null, title: "Winter video schedule", at: WEEK.from, people: [], others: 0, open: true }, { key: "held:host:h1", ref: { kind: "held", ref: { at: "host", id: "h1" } }, sector: "purdue", workspaceId: "w-purdue", title: "Reply to the facilities office", at: WEEK.from, people: [], others: 0, open: true }] }, shipped: [], before: null, left: [] };
  bodies = {
    box: base,
    mac: { ...base, host: "mac", jobs: [{ workspaceId: "m-cosmic", sector: "cosmic", name: "Cosmic" }], points: [[WEEK.from + 3_700_000, 0, "edited"]], ran: [[0, 1_800_000]], slipped: { at: AFTER, rows: [{ key: "held:host:h1", ref: { kind: "held", ref: { at: "host", id: "h1" } }, sector: "cosmic", workspaceId: "m-cosmic", title: "Post the patch notes", at: WEEK.from, people: [], others: 0, open: true }] } },
  };
  const host = (id: string, answer: Answer) => ({ status: open, answer, calls: [] as { method: string; params: Record<string, unknown> }[] });
  links = {
    "env-box": host("env-box", (method) => (method === "work.review.week" ? bodies.box : method === "work.review.list" ? { weeks: [], tz: TZ } : method === "work.review.settle" ? { undo: "tok" } : method === "work.review.routine" ? null : { ok: true })),
    "env-mac": host("env-mac", (method) => (method === "work.review.week" ? bodies.mac : method === "work.review.list" ? { weeks: [], tz: "America/New_York" } : method === "work.review.settle" ? { undo: null, sessionId: "nudge" } : method === "work.review.routine" ? { workspaceId: "m-cosmic", routineId: "r1", words: "Fridays at 4:00 PM" } : { ok: true })),
  };
  vi.spyOn(registry, "statusOf").mockImplementation((id) => links[id]?.status ?? offline);
  vi.spyOn(registry, "environment").mockImplementation((id) => ({ id, name: id === "env-mac" ? "The Mac" : "The box", routes: [], credentialRef: null }) as never);
  vi.spyOn(registry, "environments").mockReturnValue([{ id: "env-box", platform: "linux" }, { id: "env-mac", platform: "darwin" }] as never);
  vi.spyOn(registry, "linkOf").mockImplementation(
    (id) =>
      ({
        environmentId: id,
        request: async (method: string, params: Record<string, unknown>) => {
          links[id]!.calls.push({ method, params });
          const got = links[id]!.answer(method, params);
          if (got instanceof Error) throw got;
          return got;
        },
      }) as never,
  );
  setWorkOn("env-box", true);
  setWorkOn("env-mac", true);
  resetReviewStore({ now: () => AFTER });
  void parts;
});

afterEach(() => {
  workSwitch.reset();
  resetReviewStore();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the week across hosts", () => {
  it("asks every linked host in the home host's zone and merges their parts, LifeOS taken once", async () => {
    await loadZone();
    // The box is the Work home (the Linux host): its zone is the one weeks are cut in, though the Mac says another.
    expect(reviewZone()).toBe(TZ);
    expect(links["env-mac"]!.calls.map((c) => c.method)).toEqual([]);
    const week = thisWeek();
    await loadWeek(WEEK);
    expect(week.from).toBe(WEEK.to);
    for (const id of ["env-box", "env-mac"]) expect(links[id]!.calls.filter((c) => c.method === "work.review.week").at(-1)).toEqual({ method: "work.review.week", params: { from: WEEK.from, to: WEEK.to, tz: TZ } });
    const view = reviewNow(WEEK);
    expect(view.settled).toBe(true);
    expect(view.off).toEqual([]);
    const cosmic = view.review!.hours.find((h) => h.job === "cosmic")!;
    // One mail, though both hosts carry it; both hosts' points and run time.
    expect(cosmic.stands).toEqual({ said: 1, sent: 1, pressed: 0, edited: 1 });
    expect(cosmic.ranMs).toBe(3_600_000 + 1_800_000);
    expect(view.review!.lifeosFrom).toBe("env-box");
    expect(view.review!.jobs.find((j) => j.key === "cosmic")!.at).toEqual([
      { environmentId: "env-box", workspaceId: "w-cosmic" },
      { environmentId: "env-mac", workspaceId: "m-cosmic" },
    ]);
    // LifeOS's rows once, from the home host; each host's own held row.
    expect(view.review!.slipped.map((r) => [r.key, r.environmentId]).sort()).toEqual([
      ["env-box:held:host:h1", "env-box"],
      ["env-mac:held:host:h1", "env-mac"],
      ["mail:tw1", "env-box"],
      ["task:k1", "env-box"],
    ]);
  });

  it("stands on the hosts that answer: one that is off is one line, never a failure", async () => {
    links["env-mac"]!.status = offline;
    await loadWeek(WEEK);
    expect(links["env-mac"]!.calls).toEqual([]);
    const view = reviewNow(WEEK);
    expect(view.off).toEqual(["The Mac is off. Its threads and held items are not counted."]);
    expect(view.errors).toEqual([]);
    expect(view.settled).toBe(true);
    expect(view.review!.hours.find((h) => h.job === "cosmic")!.ranMs).toBe(3_600_000);
  });

  it("says which host did not answer and keeps what it last said", async () => {
    await loadWeek(WEEK);
    links["env-mac"]!.answer = () => new Error("the request timed out");
    await loadWeek(WEEK);
    const view = reviewNow(WEEK);
    expect(view.errors).toEqual([{ environmentId: "env-mac", name: "The Mac", error: "the request timed out" }]);
    expect(view.review!.hours.find((h) => h.job === "cosmic")!.ranMs).toBe(3_600_000 + 1_800_000);
  });

  it("takes LifeOS from another host when the home could not reach it, and says only what is still missing", async () => {
    bodies.box = { ...bodies.box!, lifeos: null, left: [LEFT.lifeos, LEFT.held] };
    await loadWeek(WEEK);
    const view = reviewNow(WEEK);
    expect(view.review!.lifeosFrom).toBe("env-mac");
    expect(view.review!.left).toEqual([LEFT.held]);
  });

  it("is not settled, and has no review, until a host has answered", () => {
    expect(reviewNow(WEEK)).toMatchObject({ review: null, settled: false });
  });

  it("falls back to the window's own zone when no host says one", async () => {
    for (const id of Object.keys(links)) links[id]!.answer = () => new Error("not built: work.review.list");
    await loadZone();
    expect(reviewZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });
});

describe("a press goes to the host that owns the row", () => {
  it("LifeOS's rows to the host they were read from, a held row to its own host, a nudge to a host with the job's workspace", async () => {
    await loadWeek(WEEK);
    const review = reviewNow(WEEK).review!;
    const row = (key: string) => review.slipped.find((r) => r.key === key)!;
    expect(settleHost(review, row("task:k1"), "now")).toBe("env-box");
    expect(settleHost(review, row("env-mac:held:host:h1"), "drop")).toBe("env-mac");
    expect(settleHost(review, row("mail:tw1"), "later")).toBe("env-box");
    expect(settleHost(review, row("mail:tw1"), "now")).toBe("env-box");

    const done = await settleRow(review, row("task:k1"), "later");
    expect(done).toEqual({ undo: "tok", environmentId: "env-box" });
    expect(links["env-box"]!.calls.find((c) => c.method === "work.review.settle")).toEqual({ method: "work.review.settle", params: { row: { kind: "task", id: "k1", dueAt: WEEK.from }, how: "later", tz: TZ, sector: "hypixel" } });
    await undoSettle(done, WEEK);
    expect(links["env-box"]!.calls.filter((c) => c.method === "work.review.undo")).toEqual([{ method: "work.review.undo", params: { token: "tok" } }]);
    // Every press and every undo reads the week again.
    expect(links["env-box"]!.calls.filter((c) => c.method === "work.review.week").length).toBeGreaterThan(1);
  });

  it("sends a nudge for a job the home has no workspace of to a host that has one", async () => {
    bodies.box = { ...bodies.box!, jobs: bodies.box!.jobs.filter((j) => j.sector !== "cosmic") };
    await loadWeek(WEEK);
    const review = reviewNow(WEEK).review!;
    const mail = review.slipped.find((r) => r.key === "mail:tw1")!;
    expect(settleHost(review, mail, "now")).toBe("env-mac");
    expect(await settleRow(review, mail, "now")).toEqual({ undo: null, sessionId: "nudge", environmentId: "env-mac" });
  });
});

describe("money", () => {
  it("shows Money's own sums by job, the two ledgers of one job added, and nothing where Money does not answer", async () => {
    const answer = links["env-box"]!.answer;
    links["env-box"]!.answer = (method, params) =>
      method === "work.money.sums" ? { rows: [{ workspaceId: "w-cosmic", sector: "cosmic", in: 100_00, out: 25_00, owedToHim: 0, heOwes: 0, miles: 0, currency: "USD" }, { workspaceId: "w-ref", sector: "ref", in: 0, out: 0, owedToHim: 500, heOwes: 0, miles: 0, currency: "USD" }] } : answer(method, params);
    const mac = links["env-mac"]!.answer;
    links["env-mac"]!.answer = (method, params) => (method === "work.money.sums" ? { rows: [{ workspaceId: "m-cosmic", sector: "cosmic", in: 50_00, out: 0, owedToHim: 0, heOwes: 0, miles: 0, currency: "USD" }] } : mac(method, params));
    await loadZone();
    await loadWeek(WEEK);
    await new Promise((r) => setTimeout(r, 0));
    // Money is asked in local days, the last one exclusive.
    expect(links["env-box"]!.calls.find((c) => c.method === "work.money.sums")).toEqual({ method: "work.money.sums", params: { from: "2026-11-16", to: "2026-11-23" } });
    expect([...reviewNow(WEEK).money]).toEqual([["cosmic", { in: 150_00, out: 25_00 }]]);
    // A host from before Money: no line, and the review stands.
    links["env-box"]!.answer = (method, params) => (method === "work.money.sums" ? new Error("not built") : answer(method, params));
    resetReviewStore({ now: () => AFTER, zone: TZ });
    await loadWeek(WEEK);
    await new Promise((r) => setTimeout(r, 0));
    expect([...reviewNow(WEEK).money]).toEqual([["cosmic", { in: 50_00, out: 0 }]]);
    expect(reviewNow(WEEK).errors).toEqual([]);
  });
});

describe("seen, and the routine", () => {
  it("tells every linked host he opened the week", () => {
    links["env-mac"]!.status = offline;
    markSeen(WEEK);
    expect(links["env-box"]!.calls).toEqual([{ method: "work.review.seen", params: { from: WEEK.from } }]);
    expect(links["env-mac"]!.calls).toEqual([]);
  });

  it("names the routine of the first host that has one, the home first", async () => {
    expect(await loadRoutine()).toEqual({ workspaceId: "m-cosmic", routineId: "r1", words: "Fridays at 4:00 PM", environmentId: "env-mac" });
    expect(links["env-box"]!.calls.map((c) => c.method)).toEqual(["work.review.routine"]);
  });
});
