import type { ContextChip, SectorKey } from "@shared/work";
import type { MenuRow, Project, ProjectItem, ProjectsKit, ProjectTask } from "work-kit/projects";
import { MessageSquare, Settings } from "../../chrome/icons";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { Tip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { keyCaps, keyHint } from "../../lib/keys";
import { openUrl } from "../../lib/native";
import { rowState } from "../../lib/sidebarRows";
import { useSessionMetaValue } from "../../lib/tcserver/store";
import type { ProjectMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { marksAtRest } from "../../lib/threadStripModel";
import { workOpenPort } from "../../lib/workSwitch";
import { registry } from "../../lib/connection";
import { ProjectShare } from "../guests/Share";
import { openLifeosProject } from "../shell/actions";
import { Doc, File, Link, Table } from "../icons";
import { useLinkedThread } from "../tasks/links";
import type { WorkViewProps } from "../views/registry";
import { Bar } from "./bar";
import { Description } from "./Description";
import type { LinkKind } from "./LinkPicker";
import { openDoc, type OpenedDoc } from "./place";

/**
 * TempCode's side of the shared project screens (work-kit/projects README,
 * "The three seams"): the kit of its own look and manners. One a workspace,
 * kept for the window's life, since the screens read it as a constant; what
 * changes under it (the view's props) is read through `hostOf` at the press.
 */

/** What the kit asks of the view it is mounted in, read at a press: its workspace, how a thread starts there, and the dialogs it holds. */
export interface ProjectsHost {
  workspace: WorkspaceMeta;
  sector: SectorKey;
  startThread: WorkViewProps["startThread"];
  /** Open a code thread… on a task. */
  codeThread(task: ProjectTask): void;
  /** Link a document, or a file or item, to a project: the picker. */
  link(project: Project, kind: LinkKind): void;
  /** A new LifeOS sheet in the project (the view's own session writes it). */
  newSheet(project: Project): Promise<void>;
  /** The Work project's settings sheet, on the project's mirror. */
  settings(mirror: ProjectMeta): void;
}

const hosts = new Map<string, ProjectsHost>();
/** The view tells the kit what it stands in, after each commit: nothing of the kit reads it while the screens render. */
export const setProjectsHost = (host: ProjectsHost): void => void hosts.set(host.workspace.id, host);
const hostOf = (workspaceId: string): ProjectsHost => {
  const host = hosts.get(workspaceId);
  if (!host) throw new Error("The project screens are not mounted in this workspace");
  return host;
};

const toast: ProjectsKit["toast"] = ({ message, state, action }) =>
  void loadToast().then((api) => {
    const options = action ? { action: { label: action.label, onClick: action.run } } : undefined;
    if (state === "error") api.error(message, options);
    else api(message, options);
  });

const failed = (error: unknown): void => toast({ message: error instanceof Error ? error.message : String(error), state: "error" });

const initials = (name: string): string =>
  name
    .replace(/<[^>]*>|["']/g, "")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

/** A person or an agent as initials on `muted` in a circle (docs/DESIGN.md, avatars). */
const Face: ProjectsKit["Face"] = ({ name, size, className }) => (
  <span
    aria-hidden
    className={cn(
      "inline-grid shrink-0 place-items-center rounded-full bg-muted font-semibold text-muted-foreground outline-1 -outline-offset-1 outline-(--image-outline)",
      size === 16 ? "size-4 text-[7px]" : "size-5 text-[8px]",
      className,
    )}
  >
    {initials(name)}
  </span>
);

const SECTOR_NAMES: Record<string, string> = { cosmic: "Cosmic", hypixel: "Hypixel", purdue: "Purdue", ref: "Ref", unify: "Unify", life: "Life" };

/** A sector's mark with its name. The screens hold one sector, so a bare dot is drawn nowhere (docs/DESIGN.md: only where sectors mix). */
const SectorMark: ProjectsKit["SectorMark"] = ({ sector, label = true, className }) =>
  label ? (
    <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}>
      <SectorDot sector={sector} />
      {SECTOR_NAMES[sector] ?? sector}
    </span>
  ) : null;

/** Chords the app's own key layer takes before the screens hear them (lib/appCommands.ts: the sidebar): a tip never names one. */
const APP_CHORDS: ReadonlySet<string> = new Set(["mod+b"]);

/** The chord a tip may name, as this platform writes it; none for one the screens never hear. */
export const hintKeys = (keys: string | undefined): string | undefined => (keys && !APP_CHORDS.has(keys) ? keyHint(keys) : undefined);

const Hint: ProjectsKit["Hint"] = ({ label, keys, children }) => (
  <Tip label={label} shortcut={hintKeys(keys)}>
    {children}
  </Tip>
);

/** The chip a thread about a project starts with. */
export const projectChip = (project: Pick<Project, "id" | "name">): ContextChip => ({ kind: "project", label: project.name.slice(0, 500), ref: { at: "lifeos", table: "projects", id: project.id } });
/** The chip a thread about a task starts with: the task itself, so the host links the thread and Done names it. */
export const taskChip = (task: Pick<ProjectTask, "id" | "title">): ContextChip => ({ kind: "task", label: task.title.slice(0, 500), ref: { at: "lifeos", table: "tasks", id: task.id } });

/**
 * A new thread's composer in the project's own mirror, with the chip in it.
 * The mirror is made at this first ask (`work.project.open`); a refusal (a
 * finished project, LifeOS out of reach) is said and nothing opens.
 */
async function startIn(workspaceId: string, project: Pick<Project, "id" | "name">, chip: ContextChip): Promise<void> {
  const host = hostOf(workspaceId);
  try {
    const mirror = await openLifeosProject(host.workspace, project.id, project.name);
    host.startThread(chip, { cwd: host.workspace.path, projectId: mirror.id });
  } catch (error) {
    failed(error);
  }
}

/** The settings sheet is the mirror's: made at this ask if the project has none yet, a finished project's too (the sheet is where he reopens it); a refusal (LifeOS out of reach) is said. */
async function settingsOf(workspaceId: string, project: Pick<Project, "id" | "name">): Promise<void> {
  const host = hostOf(workspaceId);
  try {
    host.settings(await openLifeosProject(host.workspace, project.id, project.name, true));
  } catch (error) {
    failed(error);
  }
}

/** What a press on a thing in a project's Documents opens (docs/agents/work-projects.md "Documents"). */
export function openItemIn(workspaceId: string, item: ProjectItem, project: Pick<Project, "id" | "name">): void {
  const label = item.title.slice(0, 500);
  switch (item.kind) {
    // A LifeOS document opens here, in the editor, with the way back to its project.
    case "doc":
      return openDoc(workspaceId, { source: { at: "lifeos", table: "docs", id: item.id }, project: { id: project.id, name: project.name } });
    // A sheet, a note and any other source open beside a thread: the press starts one with the item in it, as the Docs view does,
    // in the project's own mirror, where the project's threads live.
    case "sheet":
      return void startIn(workspaceId, project, { kind: "selection", label, ref: { at: "lifeos", table: "sheets", id: item.id } });
    case "note":
      return void startIn(workspaceId, project, { kind: "selection", label, ref: { at: "lifeos", table: "projectDocs", id: item.id } });
    case "link":
    case "file":
      if (item.url) void openUrl(item.url).catch(failed);
      return;
    case "item": {
      const source = item.source as ContextChip["ref"] | undefined;
      if (source && typeof source === "object" && "at" in source) void startIn(workspaceId, project, { kind: "selection", label, ref: source });
      return;
    }
  }
}

function ThreadMark({ task }: { task: ProjectTask }) {
  const thread = useLinkedThread(task.id);
  const status = useSessionMetaValue(thread, (meta) => meta.status);
  // A thread this window does not hold (another host's, a deleted one) has no mark to press.
  if (!thread || status === undefined) return null;
  const state = rowState({ status });
  return (
    <Tip label="Open thread">
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Open the thread on ${task.title}`} data-task-thread={state} onClick={() => workOpenPort.get()?.(thread)}>
        {marksAtRest(state) ? <StatusMark state={state} word={false} /> : <MessageSquare />}
      </Button>
    </Tip>
  );
}

/** A new LifeOS document in the project, opened in place at once. */
async function newDocument(env: string, workspaceId: string, project: Project): Promise<void> {
  try {
    const made = await registry.linkOf(env).request<{ source: OpenedDoc["source"] }>("work.docs.create", { sector: hostOf(workspaceId).sector, projectId: project.id, title: "Untitled" });
    openDoc(workspaceId, { source: made.source, project: { id: project.id, name: project.name } });
  } catch (error) {
    failed(error);
  }
}

/**
 * The rows TempCode adds to Documents' add menu, before the kit's own Add
 * link: a new document or sheet in the project, a document or sheet LifeOS
 * already has, and a file or item the workspace lists. Each reads the view
 * at the press.
 */
export function addRows(env: string, workspaceId: string, project: Project): MenuRow[] {
  return [
    { id: "new-document", label: "New document", icon: Doc, run: () => void newDocument(env, workspaceId, project) },
    { id: "new-sheet", label: "New sheet", icon: Table, run: () => void hostOf(workspaceId).newSheet(project).catch(failed) },
    { id: "link-document", label: "Link a document or sheet…", icon: Link, run: () => hostOf(workspaceId).link(project, "document") },
    { id: "link-item", label: "Link a file or item…", icon: File, run: () => hostOf(workspaceId).link(project, "item") },
  ];
}

const kits = new Map<string, ProjectsKit>();

/** The kit for a workspace on its host: made once, the same object from then on. */
export function projectsKitFor(env: string, workspaceId: string): ProjectsKit {
  const key = `${env}|${workspaceId}`;
  let kit = kits.get(key);
  if (kit) return kit;
  kit = {
    SectorMark,
    Face,
    Hint,
    toast,
    keyCaps: (chord) => keyCaps(chord),
    Document: ({ docId, readOnly, lead }) => <Description env={env} docId={docId} readOnly={readOnly} lead={lead} />,
    openItem: (item, project) => openItemIn(workspaceId, item, project),
    Bar,
    // The view header's own buttons (docs/DESIGN.md): quiet, 28px, as Tasks' New task and Docs' New are.
    verbs: { primary: "ghost", size: "sm" },
    threads: {
      Mark: ThreadMark,
      newThread: (project) => void startIn(workspaceId, project, projectChip(project)),
      startThread: (task, project) => void startIn(workspaceId, project, taskChip(task)),
    },
    menuLead: (task) => [{ id: "code-thread", label: "Open a code thread…", run: () => hostOf(workspaceId).codeThread(task) }],
    addItems: (project) => addRows(env, workspaceId, project),
    // A project's menu reaches its settings (name, state, rules, accounts, sharing) without leaving the page.
    projectMenu: (project) => [{ id: "settings", label: "Project settings…", icon: Settings, run: () => void settingsOf(workspaceId, project) }],
    // Share on a project's bar: its guest links, and New guest link… (view only).
    share: ({ project }) => <ProjectShare env={env} project={project} />,
  };
  kits.set(key, kit);
  return kit;
}
