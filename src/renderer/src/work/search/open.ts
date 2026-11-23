import type { CanvasSource, ContextChip } from "@shared/work";
import type { SearchHit } from "@shared/work/search";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { requestTranscriptJump } from "../../lib/transcriptJump";
import { openWorkView, workOpenPort, type OpenWorkView } from "../../lib/workSwitch";
import { linkedWorkspaceIds } from "../../lib/linkedRail";
import { project, projectStore } from "../../stores/project";
import { shell } from "../../stores/shell";
import { workspaceByPath } from "../../lib/tcserver/workspaces";
import { openHeld } from "../canvas/held";
import { openInFiles } from "../files/openFrom";
import { startThreadAbout } from "../shell/WorkColumn";
import { tellOpened } from "./hosts";

/**
 * Return on a hit (docs/agents/work-search.md "Opening in place"): the
 * window enters the hit's job when it is in another, the thing opens in its
 * own view, its thread or a Files tab, and the hit's host is told, for
 * Recent. Other screens reach this through a hit, never by import.
 */

export interface OpenDeps {
  workspace(id: string): WorkspaceMeta | undefined;
  /** the workspaces the window is in: the one selected and its copies on other hosts */
  selected(): string[];
  /** move the window to a workspace's folder */
  enter(workspace: WorkspaceMeta): void;
  view(next: OpenWorkView): void;
  thread(sessionId: string, seq?: number): void;
  /** Files' own door (work/files/openFrom.ts): the file in a tab of the job, shown; a refusal is thrown */
  file(workspace: WorkspaceMeta, file: { ref: CanvasSource; name: string }): Promise<void>;
  held(id: string, hostId: string): void;
  startThread(chip: ContextChip, workspace: WorkspaceMeta): void;
  opened(hostId: string, hit: SearchHit): void;
  /** a full-page view (the Inbox, Settings) leaves, so what opens is seen */
  clear(): void;
}

const live: OpenDeps = {
  workspace: (id) => workspaceStore.getSnapshot().workspaces.find((w) => w.id === id),
  selected() {
    const { workspaces } = workspaceStore.getSnapshot();
    const id = workspaceByPath(workspaces, projectStore.getState().projectCwd)?.id ?? null;
    return linkedWorkspaceIds(workspaces, id) ?? [];
  },
  enter: (workspace) => project.enterWorkspace(workspace.path),
  view: (next) => openWorkView(next),
  thread(sessionId, seq) {
    if (seq !== undefined) requestTranscriptJump(sessionId, seq);
    workOpenPort.get()?.(sessionId);
  },
  file: (workspace, file) => openInFiles(workspace, file),
  held: (id, hostId) => openHeld({ at: "host", id }, hostId),
  startThread: (chip, workspace) => startThreadAbout(chip, null, workspace.path),
  opened: tellOpened,
  clear: () => shell.closeViews(),
};

export type Opened = "opened" | "gone" | "failed" | "nothing";

/** The view a chip's thing opens in, as a sent chip's does (work/canvas/SentChips.tsx), on the thing itself. */
function viewOfChip(chip: ContextChip, workspaceId: string): OpenWorkView | null {
  const ref = chip.ref;
  if (ref.at === "work") return ref.pillar === "routines" ? { workspaceId, view: "routines" } : null;
  if (ref.at !== "lifeos") return null;
  if (ref.table === "tasks") return chip.kind === "card" ? { workspaceId, view: "projects", task: ref.id } : { workspaceId, view: "tasks", task: ref.id };
  if (ref.table === "mailThreads") return { workspaceId, view: "mail", mail: ref.id };
  if (ref.table === "events") return { workspaceId, view: "agenda", event: ref.id };
  if (ref.table === "projects") return { workspaceId, view: "projects", project: ref.id };
  if (ref.table === "people") return { workspaceId, view: "people", person: ref.id };
  return null;
}

/** A LifeOS document a hit names, by its chip or by a way into the Docs view: what Files opens it as. */
function docOf(open: SearchHit["open"]): { ref: unknown; name: string } | null {
  if (open.to === "chip" && open.chip.ref.at === "lifeos" && open.chip.ref.table === "docs") return { ref: { at: "lifeos", table: "docs", id: open.chip.ref.id }, name: open.chip.label };
  if (open.to === "view" && open.view === "docs") {
    const doc = (open.with as { doc?: { id: string; title?: string } } | undefined)?.doc;
    if (doc) return { ref: { at: "lifeos", table: "docs", id: doc.id }, name: doc.title || "Untitled" };
  }
  return null;
}

/** Opens a hit in place. `hostId` is the host that found it. */
export async function openHit(hit: SearchHit, hostId: string, over: Partial<OpenDeps> = {}): Promise<Opened> {
  const d = { ...live, ...over };
  const workspace = hit.workspaceId ? d.workspace(hit.workspaceId) : undefined;
  // The job was removed while the list stood: nothing opens, and nothing is kept for Recent.
  if (hit.workspaceId && !workspace) return "gone";
  const open = hit.open;

  if (open.to === "thread") {
    // A thread carries its own place: the window follows it there.
    d.thread(open.sessionId, open.seq);
    d.opened(hostId, hit);
    return "opened";
  }
  if (open.to === "chip" && open.chip.ref.at === "work" && open.chip.ref.pillar === "outbox") {
    d.clear();
    d.held(open.chip.ref.id, hostId);
    d.opened(hostId, hit);
    return "opened";
  }
  if (!workspace) return "nothing";

  // A file, a LifeOS document among them (the Docs view folded into Files), and a hit a host a release behind
  // still sends to Docs: Files' own door.
  const file = open.to === "file" ? { ref: open.ref, name: open.name } : docOf(open);
  let view: OpenWorkView | null;
  if (file) {
    // The file opens as a Files tab of the job on the job's host, the tab shown; the window then moves there as for any view.
    try {
      await d.file(workspace, { ref: file.ref as CanvasSource, name: file.name });
    } catch {
      return "failed";
    }
    view = { workspaceId: workspace.id, view: "files" };
  } else if (open.to === "view") view = { workspaceId: workspace.id, view: open.view, ...(open.with ?? {}) } as OpenWorkView;
  else if (open.to === "chip") view = viewOfChip(open.chip, workspace.id);
  else view = null;
  if (!view) return "nothing";
  d.clear();
  // A view shows only while its workspace is the window's (WorkViewSurface): the window moves first.
  if (!d.selected().includes(workspace.id)) d.enter(workspace);
  d.view(view);
  d.opened(hostId, hit);
  return "opened";
}

/** ⌘↩: a new thread in the hit's job with the thing as its chip. False when the kind is no chip, or the hit is in no job. */
export function startAbout(hit: SearchHit, over: Partial<OpenDeps> = {}): boolean {
  const d = { ...live, ...over };
  const workspace = hit.workspaceId ? d.workspace(hit.workspaceId) : undefined;
  if (!hit.chip || !workspace) return false;
  d.clear();
  d.startThread(hit.chip, workspace);
  return true;
}

/** Whether ⌘↩ has something to do for a hit. */
export const canStartAbout = (hit: SearchHit): boolean => !!hit.chip && hit.workspaceId !== null;
