// A preview page for `bun run ui:preview src/renderer/src/chrome/WorkCrumb.preview.tsx#WorkHeadPreview`: a Work
// thread's title bar (docs/DESIGN.md "A thread's head") three ways: a chat in a project, a research thread loose in
// its job, and a Work Chat. Rendered by nothing in the app.
import { workspaceStore } from "../lib/tcserver/workspaces";
import type { ProjectMeta, ThreadType, WorkspaceMeta } from "../lib/tcserver/types";
import { answerAs, JOB, Unsettled } from "../work/kit.preview";
import { ThreadHeaderStrip, type StripChip } from "./ThreadHeaderStrip";
import { WorkCrumb } from "./WorkCrumb";

const MIRROR = { id: "m-lan", workspaceId: JOB.id, name: "Spring LAN", mode: "local", branch: null, cwd: JOB.path, archived: false, createdAt: 2, lifeosProjectId: "lan", environmentId: "local" } as ProjectMeta;

let ready = false;

const chip = (id: string, title: string, threadType: ThreadType): StripChip => ({
  id,
  tabId: `tab-${id}`,
  live: true,
  status: "idle",
  unread: false,
  updatedAt: 0,
  thread: { id, title, status: "idle", updatedAt: 0, projectId: null, parentId: null, archived: false, threadType },
});

const fn = (): void => undefined;

function Bar({ heading, thread }: { heading: StripChip; thread: { projectId?: string | null; workspaceId?: string | null } }) {
  return (
    <div className="bg-sidebar">
      <ThreadHeaderStrip
        model={{ activeId: heading.id, live: [], dormant: [], list: [], heading }}
        crumb={<WorkCrumb thread={{ ...thread, environmentId: "local" }} type={heading.thread.threadType} />}
        stripRef={fn}
        activeRef={fn}
        onSelect={fn}
        planReady={{}}
        renamingId={null}
        onStartRename={fn}
        onRename={fn}
      />
    </div>
  );
}

export function WorkHeadPreview() {
  if (!ready) {
    ready = true;
    const link = answerAs((method) => {
      if (method === "workspace.list") return [{ ...JOB, git: false } as WorkspaceMeta];
      if (method === "project.list") return [MIRROR];
      if (method === "session.list") return [];
      throw new Error(`no ${method}`);
    });
    workspaceStore.reset();
    workspaceStore.attach(link);
  }
  return (
    <div className="flex w-full max-w-xl flex-col gap-2">
      <Bar heading={chip("a", "Ask ITaP for two more switches", "chat")} thread={{ projectId: MIRROR.id }} />
      <Bar heading={chip("b", "Venues that seat 200 near campus", "research")} thread={{ workspaceId: JOB.id }} />
      <Bar heading={chip("c", "A gift for Sam", "chat")} thread={{}} />
      <Unsettled />
    </div>
  );
}
