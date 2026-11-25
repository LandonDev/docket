// A preview page for `bun run ui:preview src/renderer/src/work/shell/WorkRail.preview.tsx#WorkRailPreview --props '{"state":"waiting"}'`:
// the rail with Work on (chrome/ProjectRail.tsx): Workspaces, then the Work heading with its search mark and its +,
// Today, Projects, Review and Work Chats, the Work workspaces led by their sectors' dots (one with a long name), and
// the Outbox row. States: `waiting` (the Outbox with a count), `failed` (its failed mark) and `quiet` (nothing
// waits). `#WorkColumnPreview` draws a Work job's whole column (docs/DESIGN.md "The column"): its four daily views
// and More, its Projects (a working one, a held one, one past its target, one paused), its Threads on two lines and
// the archived row. Rendered by nothing in the app.
import { useState } from "react";
import { ProjectRail } from "../../chrome/ProjectRail";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { sessionStore } from "../../lib/tcserver/store";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { setWorkOn } from "../../lib/workSwitch";
import { virtualChunk, workShellChunk } from "../../surfaces/chunks";
import { answerAs, asGivenComputer, JOB, Unsettled } from "../kit.preview";
import WorkspaceSessions from "../../chrome/WorkspaceSessions";
import type { ProjectMeta, SessionMeta } from "../../lib/tcserver/types";
import { WORK_VIEWS } from "../views/registry";
import { FakeConvex, fakeSession } from "../today/fakeLifeos";
import { WorkColumnHead } from "./WorkColumn";

type State = "waiting" | "failed" | "quiet";

const CODE = { id: "w-code", name: "temp-code", path: "/r/temp-code", git: true, createdAt: 1, environmentId: "local" } as WorkspaceMeta;
const WORK: WorkspaceMeta[] = [
  { ...JOB, path: "/w/Work/Purdue Esports", git: false, createdAt: 2 } as WorkspaceMeta,
  { id: "w-ref", name: "Refereeing", path: "/w/Work/Refereeing", git: false, createdAt: 3, kind: "work", sector: "ref", environmentId: "local" } as WorkspaceMeta,
  { id: "w-long", name: "Purdue Esports Club Operations", path: "/w/Work/Purdue Esports Club Operations", git: false, createdAt: 4, kind: "work", sector: "purdue", environmentId: "local" } as WorkspaceMeta,
];

await workShellChunk.load();

let ready = false;

export function WorkRailPreview({ state = "waiting" }: { state?: State }) {
  if (!ready) {
    ready = true;
    const all = [CODE, ...WORK];
    const link = answerAs((method, params) => {
      if (method === "workspace.list") return all;
      if (method === "project.list" || method === "session.list") return [];
      // The Outbox's own reads, which set the row's count and its failed mark: three wait, one of them failed.
      if (method === "work.outbox.list") return params.show === "waiting" ? { items: state === "failed" ? [{ state: "failed" }] : [], waiting: state === "quiet" ? 0 : 3 } : { items: [] };
      if (method === "work.outbox.grants") return { grants: [] };
      if (method === "work.outbox.offers") return { offers: [] };
      throw new Error(`no ${method}`);
    });
    asGivenComputer({ on: [], computers: [{ id: "local", name: "The box", platform: "linux" }] });
    workspaceStore.reset();
    workspaceStore.attach(link);
    sessionStore.reset();
    sessionStore.attach(link);
    setWorkOn("local", true);
  }
  const none = (): void => undefined;
  return (
    <div className="flex w-full overflow-hidden rounded-lg border border-border bg-sidebar" style={{ maxWidth: 201, height: 800 }}>
      <ProjectRail cwd="~" recents={[CODE, ...WORK].map((w, i) => ({ path: w.path, openedAt: 10 - i }))} onSelectProject={none} onOpenProject={none} onOpenChats={none} onOpenWorkChats={none} onOpenNotes={none} onOpenAccountsPage={none} onOpenOutbox={none} />
      <Unsettled />
    </div>
  );
}

let column = false;

const DAY = 86_400_000;
const today = new Date().setHours(0, 0, 0, 0);
const at = (days: number, hour = 9, minute = 0): number => today + days * DAY + (hour * 60 + minute) * 60_000;

