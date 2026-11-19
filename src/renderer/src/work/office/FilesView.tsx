import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { TeamsEntry, TeamsFileKind, TeamsLibrary } from "@shared/contract-work-office";
import { teamsCanvasOf, teamsWebOf } from "@shared/contract-work-office";
import type { CanvasItem } from "@shared/work";
import { ChevronRight, Folder, MoreHorizontal, Search, X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
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
import { workOpenPort } from "../../lib/workSwitch";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { Cloud, Doc, File, Media, Pdf, Slides, Table, Video, Volume } from "../icons";
import { workspaceSettings } from "../shell/actions";
import type { WorkViewProps } from "../views/registry";
import { appVerb, crumbsOf, libraryGroups, openWay, placeOf, type ShownLibrary } from "./files";

/**
 * The Files view of a Work workspace (docs/agents/work-files.md "The Files view"): the Teams and
 * SharePoint libraries OneDrive syncs on the hosts the workspace may use, as teams and their
 * channels. A folder lists its files with who last saved them and when; the header's field
 * searches every library by name. A file opens in a new thread's canvas when it lies on the
 * workspace's own host (or as a copy, where he allowed one), else in its app where it lies; its
 * menu has the app and the web. A file OneDrive keeps in the cloud downloads first, in its row.
 */

interface Place {
  library: string;
  folder: string;
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
      className="h-7 w-56"
      leading={<Search className="size-3.5" />}
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
  libraries: ShownLibrary[];
  /** hosts that did not answer, by name */
  failed: string[];
  copy: boolean;
}

/** The hosts this workspace may reach Teams files on: its own, then each desktop it may use. */
function useReach(workspace: WorkspaceMeta, attempt: number): Reach | { error: string } | null {
  const [reach, setReach] = useState<Reach | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    setReach(null);
    void (async () => {
      const settings = await workspaceSettings(workspace).catch(() => null);
      const hosts = [...new Set([workspace.environmentId, ...(settings?.mayUseDesktop ?? [])])].filter((id) => registry.has(id));
      const answers = await Promise.allSettled(hosts.map((env) => registry.linkOf(env).request<{ libraries: TeamsLibrary[] }>("work.office.filesLibraries", {})));
      const copy = await registry
        .linkOf(workspace.environmentId)
        .request<{ on: boolean }>("work.office.filesCopyGet", { workspaceId: workspace.id })
        .then((a) => a.on, () => false);
      if (!live) return;
      const failed = hosts.filter((_, i) => answers[i]!.status === "rejected");
      if (hosts.length && failed.length === hosts.length) {
        const first = answers[0] as PromiseRejectedResult;
        return setReach({ error: refusalWords(first.reason) || "No host answered." });
      }
      const libraries = answers.flatMap((a, i) => (a.status === "fulfilled" ? a.value.libraries.map((l) => ({ ...l, env: hosts[i]! })) : []));
      setReach({ libraries, failed: failed.map((id) => registry.environment(id)?.name ?? id), copy });
    })();
    return () => {
      live = false;
    };
  }, [workspace.id, workspace.environmentId, attempt]);
  return reach;
}

