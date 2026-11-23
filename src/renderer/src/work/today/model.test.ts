import { afterEach, describe, expect, it, vi } from "vitest";
import { ALSO, dayAfter, dayBounds, fold, foldKey, foldOf, jobsOf, merge, offlineHosts, page, workspaceFor, type Fed } from "./model";
import type { TodayAnswer, TodayRow, TodaySection, TodayWorkspace } from "./types";

const HELD: TodaySection = { id: "held", title: "Waiting on you", order: 10, empty: "Nothing waits on your press", fold: 5 };
const MEETINGS: TodaySection = { id: "meetings", title: "Meetings", order: 20, empty: "No meetings today", lifeos: true };
const DUE: TodaySection = { id: "due", title: "Due", order: 30, empty: "Nothing due today", fold: 7, lifeos: true };

const row = (key: string, section: string, more: Partial<TodayRow> = {}): TodayRow => ({ key, section, sector: "purdue", title: key, open: () => {}, ...more });
const fed = (id: string, section: TodaySection | undefined, answer: TodayAnswer): Fed => ({ source: { id, section }, answer });
const job = (environmentId: string, sector: string, open = true): TodayWorkspace => ({ environmentId, workspaceId: `${environmentId}-${sector}`, sector: sector as TodayWorkspace["sector"], name: sector, path: `/w/${sector}`, open });

describe("merge", () => {
  it("keeps one row per key: the first source to give it wins", () => {
    const first = row("event:1", "meetings", { title: "From LifeOS" });
    const [meetings] = merge([fed("meetings", MEETINGS, { rows: [first] }), fed("other", undefined, { rows: [row("event:1", "meetings", { title: "A second copy" })] })]);
    expect(meetings!.rows.map((r) => r.title)).toEqual(["From LifeOS"]);
  });

  it("lays a mark on the row of its key: the note takes the second line, the live line the row's own, the press and one verb", () => {
    const open = vi.fn();
    const resolve = { label: "Resolve", run: vi.fn() };
    const prepare = { label: "Prepare", run: vi.fn() };
    const [meetings] = merge([
      fed("meetings", MEETINGS, { rows: [row("event:1", "meetings", { detail: "CoRec 2212", whenLine: "Leave 5:10 PM", acts: [prepare] })] }),
      fed("clashes", undefined, { marks: [{ key: "event:1", note: "Overlaps Staff sync", late: true, whenLine: "Leave 4:40 PM", act: resolve }] }),
      fed("prep", undefined, { marks: [{ key: "event:1", note: "Prep is ready", open }] }),
    ]);
    const shown = meetings!.rows[0]!;
    // The fault's note is said, not the plain one, whichever source came first.
    expect(shown.detail).toBe("Overlaps Staff sync");
    expect(shown.detailLate).toBe(true);
    // One Leave shows: the mark's.
    expect(shown.whenLine).toBe("Leave 4:40 PM");
    expect(shown.open).toBe(open);
    // The mark's verb leads, the row's own follows, two at most.
    expect(shown.acts).toEqual([resolve, prepare]);
  });

  it("a mark with no row draws nothing, and a row is not changed by another row's mark", () => {
    const sections = merge([fed("meetings", MEETINGS, { rows: [row("event:1", "meetings", { detail: "CoRec" })] }), fed("clashes", undefined, { marks: [{ key: "event:9", note: "Overlaps nothing here" }] })]);
    expect(sections.flatMap((s) => s.rows)).toHaveLength(1);
    expect(sections[0]!.rows[0]!.detail).toBe("CoRec");
  });

  it("orders sections by their order, whatever order their sources load in, and rows by `at`", () => {
    const sections = merge([
      fed("due", DUE, { rows: [row("task:b", "due", { at: 20 }), row("task:none", "due"), row("task:a", "due", { at: 10 }), row("task:none2", "due")] }),
      fed("held", HELD, { rows: [row("held:1", "held")] }),
      fed("meetings", MEETINGS, {}),
    ]);
    expect(sections.map((s) => s.def.id)).toEqual(["held", "meetings", "due"]);
    // Rows with no `at` keep their place after those with one.
    expect(sections[2]!.rows.map((r) => r.key)).toEqual(["task:a", "task:b", "task:none", "task:none2"]);
  });

  it("draws Also only while it has a row, and leaves out a row whose section no source declares", () => {
    expect(merge([fed("held", HELD, {})]).map((s) => s.def.id)).toEqual(["held"]);
    const sections = merge([fed("held", HELD, {}), fed("review", undefined, { rows: [row("review:w47", "also"), row("file:1", "files")] })]);
    expect(sections.map((s) => s.def.id)).toEqual(["held", "also"]);
    expect(sections[1]!.def).toBe(ALSO);
    expect(sections[1]!.rows.map((r) => r.key)).toEqual(["review:w47"]);
  });

  it("a section with no empty line is drawn only while it has a row or a host that did not answer: no bones, no bare heading", () => {
    const OWED: TodaySection = { id: "money", title: "Owed", order: 60, empty: "" };
    const ids = (answer: TodayAnswer) => merge([fed("held", HELD, {}), fed("money", OWED, answer)]).map((s) => s.def.id);
    expect(ids({})).toEqual(["held"]);
    expect(ids({ loading: true })).toEqual(["held"]);
    expect(ids({ rows: [row("money:1", "money")] })).toEqual(["held", "money"]);
    expect(ids({ failed: [{ environmentId: "mac", error: "timed out" }] })).toEqual(["held", "money"]);
    // With nothing owed and nothing else anywhere, the page is still all clear.
    expect(page([fed("held", HELD, {}), fed("money", OWED, {})], { jobs: [job("box", "purdue")], lifeos: "ok" })).toEqual({ kind: "clear" });
  });

  it("a section is loading, failed and noted by the source that owns it, never by one that only adds rows", () => {
    const retry = vi.fn();
    const [held, meetings] = merge([
      fed("held", HELD, { failed: [{ environmentId: "mac", error: "timed out", retry }] }),
      fed("meetings", MEETINGS, { loading: true, note: "Tomorrow starts at 9:00 AM with Staff sync" }),
      fed("prep", undefined, { loading: true }),
    ]);
    expect(held!.loading).toBe(false);
    expect(held!.failed).toEqual([{ environmentId: "mac", error: "timed out", retry }]);
    expect(meetings!.loading).toBe(true);
    expect(meetings!.note).toBe("Tomorrow starts at 9:00 AM with Staff sync");
  });
});

