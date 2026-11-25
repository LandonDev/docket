import { describe, expect, it } from "vitest";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { WORK_CHATS } from "../../lib/tcserver/workspaces";
import { workThreadItems } from "../../lib/sidebarRows";
import { archivedThreads, projectLead, targetWords, threadLead, threadLine, threadTime, workProjectRows } from "./columnModel";
import type { ProjectGroup, ThreadRow, WorkspaceSessionGroups } from "../../lib/workspaceSessions";

const row = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: "t",
  title: "Ask ITaP for two switches",
  status: "idle",
  updatedAt: 1,
  unread: false,
  paused: false,
  running: false,
  failed: false,
  needsYou: false,
  busySince: null,
  threadType: "chat",
  frozenActiveElapsed: null,
  createdAt: 1,
  ...over,
});
const project = (id: string, name: string, lifeosProjectId?: string): ProjectMeta =>
  ({ id, name, workspaceId: "w-job", mode: "local", branch: null, cwd: "/w", archived: false, createdAt: 1, ...(lifeosProjectId ? { lifeosProjectId } : {}) }) as ProjectMeta;
const group = (p: ProjectMeta, threads: ThreadRow[] = []): ProjectGroup => ({ project: p, threads, latest: 0, archivedCount: 0 });

describe("a thread's lead slot", () => {
  it("is amber for a question, red for a failure, the Outbox glyph for something held, the spinner while it works, and nothing at rest", () => {
    expect(threadLead(row({ status: "waiting", needsYou: true }))).toEqual({ kind: "state", state: "waiting" });
    // A subagent's question rides the root's outcome.
    expect(threadLead(row({ workOutcome: { words: "Asks you", tone: "asks" } }))).toEqual({ kind: "state", state: "waiting" });
    expect(threadLead(row({ status: "error", failed: true }))).toEqual({ kind: "state", state: "failed" });
    expect(threadLead(row({ workOutcome: { words: "Couldn't sign in", tone: "failed" } }))).toEqual({ kind: "state", state: "failed" });
    expect(threadLead(row({ workOutcome: { words: "1 mail to send", tone: "held" } }))).toEqual({ kind: "held" });
    expect(threadLead(row({ status: "running", running: true }))).toEqual({ kind: "state", state: "working" });
    expect(threadLead(row({ workOutcome: { words: "Made Seat map.xlsx", tone: "made" } }))).toBeNull();
    expect(threadLead(row({ status: "done" }))).toBeNull();
  });

  it("says held over working, since the held act waits on him (held is muted, never amber)", () => {
    expect(threadLead(row({ status: "running", running: true, workOutcome: { words: "1 mail to send", tone: "held" } }))).toEqual({ kind: "held" });
  });
});

describe("a project's lead slot", () => {
  it("is the most pressing of its threads: asks, then failed, then held, then working", () => {
    const working = row({ id: "a", status: "running", running: true });
    const held = row({ id: "b", workOutcome: { words: "1 mail to send", tone: "held" } });
    const failed = row({ id: "c", status: "error", failed: true });
    const asks = row({ id: "d", status: "waiting", needsYou: true });
    expect(projectLead([working])).toEqual({ kind: "state", state: "working" });
    expect(projectLead([working, held])).toEqual({ kind: "held" });
    expect(projectLead([working, held, failed])).toEqual({ kind: "state", state: "failed" });
    expect(projectLead([working, held, failed, asks])).toEqual({ kind: "state", state: "waiting" });
  });

  it("is nothing with no thread live, and a paused thread says nothing on its project", () => {
    expect(projectLead([])).toBeNull();
    expect(projectLead([row({ status: "done" }), row({ status: "paused", paused: true })])).toBeNull();
  });
});

describe("the Projects section's rows", () => {
  const lifeos = [
    { id: "lan", name: "Spring LAN", status: "active", targetDate: new Date(2027, 1, 14).getTime() },
    { id: "budget", name: "FY27 budget", status: "active", targetDate: new Date(2026, 11, 12).getTime() },
    { id: "kit", name: "Club kit", status: "active" },
    { id: "fall", name: "Fall league", status: "paused", targetDate: new Date(2026, 11, 1).getTime() },
    { id: "ideas", name: "Alumni night", status: "backlog" },
  ];

  it("sorts by target date, none last, and folds paused and backlog into the quiet list", () => {
    const groups = lifeos.map((p) => group(project(`lifeos:${p.id}`, p.name, p.id)));
    const { rows, quiet } = workProjectRows(groups, lifeos);
    expect(rows.map((r) => r.name)).toEqual(["FY27 budget", "Spring LAN", "Club kit"]);
    expect(rows[0]).toMatchObject({ id: "lifeos:budget", lifeosProjectId: "budget", target: new Date(2026, 11, 12).getTime(), lead: null });
    expect(quiet.map((r) => r.name)).toEqual(["Fall league", "Alumni night"]);
  });

  it("keeps a paused project with something live in the list, and names a mirror as LifeOS does", () => {
    const groups = [
      group(project("m-fall", "Fall league (old name)", "fall"), [row({ status: "waiting", needsYou: true })]),
      group(project("m-lan", "Spring LAN", "lan"), [row({ workOutcome: { words: "1 mail to send", tone: "held" } })]),
    ];
    const { rows, quiet } = workProjectRows(groups, lifeos);
    expect(rows.map((r) => [r.name, r.lead])).toEqual([
      ["Fall league", { kind: "state", state: "waiting" }],
      ["Spring LAN", { kind: "held" }],
    ]);
    expect(quiet).toEqual([]);
  });

  it("lists a project LifeOS no longer lists (a finished mirror with live threads, a local project) with no target", () => {
    const { rows } = workProjectRows([group(project("p-local", "Notes"))], lifeos);
    expect(rows).toEqual([{ id: "p-local", lifeosProjectId: null, name: "Notes", lead: null, target: null }]);
  });
});