export function View(props: WorkViewProps) {
  const { workspace } = props;
  const [attempt, setAttempt] = useState(0);
  const reach = useReach(workspace, attempt);
  const { query, place } = useFilesState(workspace.id);
  if (!reach) return <Bones />;
  if ("error" in reach) return <EmptyState title="Files did not load" line={reach.error} action={{ label: "Retry", onClick: () => setAttempt((n) => n + 1) }} />;
  if (!reach.libraries.length) return <EmptyState title="No Teams files" line="Sync a channel from Teams with OneDrive on the Mac." />;
  const library = place ? reach.libraries.find((l) => l.id === place.library) : undefined;
  return (
    <div className="@container/files mx-auto w-full max-w-[880px] px-6 py-5">
      {reach.failed.length ? <p className="mb-3 text-xs text-destructive">{`${reach.failed.join(", ")} did not answer`}</p> : null}
      {query.trim() ? (
        <Results {...props} reach={reach} query={query.trim()} />
      ) : library && place ? (
        <FolderList {...props} reach={reach} library={library} folder={place.folder} />
      ) : (
        <Libraries workspace={workspace} libraries={reach.libraries} />
      )}
    </div>
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

const ROW = `-mx-2 h-8 w-[calc(100%+16px)] min-w-0 flex-nowrap rounded-md py-0 text-[13px] ${ROW_PRESS}`;

function Libraries({ workspace, libraries }: { workspace: WorkspaceMeta; libraries: ShownLibrary[] }) {
  const groups = useMemo(() => libraryGroups(libraries), [libraries]);
  return (
    <>
      {groups.map((g, i) => (
        <section key={g.name || "other"} className={i ? "mt-5" : undefined}>
          {g.name ? <h2 className="mb-1 text-xs font-medium text-muted-foreground">{g.name}</h2> : null}
          {g.rows.map((row) => (
            <ItemButton key={row.key} size="xs" className={ROW} onClick={() => patch(workspace.id, { place: { library: row.library.id, folder: row.folder } })}>
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-foreground">{row.label}</span>
            </ItemButton>
          ))}
        </section>
      ))}
    </>
  );
}

/** A host's answer to one read, kept per key; a new key starts from nothing. */
function useRead<T>(env: string, method: string, params: unknown, key: string): { value?: T; error?: string; retry(): void } {
  const [state, setState] = useState<{ key: string; value?: T; error?: string }>({ key });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    registry
      .linkOf(env)
      .request<T>(method, params)
      .then(
        (value) => live && setState({ key, value }),
        (err: unknown) => live && setState({ key, error: refusalWords(err) || "The host did not answer." }),
      );
    return () => {
      live = false;
    };
  }, [env, key, attempt]);
  const current = state.key === key ? state : { key };
  return { ...current, retry: () => setAttempt((n) => n + 1) };
}

type ViewProps = WorkViewProps & { reach: Reach };

/** A crumb above the current folder: the row text's size, muted, so the current one leads by weight and colour alone. */
const CRUMB = "text-[13px] text-muted-foreground";

