// A preview page for `bun run ui:preview src/renderer/src/work/shell/WorkRail.preview.tsx#WorkRailPreview --props '{"state":"waiting"}'`:
// the rail with Work on (chrome/ProjectRail.tsx): Workspaces, then the Work heading with its search mark and its +,
// the Work workspaces led by their sectors' dots (one with a long name), Work Chats and the Outbox row. States:
// `waiting` (the Outbox with a count), `failed` (its failed mark) and `quiet` (nothing waits). `#WorkColumnPreview`
// draws a Work workspace's column head: its views, each with its fact. Rendered by nothing in the app.
import { ProjectRail } from "../../chrome/ProjectRail";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { sessionStore } from "../../lib/tcserver/store";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { setWorkOn } from "../../lib/workSwitch";
import { workShellChunk } from "../../surfaces/chunks";
import { answerAs, asGivenComputer, JOB, standUpView, Unsettled } from "../kit.preview";
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

/** A Work workspace's column head: its views (Mail, Tasks, Agenda, …), each with the fact it keeps beside its name. */
export function WorkColumnPreview() {
  if (!column) {
    column = true;
    standUpView("tasks", { "projects:list": [{ _id: "p1", name: "Spring LAN", sector: "purdue" }], "tasks:list": [], "events:range": [] });
  }
  return (
    <div className="w-full overflow-hidden rounded-lg border border-border bg-sidebar" style={{ maxWidth: 280 }}>
      <WorkColumnHead workspace={JOB as WorkspaceMeta} />
      <Unsettled />
    </div>
  );
}
