import { ChevronRight } from "./icons";
import { SectorDot } from "./WorkspaceGlyph";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import { openWorkView } from "../lib/workSwitch";

/**
 * Where a Work thread files, before its title in the title bar (docs/DESIGN.md
 * "A thread's head"): the job's dot, then its project (a press opens the
 * project's page) or, loose in the job, the job's name, then a chevron. A Work
 * Chat files in no job and has none: its title stands alone.
 */
export function WorkCrumb({ thread }: { thread: { projectId?: string | null; workspaceId?: string | null; environmentId?: string } }) {
  const catalog = useWorkspaceCatalog();
  const project = thread.projectId ? catalog.projects.find((p) => p.id === thread.projectId && (!thread.environmentId || p.environmentId === thread.environmentId)) : undefined;
  const workspaceId = project?.workspaceId ?? thread.workspaceId;
  const workspace = workspaceId ? catalog.workspaces.find((w) => w.id === workspaceId && (!thread.environmentId || w.environmentId === thread.environmentId)) : undefined;
  if (!workspace) return null;
  const lifeos = project?.lifeosProjectId;
  const name = project?.name ?? workspace.name;
  return (
    <span data-work-crumb className="flex min-w-0 shrink items-center gap-1 ps-3 text-[13px] leading-5 text-muted-foreground">
      <SectorDot sector={workspace.sector} className="size-3" />
      {lifeos ? (
        <button
          type="button"
          data-tauri-drag-region="false"
          onClick={() => openWorkView({ workspaceId: workspace.id, view: "projects", project: lifeos })}
          className="min-w-0 truncate rounded-sm focus-ring hover:text-foreground"
        >
          {name}
        </button>
      ) : (
        <span className="min-w-0 truncate">{name}</span>
      )}
      <ChevronRight aria-hidden className="size-3 shrink-0" />
    </span>
  );
}
