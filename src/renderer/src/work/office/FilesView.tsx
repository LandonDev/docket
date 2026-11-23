import { useEffect, useState, useSyncExternalStore } from "react";
import type { TeamsEntry, TeamsFileKind, TeamsLibrariesAnswer } from "@shared/contract-work-office";
import { teamsCanvasOf, teamsWebOf } from "@shared/contract-work-office";
import type { CanvasSource, ContextChip } from "@shared/work";
import { ChevronRight, Folder, MoreHorizontal, Search, X } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { GroupInput, InputGroup } from "../../components/ui/input";
import { ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { reveal } from "../../components/ui/reveal";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { dayTime } from "../../lib/duration";
import { bridgeNewThread } from "../../lib/macBridge";
import { refusalWords } from "../../lib/settingsHome";
import { sessionStore } from "../../lib/tcserver/store";
import type { WireSessionMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { shell } from "../../stores/shell";
import { workOpenPort } from "../../lib/workSwitch";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { Cloud, Doc, File, Media, Pdf, Slides, Table, Video, Volume } from "../icons";
import { allowComputers, linkIdOfHost, localHostId, windowDesktops, workspaceSettings } from "../shell/actions";
import { openVm, signInOnVm } from "../winvm/signIn";
import { openItem, setFolded } from "../canvas/store";
import type { WorkViewProps } from "../views/registry";
import { SEARCH_FIELD } from "../views/searchField";
import { ViewStateLine } from "../views/ViewStateLine";
import { playRunner } from "../routines/plays/runOn";
import { appVerb, byDeadline, crumbsOf, deadlineError, filesNote, HOST_DEADLINE_MS, openWay, pathIn, placeGroups, placeOf, READING_AGAIN_MS, rowOf, SEARCH_DEADLINE_MS, showsHeading, unreachable, vmReading, type FilesNote, type HostRead, type PlaceCopy, type PlaceGroup, type PlaceRow, type ShownLibrary } from "./files";

/**
 * The Files view of a Work workspace (docs/agents/work-files.md "The Files view"): the Teams and
 * SharePoint libraries OneDrive syncs on the hosts the workspace may use, as teams and their
 * channels. A folder lists its files with who last saved them and when; the header's field
 * searches every library by name. A file opens in a new thread's canvas when it lies on the
 * workspace's own host (or as a copy, where he allowed one), else in its app where it lies; its
 * menu has the app and the web. A file OneDrive keeps in the cloud downloads first, in its row.
 */

/** A folder: its row's key (one place however many machines hold it) and its folders down from the row's top. */
interface Place {
  row: string;
  parts: string[];
}
interface State {
  query: string;
  place: Place | null;
}
const states = new Map<string, State>();
const listeners = new Set<() => void>();
const EMPTY: State = { query: "", place: null };
const stateOf = (workspaceId: string): State => states.get(workspaceId) ?? EMPTY;
function patch(workspaceId: string, next: Partial<State>): void {
  states.set(workspaceId, { ...stateOf(workspaceId), ...next });
  for (const listener of listeners) listener();
}
function useFilesState(workspaceId: string): State {
  return useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => stateOf(workspaceId),
  );
}

const GLYPH: Record<TeamsFileKind, typeof Folder> = { folder: Folder, workbook: Table, document: Doc, deck: Slides, pdf: Pdf, picture: Media, video: Video, audio: Volume, text: Doc, other: File };

/** The header's search: every library, by name. */
export function Head({ workspace }: WorkViewProps) {
  const { query } = useFilesState(workspace.id);
  return (
    <InputGroup
      role="search"
      className={SEARCH_FIELD}
      leading={<Search />}
      trailing={
        query ? (
          <Button variant="ghost" size="icon-xs" aria-label="Clear search" onClick={() => patch(workspace.id, { query: "" })}>
            <X />
          </Button>
        ) : null
      }
    >
      <GroupInput
        value={query}
        onChange={(event) => patch(workspace.id, { query: event.target.value })}
        onKeyDown={(event) => event.key === "Escape" && query && (event.preventDefault(), patch(workspace.id, { query: "" }))}
        placeholder="Search files"
        aria-label="Search files"
        spellCheck={false}
        autoComplete="off"
      />
    </InputGroup>
  );
}

interface Reach {
  groups: PlaceGroup[];
  /** every row, each place once */
  rows: PlaceRow[];
  copy: boolean;
  /** why nothing (or not everything) is listed; null: nothing to say */
  note: FilesNote | null;
  /** a host has not answered yet (within its deadline), or its VM's first read is under way: more is coming */
  waiting: boolean;
}

/**
 * The hosts this workspace may reach Teams files on (its own, then each desktop it may use), and what each said. Each
 * host paints as it answers; one past `HOST_DEADLINE_MS` is said not to answer. A host that pushes `work.office.files`
 * (its VM read again behind an answer) is asked again, its last answer kept on screen until the new one lands.
 */
function useReach(workspace: WorkspaceMeta, attempt: number): Reach | null {
  const [reach, setReach] = useState<Reach | null>(null);
  useEffect(() => {
    let live = true;
    const offs: (() => void)[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>();
    setReach(null);
    void (async () => {
      const [settings, local, desktops] = await Promise.all([workspaceSettings(workspace).catch(() => null), localHostId(), windowDesktops()]);
      // The workspace's desktops are host ids; the window reaches each through its link ("local" for this machine).
      const allowed = (settings?.mayUseDesktop ?? []).map((id) => linkIdOfHost(id, local)).filter((id): id is string => id !== null);
      const hosts = [...new Set([workspace.environmentId, ...allowed])].filter((id) => registry.has(id));
      if (!live) return;
      const windowsVm = !!settings?.windowsVm;
      const own = desktops.find((d) => d.link === workspace.environmentId);
      const notAllowed = desktops.filter((d) => d !== own && !hosts.includes(d.link)).map((d) => d.name);
      const reads = new Map<string, HostRead>();
      let copy = false;
      const paint = (): void => {
        if (!live) return;
        const got = hosts.flatMap((env) => reads.get(env) ?? []);
        // A library in the Windows VM is this workspace's only while its VM switch is on.
        const shown = got.flatMap((r) => (r.answer?.libraries ?? []).filter((l) => windowsVm || !l.vm).map((l) => ({ ...l, env: r.env })));
        const placeOk = (l: ShownLibrary): boolean => {
          const places = reads.get(l.env)?.answer?.places;
          return !places || places.some((p) => p.kind === (l.vm ? "vm" : "folders") && p.state === "ok");
        };
        const groups = placeGroups(shown, workspace.environmentId, placeOk);
        const rows = groups.flatMap((g) => g.rows);
        const waiting = got.length < hosts.length || (windowsVm && vmReading(reads.get(workspace.environmentId)?.answer));
        setReach({ groups, rows, copy, waiting, note: filesNote({ workspaceEnv: workspace.environmentId, reads: got, windowsVm, notAllowed, listed: rows }) });
      };
      // Only the newest ask of a host lands.
      const asked = new Map<string, number>();
      const ask = (env: string): void => {
        const mine = (asked.get(env) ?? 0) + 1;
        asked.set(env, mine);
        const name = registry.environment(env)?.name ?? env;
        const desktop = desktops.some((d) => d.link === env);
        const failed = (err: unknown): void => {
          if (!live || asked.get(env) !== mine) return;
          reads.set(env, { env, name, desktop, failed: { words: refusalWords(err) || "No answer.", unreachable: unreachable(err) } });
          paint();
        };
        // Past the deadline the host shows as not answering; an answer that comes later still takes its place.
        const late = setTimeout(() => (timers.delete(late), failed(deadlineError(HOST_DEADLINE_MS))), HOST_DEADLINE_MS);
        timers.add(late);
        const settle = (): void => void (clearTimeout(late), timers.delete(late));
        void registry.linkOf(env).request<TeamsLibrariesAnswer>("work.office.filesLibraries", {}).then(
          (answer) => {
            settle();
            if (!live || asked.get(env) !== mine) return;
            reads.set(env, { env, name, desktop, answer });
            paint();
            if (!vmReading(answer)) return;
            const timer = setTimeout(() => (timers.delete(timer), ask(env)), READING_AGAIN_MS);
            timers.add(timer);
          },
          (err: unknown) => (settle(), failed(err)),
        );
      };
      for (const env of hosts) {
        ask(env);
        offs.push(registry.linkOf(env).onPush((push) => void (push.push === "work.office.files" && ask(env))));
      }
      paint();
      copy = await registry
        .linkOf(workspace.environmentId)
        .request<{ on: boolean }>("work.office.filesCopyGet", { workspaceId: workspace.id })
        .then((a) => a.on, () => false);
      if (copy) paint();
    })();
    return () => {
      live = false;
      for (const off of offs) off();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [workspace.id, workspace.environmentId, attempt]);
  return reach;
}

const FIX_LABEL = { allow: "Allow", retry: "Retry", "sign-in": "Sign in to OneDrive", "open-vm": "Open the Windows VM", settings: "Open Settings" } as const;

/** A note's press: it spins until done; a refusal is one toast. */
function useFix(workspace: WorkspaceMeta, again: () => void): { busy: boolean; run(fix: NonNullable<FilesNote["fix"]>): Promise<void> } {
  const [busy, setBusy] = useState(false);
  const run = async (fix: NonNullable<FilesNote["fix"]>): Promise<void> => {
    if (fix.kind === "retry") return again();
    if (fix.kind === "settings") return shell.openSettings("work");
    if (fix.kind === "open-vm") return openVm(fix.env);
    setBusy(true);
    try {
      if (fix.kind === "allow") {
        await allowComputers(workspace, { vm: fix.vm });
        again();
      } else await signInOnVm(fix.env);
    } catch (err) {
      failed(fix.kind === "allow" ? "Not allowed" : "The sign-in did not open", err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** Nothing listed: the one cause and its press, centred where the list would be. */
export function NoteEmpty({ note, workspace, again }: { note: FilesNote; workspace: WorkspaceMeta; again: () => void }) {
  const fix = useFix(workspace, again);
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{note.title}</EmptyTitle>
        {note.line ? <EmptyDescription>{note.line}</EmptyDescription> : null}
      </EmptyHeader>
      {note.fix ? (
        <Button size="sm" variant="secondary" disabled={fix.busy} onClick={() => void fix.run(note.fix!)}>
          <BusyLabel busy={fix.busy} label={FIX_LABEL[note.fix.kind]} />
        </Button>
      ) : null}
    </Empty>
  );
}

/** Libraries listed, and a place that needs him: one quiet line under the list, with its press. */
export function NoteLine({ note, workspace, again }: { note: FilesNote; workspace: WorkspaceMeta; again: () => void }) {
  const fix = useFix(workspace, again);
  return (
    <div className="mt-5 flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">{note.title}</span>
      {note.fix ? (
        <Button variant="ghost" size="xs" disabled={fix.busy} onClick={() => void fix.run(note.fix!)}>
          <BusyLabel busy={fix.busy} label={FIX_LABEL[note.fix.kind]} />
        </Button>
      ) : null}
    </div>
  );
}

export function View(props: WorkViewProps) {
  const { workspace } = props;
  const [attempt, setAttempt] = useState(0);
  const reach = useReach(workspace, attempt);
  const { query, place } = useFilesState(workspace.id);
  const again = () => setAttempt((n) => n + 1);
  if (!reach) return <Bones />;
  const { note, waiting } = reach;
  // A machine that did not answer is the state line, with Retry, over what the others hold (docs/DESIGN.md "The state line").
  const stateLine = note?.away ? <ViewStateLine word={note.title} detail={note.line} onRetry={again} /> : null;
  // Nothing listed yet while a host is still to answer: the bones, so the empty state never shows first.
  if (!reach.rows.length && waiting)
    return (
      <>
        {stateLine}
        <Bones />
      </>
    );
  if (!reach.rows.length) return stateLine ?? (note ? <NoteEmpty note={note} workspace={workspace} again={again} /> : null);
  const row = place ? reach.rows.find((r) => r.key === place.row) : undefined;
  return (
    <>
      {stateLine}
      <div className="@container/files mx-auto w-full max-w-[880px] px-6 py-5">
      {query.trim() ? (
        <Results {...props} reach={reach} query={query.trim()} />
      ) : row && place ? (
        <FolderList {...props} reach={reach} row={row} parts={place.parts} />
      ) : (
        <>
          <Places workspace={workspace} groups={reach.groups} />
          {/* A host still to answer: its rows' bones under the ones that came. */}
          {waiting ? <MoreBones /> : note && !stateLine ? <NoteLine note={note} workspace={workspace} again={again} /> : null}
        </>
      )}
      </div>
    </>
  );
}

function Bones() {
  return (
    <div aria-busy className="mx-auto flex max-w-[880px] flex-col gap-3 px-6 py-5">
      <Skeleton className="h-3 w-[18%]" />
      <Skeleton className="h-3 w-[64%]" />
      <Skeleton className="h-3 w-[52%]" />
      <Skeleton className="h-3 w-[58%]" />
    </div>
  );
}

/** Rows still to come under rows already listed: two bones, at a group's distance, as the list's own bones are drawn. */
export function MoreBones() {
  return (
    <div aria-busy className="mt-5 flex flex-col gap-3 py-2.5">
      <Skeleton className="h-3 w-[52%]" />
      <Skeleton className="h-3 w-[18%]" />
    </div>
  );
}

const ROW = `-mx-2 h-8 w-[calc(100%+16px)] min-w-0 flex-nowrap rounded-md py-0 text-[13px] ${ROW_PRESS}`;

export function Places({ workspace, groups }: { workspace: WorkspaceMeta; groups: PlaceGroup[] }) {
  return (
    <>
      {groups.map((g, i) => (
        <section key={g.name || "other"} className={i ? "mt-5" : undefined}>
          {showsHeading(g) ? <h2 className="mb-1 text-xs font-medium text-muted-foreground">{g.name}</h2> : null}
          {g.rows.map((row) => (
            <ItemButton key={row.key} size="xs" className={ROW} onClick={() => patch(workspace.id, { place: { row: row.key, parts: [] } })}>
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-foreground">{row.label}</span>
            </ItemButton>
          ))}
        </section>
      ))}
    </>
  );
}

/** A read of a VM library may wake the VM first. */
const readMs = (library: ShownLibrary): { timeoutMs?: number } => (library.vm ? { timeoutMs: 120_000 } : {});

/**
 * A folder read from the first copy of its place whose machine answers, in order, kept per key; a new key starts from
 * nothing. Every entry comes from that one copy, which is the one the rows open from.
 */
function useFolder(row: PlaceRow, parts: readonly string[], key: string): { value?: { entries: TeamsEntry[]; copy: PlaceCopy }; error?: string; retry(): void } {
  const [state, setState] = useState<{ key: string; value?: { entries: TeamsEntry[]; copy: PlaceCopy }; error?: string }>({ key });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void (async () => {
      let first: unknown;
      for (const copy of row.copies) {
        try {
          const { library } = copy;
          const { entries } = await registry
            .linkOf(library.env)
            .request<{ entries: TeamsEntry[] }>("work.office.filesList", { source: { at: "file", host: library.host, path: pathIn(copy.folder, parts) } }, readMs(library));
          return void (live && setState({ key, value: { entries, copy } }));
        } catch (err) {
          first ??= err;
          // A refusal about the folder itself is the answer; only a machine out of reach sends the read to the next copy.
          if (!unreachable(err)) break;
        }
      }
      if (live) setState({ key, error: refusalWords(first) || "The host did not answer." });
    })();
    return () => {
      live = false;
    };
  }, [key, attempt]);
  const current = state.key === key ? state : { key };
  return { ...current, retry: () => setAttempt((n) => n + 1) };
}

type ViewProps = WorkViewProps & { reach: Reach };

/** A crumb above the current folder: the row text's size, muted, so the current one leads by weight and colour alone. */
const CRUMB = "text-[13px] text-muted-foreground";

function FolderList(props: ViewProps & { row: PlaceRow; parts: string[] }) {
  const { workspace, row, parts } = props;
  const listed = useFolder(row, parts, `${row.key}\u0000${parts.join("\u0000")}`);
  const crumbs = crumbsOf(row, parts);
  return (
    <>
      <nav aria-label="Folder" className="-ms-2 mb-3 flex min-w-0 items-center gap-0.5">
        <Button variant="ghost" size="xs" className={CRUMB} onClick={() => patch(workspace.id, { place: null })}>
          Files
        </Button>
        {/* A team is no place of its own across machines: it names the row, and Files goes back to its rows. */}
        {row.team && row.team !== row.label ? (
          <span className="flex min-w-0 items-center gap-0.5">
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={`truncate px-2 ${CRUMB}`}>{row.team}</span>
          </span>
        ) : null}
        {crumbs.map((crumb, i) => (
          <span key={crumb.parts.join("/")} className="flex min-w-0 items-center gap-0.5">
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            {i === crumbs.length - 1 ? (
              <span aria-current="page" className="truncate px-2 text-[13px] font-medium text-foreground">
                {crumb.label}
              </span>
            ) : (
              <Button variant="ghost" size="xs" className={`min-w-0 truncate ${CRUMB}`} onClick={() => patch(workspace.id, { place: { row: row.key, parts: crumb.parts } })}>
                {crumb.label}
              </Button>
            )}
          </span>
        ))}
      </nav>
      {listed.error ? (
        <EmptyState title="This folder did not load" line={listed.error} action={{ label: "Retry", onClick: listed.retry }} />
      ) : !listed.value ? (
        <Bones />
      ) : !listed.value.entries.length ? (
        <EmptyState title="No files" />
      ) : (
        <Entries {...props} rows={listed.value.entries.map((entry) => ({ entry, library: listed.value!.copy.library, at: { row, parts: [...parts, entry.name] } }))} />
      )}
    </>
  );
}

function Results(props: ViewProps & { query: string }) {
  const { reach, query, workspace } = props;
  // A search waits until typing stops, so each word does not walk every library.
  const [asked, setAsked] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => setAsked(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const envs = [...new Set(reach.rows.flatMap((r) => r.copies.map((c) => c.library.env)))];
  const [found, setFound] = useState<{ key: string; rows: Row[]; more: boolean; waiting: boolean; error?: string } | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    // Each host's hits show as it answers; one past its deadline is left out, and only no answer at all is a failure.
    const answers = new Map<string, PromiseSettledResult<{ entries: TeamsEntry[]; more: boolean }>>();
    const paint = (): void => {
      if (!live) return;
      // A place's hits come from one copy, the first whose machine answered, so no file is listed twice.
      const answered = new Set(envs.filter((env) => answers.get(env)?.status === "fulfilled"));
      const settled = envs.flatMap((env) => answers.get(env) ?? []);
      const seen = new Set<string>();
      const rows = settled.flatMap((a) => (a.status === "fulfilled" ? a.value.entries : [])).flatMap((entry): Row[] => {
        const at = rowOf(reach.rows, entry.library, entry.path);
        if (!at) return [];
        if (at.row.copies.find((c) => answered.has(c.library.env)) !== at.copy) return [];
        const id = `${at.row.key}\u0000${at.parts.join("\u0000")}`;
        if (seen.has(id)) return [];
        seen.add(id);
        return [{ entry, library: at.copy.library, at: { row: at.row, parts: at.parts } }];
      });
      const waiting = settled.length < envs.length;
      const failed = settled.filter((a): a is PromiseRejectedResult => a.status === "rejected");
      const error = !waiting && failed.length === envs.length && envs.length ? refusalWords(failed[0]!.reason) || "No host answered." : undefined;
      setFound({ key: asked, rows: rows.sort((a, b) => b.entry.modified - a.entry.modified), more: settled.some((a) => a.status === "fulfilled" && a.value.more), waiting, error });
    };
    for (const env of envs)
      void byDeadline(registry.linkOf(env).request<{ entries: TeamsEntry[]; more: boolean }>("work.office.filesSearch", { query: asked }), SEARCH_DEADLINE_MS).then(
        (value) => (answers.set(env, { status: "fulfilled", value }), paint()),
        (reason: unknown) => (answers.set(env, { status: "rejected", reason }), paint()),
      );
    return () => {
      live = false;
    };
  }, [asked, envs.join(","), round]);
  // Bones until the first host answers; past that, what came, with bones under it for the rest.
  if (!found || found.key !== asked || (found.waiting && !found.rows.length)) return <Bones />;
  if (found.error)
    return (
      <EmptyState
        title="Search did not run"
        line={found.error}
        action={{
          label: "Retry",
          onClick: () => {
            setFound(null);
            setRound((n) => n + 1);
          },
        }}
      />
    );
  if (!found.rows.length) return <EmptyState title="No files match" action={{ label: "Clear search", onClick: () => patch(workspace.id, { query: "" }) }} />;
  return (
    <>
      <Entries {...props} rows={found.rows} places />
      {found.waiting ? <MoreBones /> : found.more ? <p className="mt-3 text-xs text-muted-foreground">More match: add a word</p> : null}
    </>
  );
}

/** A file or folder as listed: the copy it was read from, and its place (its row and its folders below the row's top). */
type Row = { entry: TeamsEntry; library: ShownLibrary; at: { row: PlaceRow; parts: string[] } };
type Busy = { key: string; word: string } | null;
const rowKey = (library: ShownLibrary, entry: TeamsEntry): string => `${library.env}\u0000${entry.path}`;

function Entries(props: ViewProps & { rows: Row[]; places?: boolean }) {
  const { rows, places, workspace } = props;
  const [busy, setBusy] = useState<Busy>(null);
  const open = useOpener(props, setBusy);
  return (
    <div role="list">
      {rows.map(({ entry, library, at }) => {
        const Glyph = GLYPH[entry.kind];
        const mine = busy?.key === rowKey(library, entry);
        const folder = entry.kind === "folder";
        return (
          <div key={rowKey(library, entry)} role="listitem" className="group/row relative">
            <ItemButton
              size="xs"
              className={`${ROW} pe-10`}
              disabled={!!busy}
              onClick={() => (folder ? patch(workspace.id, { query: "", place: { row: at.row.key, parts: at.parts } }) : void open.open(entry, library))}
            >
              <Glyph className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-foreground">{entry.name}</span>
              {entry.local ? null : <Cloud aria-label="In the cloud" className="size-3 shrink-0 text-muted-foreground" />}
              {places ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{placeOf(at.row, at.parts)}</span> : <span className="flex-1" />}
              {mine ? (
                <span className="flex w-28 shrink-0 items-center justify-end gap-1.5 text-xs text-muted-foreground">
                  <Spinner className="size-3" />
                  {busy!.word}
                </span>
              ) : (
                <>
                  <span className="hidden w-36 shrink-0 truncate text-xs text-muted-foreground @[560px]/files:block">{entry.by ?? ""}</span>
                  <span className="w-28 shrink-0 text-end text-xs text-muted-foreground tabular-nums">{dayTime(entry.modified)}</span>
                </>
              )}
            </ItemButton>
            {folder ? null : (
              <div className={`absolute end-0 top-1 ${reveal("row", { row: true })}`}>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`More for ${entry.name}`} disabled={!!busy} />}>
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void open.open(entry, library)}>Open</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void open.app(entry, library)}>{appVerb(entry)}</DropdownMenuItem>
                    {library.web ? <DropdownMenuItem onClick={() => window.open(teamsWebOf(library, entry.path)!, "_blank")}>Open on the web</DropdownMenuItem> : null}
                    {/* A play's thread reads the file where it lies: only one on the workspace's own host. */}
                    {library.env === workspace.environmentId && !library.vm ? <RunPlayItem chip={{ kind: "item", label: entry.name, ref: { at: "file", host: library.host, path: entry.path } }} /> : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const failed = (title: string, err: unknown): void => void loadToast().then((toast) => toast.error(title, { description: refusalWords(err) || undefined }));
const source = (library: ShownLibrary, entry: TeamsEntry) => ({ at: "file" as const, host: library.host, path: entry.path });

/** Run a play… on the file, read as the menu opens (work/routines/plays/runOn.ts). */
function RunPlayItem({ chip }: { chip: ContextChip }) {
  const runPlay = playRunner();
  return runPlay ? <DropdownMenuItem onClick={() => runPlay(chip)}>Run a play…</DropdownMenuItem> : null;
}

/** A new thread in the workspace, titled for the file: the canvas it opens in. Nothing runs until he writes. */
async function newThread(workspace: WorkspaceMeta, title: string): Promise<string> {
  const link = registry.linkOf(workspace.environmentId);
  const wire = await link.request<WireSessionMeta>("session.create", { workspaceId: workspace.id, cwd: workspace.path, threadType: "chat", title });
  sessionStore.adopt({ ...wire, environmentId: link.environmentId }, { created: true });
  await bridgeNewThread(link.environmentId, wire.id).catch(() => {});
  return wire.id;
}

/**
 * The open thread of the workspace whose canvas holds this file already (`work.office.filesThreads`, newest first): in
 * place, as its Office app's file, as the copy he allowed or as the document a Word file became. Archived threads and
 * threads this window does not know are passed over; a host from before the method answers none.
 */
export async function heldBy(workspace: Pick<WorkspaceMeta, "id" | "environmentId">, file: CanvasSource): Promise<{ sessionId: string; itemId: string; source: CanvasSource } | null> {
  const answer = await registry
    .linkOf(workspace.environmentId)
    .request<{ threads: { sessionId: string; itemId: string; source: CanvasSource }[] }>("work.office.filesThreads", { workspaceId: workspace.id, source: file })
    .catch(() => null);
  return answer?.threads.find((t) => sessionStore.metaOf(t.sessionId)?.archived === false) ?? null;
}

/** The file takes the pane: its item opened and shown, the thread folded away one press beside it, then the thread on screen. */
export async function showFile(environmentId: string, sessionId: string, what: Parameters<typeof openItem>[2]): Promise<void> {
  await openItem(environmentId, sessionId, what);
  setFolded(sessionId, true);
  workOpenPort.get()?.(sessionId);
}

function useOpener({ workspace, reach }: ViewProps, setBusy: (busy: Busy) => void) {
  /** The file as it is once its bytes are here: OneDrive downloads one it keeps in the cloud. */
  const fetched = async (entry: TeamsEntry, library: ShownLibrary): Promise<TeamsEntry> => {
    if (entry.local) return entry;
    setBusy({ key: rowKey(library, entry), word: "Downloading…" });
    return (await registry.linkOf(library.env).request<{ entry: TeamsEntry }>("work.office.filesFetch", { source: source(library, entry) }, library.vm ? { timeoutMs: 660_000 } : {})).entry;
  };
  const app = async (entry: TeamsEntry, library: ShownLibrary): Promise<void> => {
    try {
      // Its app downloads the file itself.
      setBusy({ key: rowKey(library, entry), word: "Opening…" });
      await registry.linkOf(library.env).request("work.office.filesOpen", { source: source(library, entry) }, readMs(library));
    } catch (err) {
      failed(`${entry.name} did not open`, err);
    } finally {
      setBusy(null);
    }
  };
  const open = async (entry: TeamsEntry, library: ShownLibrary): Promise<void> => {
    const way = openWay(entry, library, workspace.environmentId, reach.copy);
    if (way === "app") return app(entry, library);
    let sessionId: string | null = null;
    const ws = registry.linkOf(workspace.environmentId);
    try {
      // The thread that already holds the file shows it again: one file, one thread.
      const held = await heldBy(workspace, source(library, entry));
      if (held) {
        // Excel, Word or PowerPoint stands behind such an item: it comes forward again, as on the first open.
        if (held.source.at === "microsoft") await registry.linkOf(library.env).request("work.office.filesOpen", { source: source(library, entry) });
        return await showFile(workspace.environmentId, held.sessionId, { itemId: held.itemId });
      }
      let at: NonNullable<ReturnType<typeof teamsCanvasOf>>;
      if (way === "canvas") {
        // Everything that can fail runs before the thread is made, so a failed open leaves no thread behind.
        const here = await fetched(entry, library);
        setBusy({ key: rowKey(library, entry), word: "Opening…" });
        at = teamsCanvasOf(here, library.host)!;
        // Excel, Word or PowerPoint stands behind the item: the file opens there too.
        if (at.source.at === "microsoft") await registry.linkOf(library.env).request("work.office.filesOpen", { source: source(library, here) });
        sessionId = await newThread(workspace, entry.name);
      } else {
        // A copy lands in its thread's folder, so the thread comes first, and goes again if the copy fails.
        setBusy({ key: rowKey(library, entry), word: entry.local ? "Opening…" : "Downloading…" });
        sessionId = await newThread(workspace, entry.name);
        const copy = await ws.request<{ source: { at: "file"; host: string; path: string } }>("work.office.filesCopy", { sessionId, source: source(library, entry) });
        at = teamsCanvasOf({ ...entry, path: copy.source.path }, copy.source.host, true)!;
      }
      await showFile(workspace.environmentId, sessionId, { kind: at.kind, source: at.source, title: entry.name });
    } catch (err) {
      if (sessionId && way === "copy") void ws.request("session.delete", { sessionId }).catch(() => {});
      failed(`${entry.name} did not open`, err);
    } finally {
      setBusy(null);
    }
  };
  return { open, app };
}