describe("fold", () => {
  const section = (def: TodaySection, rows: TodayRow[], loading = false) => ({ def, rows, loading, failed: [] });
  const tasks = (n: number) => Array.from({ length: n }, (_, i) => row(`task:${i}`, "due", { at: i }));

  it("shows a section's first rows and counts the rest, until he unfolds it", () => {
    const folded = fold(section(DUE, tasks(11)));
    expect(folded.rows).toHaveLength(7);
    expect(folded.more).toBe(4);
    const open = fold(section(DUE, tasks(11)), { more: new Set(["due"]), earlier: new Set() });
    expect(open.rows).toHaveLength(11);
    expect(open.more).toBe(0);
    // At the cap exactly, nothing is folded: "0 more" is never drawn.
    expect(fold(section(DUE, tasks(7))).more).toBe(0);
    expect(fold(section(HELD, tasks(6))).more).toBe(1);
  });

  it("a section with no fold shows every row", () => {
    expect(fold(section(MEETINGS, tasks(12))).rows).toHaveLength(12);
  });

  it("folds the rows that are over into a count at the head; unfolded, they lead the list", () => {
    const rows = [row("event:1", "meetings", { at: 1, past: true }), row("event:2", "meetings", { at: 2, past: true }), row("event:3", "meetings", { at: 3 })];
    const folded = fold(section(MEETINGS, rows));
    expect(folded.earlier).toBe(2);
    expect(folded.rows.map((r) => r.key)).toEqual(["event:3"]);
    const open = fold(section(MEETINGS, rows), { more: new Set(), earlier: new Set(["meetings"]) });
    expect(open.earlier).toBe(0);
    expect(open.rows.map((r) => r.key)).toEqual(["event:1", "event:2", "event:3"]);
  });

  it("is bones only for a section that has never answered: kept rows still show while it reads again", () => {
    expect(fold(section(DUE, [], true)).state).toBe("bones");
    expect(fold(section(DUE, [], false)).state).toBe("empty");
    expect(fold(section(DUE, tasks(1), true)).state).toBe("rows");
  });
});

