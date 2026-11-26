import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionMeta, WireSessionMeta } from "../../lib/tcserver/types";
import type { SessionPage } from "@shared/wire";
import { DeleteThreadDialog } from "../../chrome/DeleteThreadDialog";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import { RemoveProjectDialog } from "../../chrome/RemoveProjectDialog";
import { MoreHorizontal } from "../../chrome/icons";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { LOCAL_ENVIRONMENT_ID, registry, useEnvironments } from "../../lib/connection";
import { prettyCwd, projectName } from "../../lib/paths";
import { loadArchivedProjects, looksLikeProject, subscribeArchivedProjects, type ArchivedProject } from "../../lib/recents";
import { HARNESS_TITLE, sessionDisplayTitle } from "../../lib/session";
import { computerInLine, useComputerNames } from "../../lib/settings/computerName";
import { refusalWords } from "../../lib/settingsHome";
import { NO_ANSWER } from "../../lib/connection/openRead";
import { loadTabGroupLabels, resolveTabGroupLabel } from "../../lib/tabGroups";
import { sessionStore, useSessionMetas } from "../../lib/tcserver/store";
import { useProjects, useWorkspaces, workspaceLabelKey } from "../../lib/tcserver/workspaces";
import { SettingSection } from "./parts/SettingRow";

/**
 * Archive (docs/agents/settings.md "The pages: jobs, workspaces, Archive"): the projects and the threads he archived.
 * The page asks each computer for its archived threads itself (`session.list {archived: true}`, every page of it), so
 * "No archived threads" is true and the search covers every one; each row names its computer. A computer still
 * answering holds the list's shape; one that did not answer says so with Retry, the others' threads still listed.
 */

function useArchivedProjects(): ArchivedProject[] {
  const [items, setItems] = useState(loadArchivedProjects);
  useEffect(() => subscribeArchivedProjects(() => setItems(loadArchivedProjects())), []);
  return items;
}

function useArchivedProjectLabel(): (path: string) => string {
  const workspaces = useWorkspaces();
  return (path) => resolveTabGroupLabel(workspaceLabelKey(workspaces, path, projectName(path)), loadTabGroupLabels(), projectName(path));
}

/** Archived threads render a page at a time: thousands of rows in one mount stalled the page switch. */
const ARCHIVE_PAGE = 100;

type Read = { status: "loading" } | { status: "ready"; metas: SessionMeta[] } | { status: "failed"; error: string };

/** Every archived root thread on one computer, walked page by page where its link pages them. */
async function archivedOn(environmentId: string): Promise<SessionMeta[]> {
  const link = registry.linkOf(environmentId);
  const all: SessionMeta[] = [];
  let cursor: string | null = null;
  for (;;) {
    const answer: WireSessionMeta[] | SessionPage = await link.request<WireSessionMeta[] | SessionPage>("session.list", cursor ? { archived: true, cursor } : { archived: true });
    const page = Array.isArray(answer) ? answer : answer.sessions;
    for (const meta of page) all.push({ ...meta, environmentId });
    cursor = Array.isArray(answer) ? null : answer.cursor;
    if (!cursor) return all;
  }
}

/**
 * Each computer's archived threads, asked of it, with what this window learned since: a thread restored or deleted
 * here leaves the list, one archived since joins it. The session store is asked too, so a restore finds the thread's
 * computer.
 */
