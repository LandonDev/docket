import type { ContextChip, SectorKey } from "@shared/work";
import type { TasksDone } from "@shared/contract-work-tasks";
import { useCallback, useEffect, useMemo, useReducer, useSyncExternalStore } from "react";
import type { ProjectMadeFile, RecordMade } from "@shared/work/threadRecord";
import type { TrackerThread } from "@shared/work/tracker";
import type { MenuRow, Project, ProjectFileEntry, ProjectFiles, ProjectItem, ProjectLogEntry, ProjectsKit, ProjectTask, ProjectThreadFact } from "work-kit/projects";
import { MessageSquare, Settings } from "../../chrome/icons";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { Tip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { keyCaps, keyHint } from "../../lib/keys";
import { workErrorWords } from "../../lib/workErrorWords";
import { openUrl } from "../../lib/native";
import { rowState } from "../../lib/sidebarRows";
import { useSessionMetaValue } from "../../lib/tcserver/store";
import type { ProjectMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { marksAtRest } from "../../lib/threadStripModel";
import { workOpenPort } from "../../lib/workSwitch";
import { registry } from "../../lib/connection";
import { resultsHostStamp, resultsMoves, subscribeResults } from "../outbox/results";
import { Face as PersonFace } from "../mail/face";
import { openLifeosProject } from "../shell/actions";
import { Doc, File, Link, Share, Table } from "../icons";
import { openInFiles } from "../files/openFrom";
import { useLinkedThreads } from "../tasks/links";
import { hasOutcomeMark, OutcomeMark } from "../threads/mark";
import { leadOf, type ProjectMirror, useProjectMirrors, useProjectRoots } from "../threads/roots";
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
  /** The Share sheet on the LifeOS project: its guest links, and New guest link… (view only). */
  share(project: Project): void;
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

const failed = (error: unknown): void => toast({ message: workErrorWords(error) || "Couldn't open it", state: "error" });

/** A person or an agent as Work's one face (`Face`): 16px on a line, 20px in a row's bar. */
const Face: ProjectsKit["Face"] = ({ name, size, className }) => <PersonFace name={name} size={size === 16 ? "line" : "bar"} className={className} />;

const SECTOR_NAMES: Record<string, string> = { cosmic: "Cosmic", hypixel: "Hypixel", purdue: "Purdue", ref: "Ref", unify: "Unify", life: "Life" };

/** A job's name (docs/DESIGN.md "One name a thing"): its Work workspace's, as the rail and the tracker say it; the sector's own word only while the catalog has no workspace for it. */
export const jobName = (workspace: Pick<WorkspaceMeta, "name" | "sector"> | undefined, sector: string): string =>
  (workspace?.sector === sector && workspace.name.trim()) || SECTOR_NAMES[sector] || sector;

/** A sector's mark with its job's name, for the screens of one workspace. The screens hold one sector, so a bare dot is drawn nowhere (docs/DESIGN.md: only where sectors mix). */
const sectorMarkIn = (workspaceId: string): ProjectsKit["SectorMark"] =>
  function SectorMark({ sector, label = true, className }) {
    const workspace = useSyncExternalStore(workspaceStore.subscribe, () => workspaceStore.workspace(workspaceId), () => workspaceStore.workspace(workspaceId));
    return label ? (
      <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}>
        <SectorDot sector={sector} />
        {jobName(workspace, sector)}
      </span>
    ) : null;
  };

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

/** What a press on a thing in a project's Files opens (docs/agents/work-projects.md "Files"). */
export function openItemIn(workspaceId: string, item: ProjectItem, project: Pick<Project, "id" | "name">): void {
  const label = item.title.slice(0, 500);
  switch (item.kind) {
    // A LifeOS document opens here, in the editor, with the way back to its project.
    case "doc":
      return openDoc(workspaceId, { source: { at: "lifeos", table: "docs", id: item.id }, project: { id: project.id, name: project.name } });
    // A sheet, a note and any other source open beside a thread: the press starts one with the item in it,
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

/** One thread on a task: its mark (what it left him, else its state at rest), its title and outcome in the tip, a press opening it. */
function ThreadMark({ sessionId, task, alone }: { sessionId: string; task: ProjectTask; alone: boolean }) {
  const status = useSessionMetaValue(sessionId, (meta) => meta.status);
  const tone = useSessionMetaValue(sessionId, (meta) => meta.workOutcome?.tone ?? null);
  const words = useSessionMetaValue(sessionId, (meta) => meta.workOutcome?.words ?? null);
  const title = useSessionMetaValue(sessionId, (meta) => meta.title) ?? "";
  // A thread this window does not hold (another host's not attached, a deleted one) has no mark to press.
  if (status === undefined) return null;
  const state = rowState({ status });
  const mark = hasOutcomeMark(tone) ? <OutcomeMark tone={tone} /> : marksAtRest(state) ? <StatusMark state={state} word={false} /> : <MessageSquare />;
  return (
    <Tip label={[title, words].filter(Boolean).join(": ") || "Open thread"}>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={alone ? `Open the thread on ${task.title}` : `Open ${title || "the thread"}`} data-task-thread={tone ?? state} onClick={() => openThread(sessionId)}>
        {mark}
      </Button>
    </Tip>
  );
}

/** The threads on a task (the kit's `taskMark`): every open link's mark, newest first, each opening its thread. */
function TaskThreads({ task }: { task: ProjectTask }) {
  const threads = useLinkedThreads(task.id);
  if (!threads.length) return null;
  return (
    <span className="flex items-center" data-task-threads={threads.length}>
      {threads.map((id) => (
        <ThreadMark key={id} sessionId={id} task={task} alone={threads.length === 1} />
      ))}
    </span>
  );
}

/** A thread opened from a project's screens: the window follows it to its place. */
const openThread = (sessionId: string): void => workOpenPort.get()?.(sessionId);

/**
 * The kit's `threadFacts` (a hook): each project's most pressing root thread, its mark and its outcome in words,
 * opening it, from the summaries this window holds. A project whose lead has no outcome to say has no entry.
 */
export function useThreadFacts(sector: SectorKey): ReadonlyMap<string, ProjectThreadFact> {
  const roots = useProjectRoots(sector);
  return useMemo(() => {
    const facts = new Map<string, ProjectThreadFact>();
    for (const [projectId, threads] of roots) {
      const lead = leadOf(threads);
      if (lead?.outcome) facts.set(projectId, { mark: <OutcomeMark tone={lead.outcome.tone} />, words: lead.outcome.words, title: lead.title, open: () => openThread(lead.sessionId) });
    }
    return facts;
  }, [roots]);
}

/** The kit's `log` (a hook): the project's root threads with what each left him, newest first, each opening its thread. */
export function useThreadLog(project: Pick<Project, "id" | "sector">): readonly ProjectLogEntry[] {
  const threads = useProjectRoots(project.sector).get(project.id);
  return useMemo(
    () =>
      (threads ?? NO_THREADS).map((t) => ({
        id: t.sessionId,
        at: t.updatedAt,
        ...(hasOutcomeMark(t.outcome?.tone) ? { mark: <OutcomeMark tone={t.outcome!.tone} /> } : {}),
        title: t.title,
        // A made outcome is said by Files, which names each thing and its thread (docs/DESIGN.md: no fact twice).
        ...(t.outcome && t.outcome.tone !== "made" ? { detail: t.outcome.words } : {}),
        open: () => openThread(t.sessionId),
      })),
    [threads],
  );
}

const NO_THREADS: TrackerThread[] = [];
const NO_MIRRORS: ProjectMirror[] = [];

/** What a project mirror's threads made or changed, as its host keeps it (`work.projects.files`): one ask a host. */
export function readProjectFiles(environmentId: string, mirrorId: string): Promise<{ files: ProjectMadeFile[] }> {
  return registry.linkOf(environmentId).request<{ files: ProjectMadeFile[] }>("work.projects.files", { mirrorId });
}

/** A project's mirror on a host, with how far that host's Results moved: the answer stands while that does. */
type Mirror = ProjectMirror & { stamp: string };

/**
 * The project's mirrors with their stamps: every mirror the catalog lists, whether or not a live thread sits in it (an
 * archived thread's files are still the project's). Any Result made or undone on a host moves its stamp, an archived
 * root's too. Pure but for the stamp, which a test can hand.
 */
export function mirrorsOf(at: readonly ProjectMirror[], moved: (env: string) => string = resultsHostStamp): Mirror[] {
  return at.map((m) => ({ ...m, stamp: moved(m.env) }));
}

/** Each mirror's last answer, kept for the window's life by host and mirror. A failed read keeps the last answer, so its rows stand. */
const filesKept = new Map<string, { stamp: string; files: readonly ProjectMadeFile[] }>();
/** The mirrors whose newest read failed: Files says so once, with Retry. */
const filesFailed = new Set<string>();
/** Nothing kept (tests). */
export const resetProjectFiles = (): void => {
  filesKept.clear();
  filesFailed.clear();
};

/** What the project's threads made, by host; whether a host has not answered yet (Files holds "No files yet") or its newest read failed (Files' Retry line). */
export type MadeFiles = { made: readonly { env: string; file: ProjectMadeFile }[]; pending: boolean; failed: boolean; retry: () => void };

/**
 * What the project's threads made, by host: one ask a mirror whose host's Results moved, each host's rows landing as
 * it answers, its last answer drawn meanwhile. A host that refuses (a release behind, a dropped link) keeps the rows it
 * last gave; the page says once that some did not load, and Retry asks the hosts that failed again.
 */
export function useMadeFiles(at: readonly ProjectMirror[] | undefined, read = readProjectFiles): MadeFiles {
  const moves = useSyncExternalStore(subscribeResults, resultsMoves, resultsMoves);
  const mirrors = useMemo(() => {
    void moves;
    return mirrorsOf(at ?? NO_MIRRORS);
  }, [at, moves]);
  const [landed, land] = useReducer((n: number) => n + 1, 0);
  const [tries, again] = useReducer((n: number) => n + 1, 0);
  // The line goes while Retry's reads are out, and comes back only if one fails again.
  const retry = useCallback(() => {
    for (const m of mirrors) filesFailed.delete(`${m.env}|${m.mirrorId}`);
    again();
  }, [mirrors]);
  useEffect(() => {
    void tries;
    let live = true;
    for (const m of mirrors) {
      const id = `${m.env}|${m.mirrorId}`;
      if (filesKept.get(id)?.stamp === m.stamp) continue;
      read(m.env, m.mirrorId).then(
        (answer) => {
          filesKept.set(id, { stamp: m.stamp, files: answer.files });
          filesFailed.delete(id);
          if (live) land();
        },
        () => {
          filesFailed.add(id);
          if (live) land();
        },
      );
    }
    return () => {
      live = false;
    };
  }, [mirrors, read, tries]);
  // `landed` is the clock of what the kept map holds: a host's answer, or a Retry, draws the rows again.
  return useMemo(() => {
    void landed;
    void tries;
    return {
      made: mirrors.flatMap((m) => (filesKept.get(`${m.env}|${m.mirrorId}`)?.files ?? []).map((file) => ({ env: m.env, file }))),
      pending: mirrors.some((m) => !filesKept.has(`${m.env}|${m.mirrorId}`) && !filesFailed.has(`${m.env}|${m.mirrorId}`)),
      failed: mirrors.some((m) => filesFailed.has(`${m.env}|${m.mirrorId}`)),
      retry,
    };
  }, [mirrors, landed, tries, retry]);
}

/** Where a made thing opens from a project's Files: a Files tab of its job, a page on the web, or else its thread. */
function openMade(made: RecordMade, env: string): () => void {
  const open = made.open;
  if (open?.at === "files") return () => void openInFiles({ id: open.workspaceId, environmentId: env }, { ref: open.ref, name: open.name }).catch(failed);
  if (open?.at === "url") return () => void openUrl(open.url).catch(failed);
  return () => openThread(made.sessionId);
}

/**
 * The project's Files rows from what each host's threads made: one row a thing, at its newest write. A host names a
 * thing by its source (`key`); a LifeOS item is one thing whichever host linked it. Two files of one name stay two.
 */
export function fileRows(made: readonly { env: string; file: ProjectMadeFile }[], titleOf: (rootId: string) => string | undefined): ProjectFileEntry[] {
  const seen = new Set<string>();
  const rows: ProjectFileEntry[] = [];
  for (const { env, file } of [...made].sort((a, b) => b.file.at - a.file.at)) {
    const key = file.itemId ? `item:${file.itemId}` : `${env}|${file.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: `${env}|${file.id}`,
      ...(file.itemId ? { itemId: file.itemId } : {}),
      name: file.name,
      kind: file.open?.at === "url" ? "link" : "file",
      by: `${file.verb} by ${titleOf(file.rootId) ?? file.rootTitle ?? "a thread"}`,
      at: file.at,
      open: openMade(file, env),
    });
  }
  return rows;
}

/**
 * The kit's `files` (a hook): the files the project's threads made or changed, archived threads' too, with which thread
 * and when; Open goes to Files. While a host has not answered, the kit holds "No files yet"; a failed read is its one
 * quiet line with Retry.
 */
export function useThreadFiles(project: Pick<Project, "id" | "sector">): ProjectFiles {
  const threads = useProjectRoots(project.sector).get(project.id);
  const mirrors = useProjectMirrors(project.sector).get(project.id);
  const { made, pending, failed, retry } = useMadeFiles(mirrors);
  return useMemo(() => {
    const titleOf = new Map((threads ?? NO_THREADS).map((t) => [t.sessionId, t.title]));
    return { entries: fileRows(made, (root) => titleOf.get(root)), pending, ...(failed ? { failed: { retry } } : {}) };
  }, [made, pending, failed, retry, threads]);
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
 * The rows TempCode adds to Files' add menu, before the kit's own Add
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

/**
 * The projects client with Done going through the host (`work.tasks.done`), as Tasks and Today's Done do: a task a
 * thread here worked completes with the thread's reason and link. Each sub-task closing with it is credited the same.
 */
export function withHostDone<C extends { completeTask(id: string, options?: { children?: readonly string[] }): Promise<void> }>(client: C, env: string, workspaceId: string): C {
  return {
    ...client,
    completeTask: async (id, options) => {
      await Promise.all([id, ...(options?.children ?? [])].map((taskId) => registry.linkOf(env).request<TasksDone>("work.tasks.done", { workspaceId, taskId })));
    },
  };
}

const kits = new Map<string, ProjectsKit>();

/** The kit for a workspace on its host: made once, the same object from then on. */
export function projectsKitFor(env: string, workspaceId: string): ProjectsKit {
  const key = `${env}|${workspaceId}`;
  let kit = kits.get(key);
  if (kit) return kit;
  kit = {
    SectorMark: sectorMarkIn(workspaceId),
    Face,
    Hint,
    toast,
    keyCaps: (chord) => keyCaps(chord),
    Document: ({ docId, readOnly, lead }) => <Description env={env} docId={docId} readOnly={readOnly} lead={lead} />,
    openItem: (item, project) => openItemIn(workspaceId, item, project),
    Bar,
    // The view header's own buttons (docs/DESIGN.md): quiet, 28px, as Tasks' New task and Docs' New are.
    verbs: { primary: "ghost", size: "sm" },
    taskMark: TaskThreads,
    // The thread record's three feeds (docs/agents/work-tracker.md "The slots"): hooks, the same functions for the kit's life.
    log: useThreadLog,
    files: useThreadFiles,
    threadFacts: useThreadFacts,
    threads: {
      Mark: TaskThreads,
      newThread: (project) => void startIn(workspaceId, project, projectChip(project)),
      startThread: (task, project) => void startIn(workspaceId, project, taskChip(task)),
    },
    menuLead: (task) => [{ id: "code-thread", label: "Open a code thread…", run: () => hostOf(workspaceId).codeThread(task) }],
    addItems: (project) => addRows(env, workspaceId, project),
    // A project's ⋯ holds Share… (its guest links, view only) and its settings (name, state, target, rules, accounts), beside Board and Delete.
    projectMenu: (project) => [
      { id: "share", label: "Share…", icon: Share, run: () => hostOf(workspaceId).share(project) },
      { id: "settings", label: "Project settings…", icon: Settings, run: () => void settingsOf(workspaceId, project) },
    ],
  };
  kits.set(key, kit);
  return kit;
}