describe("page", () => {
  const jobs = [job("box", "purdue"), job("box", "ref")];

  it("says there are no jobs when no Work workspace has a sector", () => {
    expect(page([fed("held", HELD, { rows: [row("held:1", "held")] })], { jobs: [], lifeos: "ok" })).toEqual({ kind: "no-jobs" });
  });

  it("is all clear only when every section answered with nothing, none failed and no host is offline", () => {
    const empty = [fed("held", HELD, {}), fed("meetings", MEETINGS, {}), fed("due", DUE, {})];
    expect(page(empty, { jobs, lifeos: "ok" })).toEqual({ kind: "clear" });
    expect(page([...empty.slice(0, 2), fed("due", DUE, { loading: true })], { jobs, lifeos: "ok" }).kind).toBe("day");
    expect(page([fed("held", HELD, { failed: [{ environmentId: "box", error: "x" }] }), ...empty.slice(1)], { jobs, lifeos: "ok" }).kind).toBe("day");
    expect(page(empty, { jobs: [...jobs, job("mac", "unify", false)], lifeos: "ok" })).toMatchObject({ kind: "day", offline: ["mac"] });
    // LifeOS out of reach is said only where a section reads it: with none on the page it holds nothing up.
    expect(page([fed("held", HELD, {})], { jobs, lifeos: "unreachable" })).toEqual({ kind: "clear" });
    expect(page(empty, { jobs, lifeos: "signed-out" }).kind).toBe("day");
    // A session on its way is not an answer.
    expect(page(empty, { jobs, lifeos: "waiting" }).kind).toBe("day");
  });

  it("a meeting that ended is not left: the evening is all clear, and says what the day's last section said of tomorrow", () => {
    const over = (answer: TodayAnswer) => [fed("held", HELD, {}), fed("meetings", MEETINGS, { rows: [row("event:1", "meetings", { past: true })], ...answer }), fed("due", DUE, {})];
    expect(page(over({}), { jobs, lifeos: "ok" })).toEqual({ kind: "clear" });
    expect(page(over({ note: "Tomorrow starts at 9:00 AM with Staff sync." }), { jobs, lifeos: "ok" })).toEqual({ kind: "clear", line: "Tomorrow starts at 9:00 AM with Staff sync." });
    // The day settles the same way whether "N earlier" is folded or open.
    expect(page(over({}), { jobs, lifeos: "ok", folds: { more: new Set(), earlier: new Set(["meetings"]) } }).kind).toBe("clear");
    // A read still out, or one that failed, is not an answer.
    expect(page(over({ loading: true }), { jobs, lifeos: "ok" }).kind).toBe("day");
    expect(page(over({ failed: [{ environmentId: "mac", error: "x" }] }), { jobs, lifeos: "ok" }).kind).toBe("day");
  });

  it("is not clear while a source that draws nothing is still out: a section with no empty line, rows for Also, marks", () => {
    const empty = [fed("held", HELD, {}), fed("due", DUE, {})];
    const owed = { id: "money", title: "Owed", order: 60, empty: "" };
    expect(page([...empty, fed("money", owed, { loading: true })], { jobs, lifeos: "ok" }).kind).toBe("day");
    expect(page([...empty, fed("money", owed, { rows: [] })], { jobs, lifeos: "ok" }).kind).toBe("clear");
    expect(page([...empty, { source: { id: "review" }, answer: { loading: true } }], { jobs, lifeos: "ok" }).kind).toBe("day");
    expect(page([...empty, { source: { id: "review" }, answer: { rows: [] } }], { jobs, lifeos: "ok" }).kind).toBe("clear");
  });

  it("a section whose rows arrived while a read some job needs is still out is not empty: it draws bones, and the page is not clear", () => {
    const day = page([fed("held", HELD, {}), fed("due", DUE, { rows: [], loading: true })], { jobs, lifeos: "ok" });
    expect(day.kind === "day" && day.blocks.map((b) => b.kind === "section" && [b.section.state, b.section.pending])).toEqual([["empty", false], ["bones", true]]);
  });

  it("lists every stop of the arrows in page order: the rows, and the fold lines between them", () => {
    const day = page(
      [fed("due", DUE, { rows: [row("task:1", "due")] }), fed("held", HELD, { rows: [row("held:1", "held")] }), fed("meetings", MEETINGS, { rows: [row("event:old", "meetings", { past: true, at: 1 }), row("event:1", "meetings", { at: 2 })] })],
      { jobs, lifeos: "ok" },
    );
    expect(day).toMatchObject({ kind: "day", keys: ["held:1", "fold:earlier:meetings", "event:1", "task:1"] });
    const many = page([fed("due", { ...DUE, fold: 2 }, { rows: [1, 2, 3].map((n) => row(`task:${n}`, "due", { at: n })) })], { jobs, lifeos: "ok" });
    expect(many).toMatchObject({ keys: ["task:1", "task:2", "fold:more:due"] });
    expect(foldOf("fold:more:due")).toEqual({ which: "more", section: "due" });
    expect(foldOf(foldKey("earlier", "a:b"))).toEqual({ which: "earlier", section: "a:b" });
    expect(foldOf("task:1")).toBeNull();
  });

  it("says a read that failed in a source with no section under Also, so no failure is dropped and the page is not clear", () => {
    const failed = { source: { id: "digest" }, answer: { rows: [], failed: [{ environmentId: "box", error: "x" }] } };
    const day = page([fed("held", HELD, {}), fed("due", DUE, {}), failed], { jobs, lifeos: "ok" });
    expect(day.kind).toBe("day");
    expect(day.kind === "day" && day.blocks.map((b) => b.kind === "section" && [b.section.id, b.section.failed.length])).toEqual([["held", 0], ["due", 0], ["also", 1]]);
  });

  it("a section is partial only when its source answered rows with a read still out, never while it reads again what it had", () => {
    const rows = [row("task:1", "due")];
    const of = (extra: object) => page([{ source: { id: "due", section: DUE }, answer: { rows, loading: true }, ...extra }], { jobs, lifeos: "ok" });
    const partial = (p: ReturnType<typeof page>) => p.kind === "day" && p.blocks.map((b) => b.kind === "section" && b.section.partial);
    expect(partial(of({}))).toEqual([true]);
    // Rows the store kept from before (a reopen): they are a whole answer, shown with no cue.
    expect(partial(of({ kept: true }))).toEqual([false]);
    expect(partial(page([fed("due", DUE, { rows })], { jobs, lifeos: "ok" }))).toEqual([false]);
  });

  it("hands a section the shape of its bones", () => {
    const day = page([fed("due", { ...DUE, bones: "tick" }, { loading: true }), fed("held", HELD, { loading: true })], { jobs, lifeos: "ok" });
    expect(day.kind === "day" && day.blocks.map((b) => b.kind === "section" && b.section.bones)).toEqual([undefined, "tick"]);
  });

  it("while no host can read LifeOS, its sections give way to one line where the first stood", () => {
    const all = [fed("held", HELD, { rows: [row("held:1", "held")] }), fed("meetings", MEETINGS, { rows: [row("event:1", "meetings")] }), fed("due", DUE, {}), fed("money", { id: "money", title: "Money", order: 60, empty: "Nothing owed" }, {})];
    const day = page(all, { jobs, lifeos: "unreachable" });
    expect(day.kind).toBe("day");
    if (day.kind !== "day") return;
    expect(day.blocks.map((b) => (b.kind === "section" ? b.section.id : `lifeos:${b.reach}`))).toEqual(["held", "lifeos:unreachable", "money"]);
    expect(day.keys).toEqual(["held:1"]);
    const out = page(all, { jobs, lifeos: "signed-out" });
    expect(out.kind === "day" && out.blocks[1]).toEqual({ kind: "lifeos", reach: "signed-out" });
  });

  it("draws bones for a LifeOS section while the session is on its way, and its kept rows if it has them", () => {
    const day = page([fed("meetings", MEETINGS, {}), fed("due", DUE, { rows: [row("task:1", "due")] })], { jobs, lifeos: "waiting" });
    expect(day.kind === "day" && day.blocks.map((b) => b.kind === "section" && b.section.state)).toEqual(["bones", "rows"]);
  });
});