function useArchivedThreads(): { threads: SessionMeta[]; reads: Map<string, Read>; retry: (environmentId: string) => void } {
  const environments = useEnvironments();
  const ids = environments.map((e) => e.id).join("\n");
  const [reads, setReads] = useState<Map<string, Read>>(new Map());
  const metas = useSessionMetas();
  // Each computer's newest ask: an answer to an older one changes nothing. Retry asks the one computer it names again,
  // and every other computer's list stays as it was.
  const asks = useRef(new Map<string, number>());
  const load = useCallback((id: string): void => {
    const mine = (asks.current.get(id) ?? 0) + 1;
    asks.current.set(id, mine);
    setReads((map) => new Map(map).set(id, { status: "loading" }));
    archivedOn(id).then(
      (list) => {
        if (asks.current.get(id) !== mine) return;
        setReads((map) => new Map(map).set(id, { status: "ready", metas: list }));
        void sessionStore.ensureArchived(id);
      },
      (err: unknown) => asks.current.get(id) === mine && setReads((map) => new Map(map).set(id, { status: "failed", error: refusalWords(err) })),
    );
  }, []);
  useEffect(() => {
    for (const id of ids ? ids.split("\n") : []) load(id);
    // Leaving the page drops every answer still out.
    return () => asks.current.clear();
  }, [ids, load]);
  const threads = useMemo(() => {
    const known = new Map(metas.map((meta) => [meta.id, meta] as const));
    const byId = new Map<string, SessionMeta>();
    for (const read of reads.values()) if (read.status === "ready") for (const meta of read.metas) byId.set(meta.id, known.get(meta.id) ?? meta);
    for (const meta of metas) if (meta.archived) byId.set(meta.id, meta);
    // The store's word wins: a thread restored in any window since it was listed reads archived false there.
    return [...byId.values()].filter((meta) => !meta.parentId && meta.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [reads, metas]);
  return { threads, reads, retry: load };
}

export function ArchivePage({
  onOpenSession,
  onArchiveSession,
  onDeleteSession,
  onRestoreProject,
  onDeleteProject,
}: {
  onOpenSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string, archived: boolean) => void;
  onDeleteSession: (sessionId: string, options?: { confirmed?: boolean }) => void;
  onRestoreProject?: (path: string) => void;
  onDeleteProject?: (path: string) => Promise<void> | void;
}) {
  const archivedProjectLabel = useArchivedProjectLabel();
  const [deleting, setDeleting] = useState<ArchivedProject | null>(null);
  const [deletingThread, setDeletingThread] = useState<SessionMeta | null>(null);
  // Threads restored or deleted from this page leave it at once, before their computer's answer.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(ARCHIVE_PAGE);
  const archivedProjects = useArchivedProjects();
  const { threads, reads, retry } = useArchivedThreads();
  const names = useComputerNames();
  const projects = useProjects();
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const nameOf = (meta: SessionMeta): string => (meta.projectId ? projectNames.get(meta.projectId) : undefined) ?? (looksLikeProject(meta.cwd) ? projectName(meta.cwd) : "");
  const archived = threads.filter((meta) => !gone.has(meta.id));
  // A row names its computer only where the rows differ: with every thread on one computer, none says it.
  const oneComputer = new Set(archived.map((meta) => meta.environmentId || LOCAL_ENVIRONMENT_ID)).size <= 1;
  const where = (meta: SessionMeta): string => archivedWhere(nameOf(meta), oneComputer ? null : computerInLine(names(meta.environmentId || LOCAL_ENVIRONMENT_ID)), formatDate(meta.updatedAt));
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return archived;
    return archived.filter((meta) => [meta.title, nameOf(meta), HARNESS_TITLE[meta.provider], meta.provider, names(meta.environmentId || LOCAL_ENVIRONMENT_ID).name].join(" ").toLowerCase().includes(needle));
  }, [archived, query]);
  const waiting = [...reads.values()].some((read) => read.status === "loading");
  const failed = [...reads.entries()].filter((entry): entry is [string, Extract<Read, { status: "failed" }>] => entry[1].status === "failed");

  const restore = (meta: SessionMeta) => {
    setGone((set) => new Set(set).add(meta.id));
    onArchiveSession(meta.id, false);
    onOpenSession(meta.id);
  };

  return (
    <>
      <SettingSection of="archive.projects">
        {archivedProjects.length === 0 ? (
          <PageEmpty>No archived projects</PageEmpty>
        ) : (
          archivedProjects.map((project) => (
            <PageRow key={project.path} title={archivedProjectLabel(project.path)} description={<span className="font-mono">{prettyCwd(project.path)}</span>}>
              <RowActions
                name={archivedProjectLabel(project.path)}
                verb="Remove"
                onRestore={onRestoreProject ? () => onRestoreProject(project.path) : undefined}
                onDelete={onDeleteProject ? () => setDeleting(project) : undefined}
              />
            </PageRow>
          ))
        )}
      </SettingSection>

      <SettingSection of="archive.threads">
        {/* The field needs no answer: it stands while the lists are read and after a refusal, gone only when every
            computer answered none. */}
        {archived.length > 0 || waiting || failed.length > 0 ? (
          <Input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(ARCHIVE_PAGE);
            }}
            placeholder="Search archived threads"
            aria-label="Search archived threads"
            className="mb-1"
          />
        ) : null}
        {failed.map(([id, read]) => (
          <PageError
            key={id}
            action={
              <Button variant="ghost" size="sm" onClick={() => retry(id)}>
                <BusyLabel busy={false} label="Retry" />
              </Button>
            }
          >
            {archivedFailure(capital(computerInLine(names(id))), read.error)}
          </PageError>
        ))}
        {archived.length === 0 ? (
          waiting ? (
            <PageRowsSkeleton rows={3} description media control="none" />
          ) : failed.length ? null : (
            <PageEmpty>No archived threads</PageEmpty>
          )
        ) : shown.length === 0 ? (
          <PageEmpty>No archived thread matches</PageEmpty>
        ) : (
          shown.slice(0, limit).map((meta) => (
            <PageRow
              key={meta.id}
              media={<HarnessIcon harness={meta.provider} className="size-4 shrink-0" />}
              title={sessionDisplayTitle(meta.title, meta.provider)}
              description={where(meta)}
            >
              <RowActions name={sessionDisplayTitle(meta.title, meta.provider)} onRestore={() => restore(meta)} onDelete={() => setDeletingThread(meta)} />
            </PageRow>
          ))
        )}
        {shown.length > limit ? (
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={() => setLimit((n) => n + ARCHIVE_PAGE)}>
              Show more
            </Button>
          </div>
        ) : null}
      </SettingSection>

      {deleting ? (
        <RemoveProjectDialog
          name={archivedProjectLabel(deleting.path)}
          path={deleting.path}
          onCancel={() => setDeleting(null)}
          onConfirm={() => onDeleteProject?.(deleting.path)}
          onDone={() => setDeleting(null)}
        />
      ) : null}
      {deletingThread ? (
        <DeleteThreadDialog
          title={clampTitle(sessionDisplayTitle(deletingThread.title, deletingThread.provider))}
          status={deletingThread.status}
          onCancel={() => setDeletingThread(null)}
          onConfirm={() => {
            setGone((set) => new Set(set).add(deletingThread.id));
            onDeleteSession(deletingThread.id, { confirmed: true });
          }}
          onDone={() => setDeletingThread(null)}
        />
      ) : null}
    </>
  );
}