/** The job's LifeOS projects: two under way with targets, one with none, one paused. */
const LIFEOS_PROJECTS = [
  { _id: "lan", name: "Spring LAN", sector: "purdue", status: "active", targetDate: at(81, 0), _creationTime: 2 },
  { _id: "budget", name: "FY27 budget", sector: "purdue", status: "active", targetDate: at(17, 0), _creationTime: 1 },
  { _id: "kit", name: "Club kit order", sector: "purdue", status: "active", targetDate: at(-3, 0), _creationTime: 3 },
  { _id: "fall", name: "Fall league", sector: "purdue", status: "paused", _creationTime: 0 },
];
const MIRRORS: ProjectMeta[] = [
  { id: "m-lan", workspaceId: JOB.id, name: "Spring LAN", mode: "local", branch: null, cwd: JOB.path, archived: false, createdAt: 2, lifeosProjectId: "lan", environmentId: "local" },
  { id: "m-budget", workspaceId: JOB.id, name: "FY27 budget", mode: "local", branch: null, cwd: JOB.path, archived: false, createdAt: 1, lifeosProjectId: "budget", environmentId: "local" },
];
const thread = (over: Partial<SessionMeta>): SessionMeta =>
  ({ id: "t", title: "", status: "idle", threadType: "chat", provider: "claude", cwd: JOB.path, scope: "work", createdAt: at(-2), updatedAt: at(-2), archived: false, ...over }) as SessionMeta;
const THREADS: SessionMeta[] = [
  thread({ id: "t-itap", title: "Ask ITaP for two more switches", projectId: "m-lan", updatedAt: at(0, 10, 2), workOutcome: { words: "1 mail to send", tone: "held" } }),
  thread({ id: "t-travel", title: "Fill the travel lines", projectId: "m-budget", status: "running", busySince: at(0, 11), updatedAt: at(0, 11, 4), workOutcome: { words: "Editing Budget FY27.xlsx", tone: "working" } }),
  thread({ id: "t-seat", title: "Seat map for 64", projectId: "m-lan", updatedAt: at(0, 9, 35), workOutcome: { words: "Made Seat map.xlsx", tone: "made" } }),
  thread({ id: "t-dana", title: "Reply to Dana about the venue", workspaceId: JOB.id, updatedAt: at(-1, 16, 20), workOutcome: { words: "Mail sent", tone: "done" } }),
  thread({ id: "t-notes", title: "Notes from the staff meeting", workspaceId: JOB.id, updatedAt: at(-6, 14) }),
];
const ARCHIVED: SessionMeta[] = [1, 2, 3].map((n) => thread({ id: `t-old${n}`, title: `Old thread ${n}`, workspaceId: JOB.id, archived: true, updatedAt: at(-20 - n) }));

/** A Work job's whole column: its views with their facts, More, its Projects, its Threads and its archived row. */
export function WorkColumnPreview() {
  if (!column) {
    column = true;
    // The rows in flow, as before the virtualizer lands: a still page has no viewport for it to measure.
    Object.assign(virtualChunk, { loaded: () => null, load: () => new Promise(() => {}) });
    for (const view of Object.values(WORK_VIEWS)) void view.chunk.load();
    const link = answerAs((method, params) => {
      if (method === "workspace.list") return [{ ...JOB, path: JOB.path, git: false } as WorkspaceMeta];
      if (method === "project.list") return MIRRORS;
      if (method === "session.list") return params.archived ? ARCHIVED : THREADS;
      if (method === "session.changes") return { reset: false, seq: 0, generation: "g", sessions: [], removed: [] };
      throw new Error(`no ${method}`);
    });
    workspaceStore.reset();
    workspaceStore.attach(link);
    sessionStore.reset();
    sessionStore.attach(link);
    setWorkOn("local", true);
    const convex = new FakeConvex();
    for (const [name, value] of Object.entries({ "projects:list": LIFEOS_PROJECTS, "tasks:list": [], "events:range": [], "mail:list": [], "chats:list": [] })) convex.answer(name, value);
    fakeSession("local", convex, JOB.sector);
  }
  const none = (): void => undefined;
  // The sidebar's scroller, as Sidebar.tsx hands it: the list attaches to it the render it arrives.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setScroller} className="w-full overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-sidebar" style={{ maxWidth: 260, height: 760 }}>
      <WorkColumnHead workspace={JOB as WorkspaceMeta} />
      <WorkspaceSessions workspaceId={JOB.id} selectedProjectId={null} activeSessionId="t-seat" onSelectProject={none} onOpenSession={none} onNewChat={none} onNewProject={none} onRenameSession={none} onDeleteSession={none} scroller={scroller} />
      <Unsettled ms={900} />
    </div>
  );
}