describe("the jobs", () => {
  const catalog = [
    { id: "w1", environmentId: "box", name: "Purdue Esports", path: "/w/purdue", kind: "work", sector: "purdue" },
    { id: "w2", environmentId: "mac", name: "Purdue", path: "/m/purdue", kind: "work", sector: "purdue" },
    { id: "w3", environmentId: "box", name: "temp-code", path: "/r/temp-code" },
    { id: "w4", environmentId: "box", name: "Unlinked", path: "/w/unlinked", kind: "work", sector: null },
    { id: "w5", environmentId: "old", name: "Ref", path: "/o/ref", kind: "work", sector: "ref" },
  ];

  it("are the Work workspaces with a sector on hosts with Work on", () => {
    const jobs = jobsOf(catalog, new Set(["box", "mac"]), new Set(["box"]));
    expect(jobs.map((j) => [j.workspaceId, j.open])).toEqual([
      ["w1", true],
      ["w2", false],
    ]);
    expect(offlineHosts(jobs)).toEqual(["mac"]);
  });

  it("a sector held on two hosts opens on the Work home, else on the first whose link is open", () => {
    const jobs = jobsOf(catalog, new Set(["box", "mac"]), new Set(["box", "mac"]));
    expect(workspaceFor("purdue", jobs, "mac")?.workspaceId).toBe("w2");
    expect(workspaceFor("purdue", jobs, "box")?.workspaceId).toBe("w1");
    expect(workspaceFor("purdue", jobs, null)?.workspaceId).toBe("w1");
    const macOnly = jobsOf(catalog, new Set(["box", "mac"]), new Set(["mac"]));
    expect(workspaceFor("purdue", macOnly, null)?.workspaceId).toBe("w2");
    // A home that holds no job for the sector does not win.
    expect(workspaceFor("purdue", macOnly, "elsewhere")?.workspaceId).toBe("w2");
    // A sector with no job is left out.
    expect(workspaceFor("ref", jobs, "box")).toBeNull();
  });
});