/** A thread's line: its project, its computer where the rows differ, the day it was last active. */
export function archivedWhere(project: string, computer: string | null, day: string): string {
  const place = computer ? (project ? `${project}, on ${computer}` : `On ${computer}`) : project;
  return [place, day].filter(Boolean).join(", ");
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A computer that did not send its list, named; its own reason after, unless that reason is only its silence. */
export function archivedFailure(computer: string, why: string): string {
  const said = `${computer} did not send its archived threads.`;
  if (!why || why === NO_ANSWER) return said;
  return `${said} ${why.replace(/\.$/, "")}.`;
}

/** Restore, then a ⋯ menu holding the removing verb (Delete… for a thread, Remove… for a project whose folder stays):
 *  one verb on the row, the destructive one a step away. Shown on hover, on focus and while the menu is open. */
function RowActions({ name, verb = "Delete", onRestore, onDelete }: { name: string; verb?: "Delete" | "Remove"; onRestore?: () => void; onDelete?: () => void }) {
  return (
    // Always shown: a row's acts never wait on a hover.
    <span className="flex items-center gap-1">
      {onRestore ? (
        <Button variant="ghost" size="sm" aria-label={`Restore ${name}`} onClick={onRestore}>
          Restore
        </Button>
      ) : null}
      {onDelete ? (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${name}`} />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              {verb}…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </span>
  );
}

function clampTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;
}

function formatDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
  } catch {
    return "";
  }
}