function FolderList(props: ViewProps & { library: ShownLibrary; folder: string }) {
  const { workspace, library, folder } = props;
  const listed = useRead<{ entries: TeamsEntry[] }>(library.env, "work.office.filesList", { source: { at: "file", host: library.host, path: folder } }, `${library.env}\u0000${folder}`);
  const crumbs = crumbsOf(library, folder);
  return (
    <>
      <nav aria-label="Folder" className="-ms-2 mb-3 flex min-w-0 items-center gap-0.5">
        <Button variant="ghost" size="xs" className={CRUMB} onClick={() => patch(workspace.id, { place: null })}>
          Files
        </Button>
        {crumbs.map((crumb, i) => (
          <span key={crumb.folder} className="flex min-w-0 items-center gap-0.5">
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            {i === crumbs.length - 1 ? (
              <span aria-current="page" className="truncate px-2 text-[13px] font-medium text-foreground">
                {crumb.label}
              </span>
            ) : (
              <Button variant="ghost" size="xs" className={`min-w-0 truncate ${CRUMB}`} onClick={() => patch(workspace.id, { place: { library: library.id, folder: crumb.folder } })}>
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
        <Entries {...props} rows={listed.value.entries.map((entry) => ({ entry, library }))} />
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
  const envs = [...new Set(reach.libraries.map((l) => l.env))];
  const [found, setFound] = useState<{ key: string; rows: { entry: TeamsEntry; library: ShownLibrary }[]; more: boolean; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.allSettled(envs.map((env) => registry.linkOf(env).request<{ entries: TeamsEntry[]; more: boolean }>("work.office.filesSearch", { query: asked }))).then((answers) => {
      if (!live) return;
      const rows = answers.flatMap((a) => (a.status === "fulfilled" ? a.value.entries : [])).flatMap((entry) => {
        const library = reach.libraries.find((l) => l.id === entry.library);
        return library ? [{ entry, library }] : [];
      });
      const error = answers.every((a) => a.status === "rejected") ? refusalWords((answers[0] as PromiseRejectedResult).reason) || "No host answered." : undefined;
      setFound({ key: asked, rows: rows.sort((a, b) => b.entry.modified - a.entry.modified), more: answers.some((a) => a.status === "fulfilled" && a.value.more), error });
    });
    return () => {
      live = false;
    };
  }, [asked, envs.join(",")]);
  if (!found || found.key !== asked) return <Bones />;
  if (found.error) return <EmptyState title="Search did not run" line={found.error} />;
  if (!found.rows.length) return <EmptyState title="No files match" line={`Nothing is named like “${asked}”.`} action={{ label: "Clear search", onClick: () => patch(workspace.id, { query: "" }) }} />;
  return (
    <>
      <Entries {...props} rows={found.rows} places />
      {found.more ? <p className="mt-3 text-xs text-muted-foreground">More match: add a word</p> : null}
    </>
  );
}

type Busy = { path: string; word: string } | null;

function Entries(props: ViewProps & { rows: { entry: TeamsEntry; library: ShownLibrary }[]; places?: boolean }) {
  const { rows, places, workspace } = props;
  const [busy, setBusy] = useState<Busy>(null);
  const open = useOpener(props, setBusy);
  return (
    <div role="list">
      {rows.map(({ entry, library }) => {
        const Glyph = GLYPH[entry.kind];
        const mine = busy?.path === entry.path;
        const folder = entry.kind === "folder";
        return (
          <div key={entry.path} role="listitem" className="group/row relative">
            <ItemButton
              size="xs"
              className={`${ROW} pe-10`}
              disabled={!!busy}
              onClick={() => (folder ? patch(workspace.id, { query: "", place: { library: library.id, folder: entry.path } }) : void open.open(entry, library))}
            >
              <Glyph className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-foreground">{entry.name}</span>
              {entry.local ? null : <Cloud aria-label="In the cloud" className="size-3 shrink-0 text-muted-foreground" />}
              {places ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{placeOf(library, entry.path)}</span> : <span className="flex-1" />}
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

/** A new thread in the workspace, titled for the file: the canvas it opens in. Nothing runs until he writes. */
async function newThread(workspace: WorkspaceMeta, title: string): Promise<string> {
  const link = registry.linkOf(workspace.environmentId);
  const wire = await link.request<WireSessionMeta>("session.create", { workspaceId: workspace.id, cwd: workspace.path, threadType: "chat", title });
  sessionStore.adopt({ ...wire, environmentId: link.environmentId }, { created: true });
  await bridgeNewThread(link.environmentId, wire.id).catch(() => {});
  return wire.id;
}

function useOpener({ workspace, reach }: ViewProps, setBusy: (busy: Busy) => void) {
  /** The file as it is once its bytes are here: OneDrive downloads one it keeps in the cloud. */
  const fetched = async (entry: TeamsEntry, library: ShownLibrary): Promise<TeamsEntry> => {
    if (entry.local) return entry;
    setBusy({ path: entry.path, word: "Downloading…" });
    return (await registry.linkOf(library.env).request<{ entry: TeamsEntry }>("work.office.filesFetch", { source: source(library, entry) })).entry;
  };
  const app = async (entry: TeamsEntry, library: ShownLibrary): Promise<void> => {
    try {
      await fetched(entry, library);
      setBusy({ path: entry.path, word: "Opening…" });
      await registry.linkOf(library.env).request("work.office.filesOpen", { source: source(library, entry) });
    } catch (err) {
      failed(`${entry.name} did not open`, err);
    } finally {
      setBusy(null);
    }
  };
  const open = async (entry: TeamsEntry, library: ShownLibrary): Promise<void> => {
    const way = openWay(entry, library, workspace.environmentId, reach.copy);
    if (way === "app") return app(entry, library);
    try {
      const here = await fetched(entry, library);
      setBusy({ path: entry.path, word: "Opening…" });
      const sessionId = await newThread(workspace, entry.name);
      const ws = registry.linkOf(workspace.environmentId);
      let at = teamsCanvasOf(here, library.host)!;
      if (way === "copy") {
        const copy = await ws.request<{ source: { at: "file"; host: string; path: string } }>("work.office.filesCopy", { sessionId, source: source(library, here) });
        at = teamsCanvasOf({ ...here, path: copy.source.path }, copy.source.host, true)!;
      } else if (at.source.at === "microsoft") {
        // Excel, Word or PowerPoint stands behind the item: the file opens there too.
        await registry.linkOf(library.env).request("work.office.filesOpen", { source: source(library, here) });
      }
      await ws.request<{ item: CanvasItem }>("work.canvas.open", { sessionId, kind: at.kind, source: at.source, title: entry.name });
      workOpenPort.get()?.(sessionId);
    } catch (err) {
      failed(`${entry.name} did not open`, err);
    } finally {
      setBusy(null);
    }
  };
  return { open, app };
}