describe("the day's bounds", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const hours = (b: { from: number; to: number }) => (b.to - b.from) / 3_600_000;
  const at = (iso: string) => new Date(iso).getTime();

  it("run from this local midnight to the next, on an ordinary day and on both clock-change days", () => {
    vi.stubEnv("TZ", "America/Chicago");
    const ordinary = dayBounds(at("2026-11-23T15:30:00-06:00"));
    expect(new Date(ordinary.from).toISOString()).toBe("2026-11-23T06:00:00.000Z");
    expect(hours(ordinary)).toBe(24);
    // Clocks go forward: the day is 23 hours.
    const spring = dayBounds(at("2026-03-08T12:00:00-05:00"));
    expect(new Date(spring.from).toISOString()).toBe("2026-03-08T06:00:00.000Z");
    expect(hours(spring)).toBe(23);
    // Clocks go back: the day is 25 hours, and both 1:30s belong to it.
    const autumn = dayBounds(at("2026-11-01T01:30:00-06:00"));
    expect(hours(autumn)).toBe(25);
    expect(dayBounds(at("2026-11-01T01:30:00-05:00"))).toEqual(autumn);
  });

  it("the last minute of a day and the first of the next are different days", () => {
    vi.stubEnv("TZ", "America/Chicago");
    const before = dayBounds(at("2026-11-23T23:59:30-06:00"));
    const after = dayBounds(at("2026-11-24T00:00:30-06:00"));
    expect(after.from).toBe(before.to);
    expect(dayAfter(before.from, 1)).toBe(before.to);
    expect(dayAfter(before.from, 2)).toBe(after.to);
  });
});