describe("the Threads section's rows", () => {
  it("lists every root of the job, loose and in projects (an archived project's too), newest first, each with its project's name", () => {
    const groups: WorkspaceSessionGroups = {
      chats: [row({ id: "loose", updatedAt: 3 })],
      projects: [group(project("m-lan", "Spring LAN", "lan"), [row({ id: "lan1", updatedAt: 5 }), row({ id: "lan2", updatedAt: 1 })])],
      archived: [group(project("m-old", "Fall league", "fall"), [row({ id: "old", updatedAt: 4 })])],
    };
    expect(workThreadItems(groups).map((i) => [i.row.id, i.project])).toEqual([
      ["lan1", "Spring LAN"],
      ["old", "Fall league"],
      ["loose", null],
      ["lan2", "Spring LAN"],
    ]);
  });

  it("hands back the cached row itself, so a memoized row skips a push that left it as it was", () => {
    const same = row({ id: "a" });
    const groups: WorkspaceSessionGroups = { chats: [same], projects: [], archived: [] };
    expect(workThreadItems(groups)[0]!.row).toBe(same);
  });

  it("says the project then the outcome on the second line, either alone, or nothing", () => {
    expect(threadLine("Spring LAN", row({ workOutcome: { words: "1 mail to send", tone: "held" } }))).toBe("Spring LAN, 1 mail to send");
    expect(threadLine(null, row({ workOutcome: { words: "Mail sent", tone: "done" } }))).toBe("Mail sent");
    expect(threadLine("Spring LAN", row())).toBe("Spring LAN");
    expect(threadLine(null, row())).toBeNull();
  });

  it("times a row by its day: the clock today, the weekday this week, the date before", () => {
    const now = new Date(2026, 10, 25, 15, 0).getTime();
    expect(threadTime(new Date(2026, 10, 25, 10, 2).getTime(), now)).toMatch(/10:02/);
    expect(threadTime(new Date(2026, 10, 24, 9, 0).getTime(), now)).toBe(new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(2026, 10, 24)));
    expect(threadTime(new Date(2026, 9, 3).getTime(), now)).toBe(new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(2026, 9, 3)));
    expect(threadTime(new Date(2025, 9, 3).getTime(), now)).toContain("2025");
  });
});

describe("a project's target", () => {
  const now = new Date(2026, 10, 25, 15, 0).getTime();
  it("reads as its date, with the year only in another year, and is late once its day has passed", () => {
    expect(targetWords(new Date(2026, 11, 12).getTime(), now)).toEqual({ words: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(2026, 11, 12)), late: false });
    expect(targetWords(new Date(2026, 10, 25).getTime(), now).late).toBe(false);
    expect(targetWords(new Date(2026, 10, 24).getTime(), now).late).toBe(true);
    expect(targetWords(new Date(2027, 1, 14).getTime(), now).words).toContain("2027");
  });
});

describe("the archived list of a job or of Work Chats", () => {
  const workspaces = [{ id: "w-job", name: "Purdue Esports", path: "/w/Purdue Esports", kind: "work" }] as WorkspaceMeta[];
  const projects = [project("m-lan", "Spring LAN", "lan")];
  const meta = (over: Partial<SessionMeta>): SessionMeta => ({ id: "x", title: "T", status: "idle", updatedAt: 1, createdAt: 1, cwd: "/w/Purdue Esports", environmentId: "local", scope: "work", archived: true, ...over }) as SessionMeta;
  const metas = [
    meta({ id: "loose", workspaceId: "w-job", updatedAt: 2 }),
    meta({ id: "filed", projectId: "m-lan", updatedAt: 3 }),
    meta({ id: "chat", cwd: "~", updatedAt: 1 }),
    meta({ id: "live", workspaceId: "w-job", archived: false }),
    meta({ id: "kid", workspaceId: "w-job", parentId: "loose" }),
  ];

  it("holds the job's archived roots, loose and in projects, freshest first", () => {
    expect(archivedThreads(metas, "w-job", projects, workspaces).map((t) => t.id)).toEqual(["filed", "loose"]);
  });

  it("holds Work Chats' own for Work Chats", () => {
    expect(archivedThreads(metas, WORK_CHATS, projects, workspaces).map((t) => t.id)).toEqual(["chat"]);
  });
});
