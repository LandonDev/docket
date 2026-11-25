import { lazy, Suspense, useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { FilePage, FileTab, SavedFileSearch } from "@shared/contract-work-files";
import { canvasSourcePath, filesPaneOf, type CanvasItem, type CanvasSource } from "@shared/work";
import { chipsOf, DEFAULT_SORT, kindOfEntry, PLACE, refKey, type FileEntry, type FilePlace, type FolderRef } from "@shared/work/files";
import { ChevronRight, Clock, Folder, Search, Star, Trash2, Users } from "../../chrome/icons";
import { confirmAction, confirmChoice } from "../../chrome/ConfirmDialog";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { DISCLOSURE_CHEVRON } from "../../components/ui/disclosure";
import { ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { Tip, TruncateTip } from "../../components/tip";
import { loadToast } from "../../components/ui/toaster";
import { registry, LOCAL_ENVIRONMENT_ID } from "../../lib/connection";
import { hostName } from "../../lib/threadResources";
import { linkMay, managedElsewhere, useLinksMay } from "../../lib/linkMay";
import { readyToClose } from "../canvas/closeDoor";
import { liveSourceOf } from "../office/live/liveSwitch";
import { filesPort, type FilesCommand } from "../../lib/filesKeys";
import { workErrorWords } from "../../lib/workErrorWords";
import { invoke } from "../../lib/native";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { shell } from "../../stores/shell";
import { openHeld } from "../canvas/held";
import { closeItem, useCanvas } from "../canvas/store";
import { Ask, Cloud, Home, Lifeos, Mail, Project } from "../icons";
import { allowComputers } from "../shell/actions";
import { useHostLive, useLiveDown } from "../shell/lifeosLive";
import { readsSession, searchReadsLifeos, sessionCopyOf, sessionFolderOf } from "./lifeosPlace";
import { desktopsFor } from "../shell/desktops";
import { openTemplates, workTemplatePort } from "../templates/open";
import type { WorkViewProps } from "../views/registry";
import { openVm, signInOnVm } from "../winvm/signIn";
import { addFromDrive, carryTo, download, downloadOf, makeIn, purge, renameTo, restore, star, trash, uploadTo, type ActsOf, type UploadProgress, keepMail, setProject } from "./acts";
import { FileTabView, type FileManage } from "./FileTabView";
import type { GoToRow } from "./GoTo";
import { filterChoices, HomePage, SaveSearchDialog, SearchFilters } from "./Home";
import { MoveDialog, type MoveTarget } from "./MoveDialog";
import { cutsMiddle, MiddleCut } from "../canvas/TabName";
import { carryRefusal, readRefused, tabEnds, tabShowing, samePage, sitsAtSide, HOME_PAGE, isHomePage, isSearchPage, savedIdOf, savedSearchPage, searchPage, actsFor, placeDown, placeOfRef, placePage, readCopy, deskPlace, sidebarFolds, teamOfPage, teamPage, trailOf, type FilesNote, type PlaceCopy, type PlaceRow, type Sidebar as SidebarModel, type SidebarRow } from "./model";
import { tellOrigin } from "./saveAsPort";
import "./bindings";
import { closeOf, FILES_KEYS, landFocus } from "./chords";
import { historyBeside } from "./SideFile";
import { marked, type Busy, type MarkBusy } from "./busy";
import { fetchHere, fileOf, openEntry, openInApp, opensInApp } from "./open";
import { BarBones, ListBones, PageBar, PageView, type NoteFixes, type PageActs, type PageCommands, type PageFind } from "./Page";
import { formFolderOf, formKindsFor, twinOf } from "../msforms/newForm";
import { useFormMaking } from "../msforms/useFormMaking";
import { useSideOpen, hasClosed, openAtSide, closeSide, openFileTab, rememberClosed, takeClosed, dropSearch, saveSearch, useHome, useSavedSearches, useSearchFilter, closeTab, firstPage, goTo, historyOf, keepBothCopy, loadTabs, moveTabs, openPageTab, reloadCopy, selectTab, sendCopyBack, tabsNow, teamRows, useDock, useListing, usePageLook, reachAnswered, useReach, searchReplaces, useSidebarFolded, useTabs, type DeskSearch, type ListFrom, type Reach } from "./store";
import { farName } from "./farLink";
import { closeCopyTab } from "./copyClose";
import { DragLabelLayer, dragging, dropVerb, ROWS_MIME, setDragging, setDragLabel } from "./rowParts";
import { filesPanelId, TabRow } from "./TabRow";
import { shareTargetOf } from "../guests/api";

const ShareSheet = lazy(() => import("../guests/ShareSheet"));

/**
 * The Files place of a Work workspace (docs/agents/work-files.md, docs/DESIGN.md "The Files place"): the finder
 * with tabs. Left, the places a file can live in; top, the workspace's tabs, each a folder he is browsing or a
 * file open as itself; middle, the folder's list or the file in its own viewer. Nothing closes behind him: a
 * folder opens in the tab he is in, a file in a tab of its own.
 */

/** The page shown when no Teams place is listed: it says the one cause, with its press. */
/** The lenses of his marks: they list LifeOS's rows beside files on disk. */
const MARK_LENSES: ReadonlySet<FilePlace["kind"]> = new Set<FilePlace["kind"]>(["recent", "starred", "made"]);
/** The Starred lens, where no host lists one: asked of no one. */
const STARRED_AT: FolderRef = { at: "place", id: PLACE.starred };
const TEAMS_PAGE: FilePage = { at: { at: "place", id: "teams" }, name: "Teams files" };

/** Under this much room the sidebar folds itself away; its toggle brings it back over the list. */
export const SIDEBAR_FOLD_AT = 640;
/** The narrow sidebar lies over the list from under the 36px tab row down, so the toggle that opened it stays in reach to close it. */
export const SIDEBAR_OVER = "absolute top-9 bottom-0 left-0 z-20 flex";

const SIDE_ROW = `h-7 w-full min-w-0 flex-nowrap gap-2 rounded-md px-2 py-0 text-[13px] ${ROW_PRESS}`;

/** What a drag of rows does over the sidebar's places and folders: whether one takes it, and the drop. */
export interface SideDrop {
  /** the target a drag is over now */
  at: string | null;
  over(target: MoveTarget, key: string, event: DragEvent): boolean;
  leave(key: string): void;
  drop(target: MoveTarget, event: DragEvent): void;
}

/** A place's or a folder's folders under its row, where it stands open. */
export interface SideTree {
  workspaceId: string;
  open: ReadonlySet<string>;
  toggle(key: string, open: boolean): void;
}

function SideRow({
  icon,
  name,
  on,
  down,
  count,
  depth = 0,
  keep,
  fold,
  target,
  drop,
  onClick,
  onAuxClick,
}: {
  icon: ReactNode;
  name: string;
  on: boolean;
  down?: boolean;
  /** how many wait there, at the row's end (From mail) */
  count?: number;
  /** how deep under its place: 16px a level */
  depth?: number;
  /** where the name keeps its end when places share a start (`tabEnds`): cut in its middle */
  keep?: number | null;
  /** the quiet chevron at the row's end, always drawn where the row has folders to show */
  fold?: { open: boolean; toggle(): void };
  /** where a drop on this row puts things */
  target?: { key: string; to: MoveTarget };
  drop?: SideDrop;
  onClick(): void;
  onAuxClick?(): void;
}) {
  const over = !!target && drop?.at === target.key;
  return (
    <div
      className="relative flex min-w-0"
      {...(target && drop
        ? {
            onDragOver: (event: DragEvent) => {
              if (drop.over(target.to, target.key, event)) event.preventDefault();
            },
            onDragLeave: () => drop.leave(target.key),
            onDrop: (event: DragEvent) => {
              event.preventDefault();
              drop.drop(target.to, event);
            },
          }
        : {})}
    >
      <ItemButton
        size="xs"
        aria-current={on ? "page" : undefined}
        data-files-place={name}
        data-down={down || undefined}
        data-drop-over={over || undefined}
        style={depth ? { paddingInlineStart: 8 + depth * 16 } : undefined}
        className={`${SIDE_ROW} ${fold ? "pe-7" : ""} ${on || over ? "bg-sidebar-group-selected" : ""}`}
        onClick={onClick}
        onAuxClick={(event) => {
          if (event.button === 1) onAuxClick?.();
        }}
      >
        <span className={`flex shrink-0 text-muted-foreground ${down ? "opacity-50" : ""}`}>{icon}</span>
        {/* A name cut in the 200px sidebar has its whole text in a tooltip, as the trail's folder does. */}
        <TruncateTip text={name}>
          {cutsMiddle(name, keep) ? (
            <MiddleCut text={name} keep={keep} className="flex-1 text-start text-foreground" />
          ) : (
            <span className="min-w-0 flex-1 truncate text-start text-foreground">{name}</span>
          )}
        </TruncateTip>
        {count ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{count}</span> : null}
      </ItemButton>
      {fold ? (
        <Button variant="ghost" size="icon-xs" aria-label={fold.open ? `Hide the folders of ${name}` : `Show the folders of ${name}`} aria-expanded={fold.open} className="absolute end-0.5 top-0.5 text-muted-foreground" onClick={fold.toggle}>
          <ChevronRight className={`${DISCLOSURE_CHEVRON} ${fold.open ? "rotate-90" : ""}`} />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The folders of one folder or place, under its row: each a row of its own, 16px in, that opens the same way. Read when
 * the row is opened, never before. While they are read one bone row stands at their depth; none is "No folders"; a
 * read that failed is "Did not load" with Retry (its cause in the tip), and no Retry where he may not read it.
 */
function SideFolders({ from, at, depth, current, tree, drop, onGo, onNewTab }: { from: ListFrom; at: FolderRef; depth: number; current: FolderRef | null; tree: SideTree; drop?: SideDrop; onGo(page: FilePage): void; onNewTab(page: FilePage): void }) {
  const listing = useListing(from, at, DEFAULT_SORT);
  const folders = listing.entries.filter((entry) => entry.folder);
  const inset = { paddingInlineStart: 8 + depth * 16 };
  // His Retry is a read under way too: the bone again, in the failure's place.
  if (!listing.loaded || listing.retrying)
    return (
      <div role="status" aria-label="Loading" aria-busy data-files-side-state="loading" className="flex h-7 items-center gap-2 pe-2" style={inset}>
        <Skeleton className="size-4 shrink-0 rounded-sm" />
        <Skeleton className="h-3 w-[55%]" />
      </div>
    );
  if (listing.error && !folders.length)
    return (
      <div data-files-side-state="failed" className="flex h-7 min-w-0 items-center gap-1 pe-1 text-xs" style={inset}>
        <Tip label={listing.error}>
          <span className="min-w-0 truncate text-destructive">Did not load</span>
        </Tip>
        {readRefused(listing.error) ? null : (
          <Button variant="ghost" size="xs" className="ms-auto shrink-0 text-muted-foreground" onClick={() => void listing.retry()}>
            Retry
          </Button>
        )}
      </div>
    );
  if (!folders.length)
    return (
      <div data-files-side-state="none" className="flex h-7 items-center pe-2 text-xs text-muted-foreground" style={inset}>
        No folders
      </div>
    );
  return (
    <>
      {folders.map((entry) => {
        const key = entry.key;
        const open = tree.open.has(key);
        const page = { at: entry.folder!, name: entry.name };
        return (
          <div key={key} className="flex flex-col">
            <SideRow
              icon={<Folder className="size-4" />}
              name={entry.name}
              depth={depth}
              on={!!current && samePage(current, entry.folder!)}
              fold={{ open, toggle: () => tree.toggle(key, !open) }}
              target={{ key, to: { copy: from.copy, at: entry.folder!, name: entry.name } }}
              drop={drop}
              onClick={() => onGo(page)}
              onAuxClick={() => onNewTab(page)}
            />
            {open ? <SideFolders from={from} at={entry.folder!} depth={depth + 1} current={current} tree={tree} drop={drop} onGo={onGo} onNewTab={onNewTab} /> : null}
          </div>
        );
      })}
    </>
  );
}

const placeIcon = (row: Pick<PlaceRow, "kind">): ReactNode => (row.kind === "onedrive" ? <Cloud className="size-4" /> : <Users className="size-4" />);

/** The places, in three quiet groups 16px apart: his marks; the places a file lives in; the lenses that arrive with their milestones. */
export function SidebarView({
  model,
  workspace,
  at,
  note,
  searches = [],
  tree,
  drop,
  onGo,
  onNewTab,
}: {
  model: SidebarModel;
  workspace: WorkspaceMeta;
  at: FolderRef | null;
  note: FilesNote | null;
  /** his saved searches: a row each under Starred */
  searches?: readonly SavedFileSearch[];
  /** the places open to their folders; absent, a place is one row (a preview, a host a release behind) */
  tree?: SideTree;
  drop?: SideDrop;
  onGo(page: FilePage): void;
  onNewTab(page: FilePage): void;
}) {
  const here = at ? placeOfRef(model, at) : null;
  const team = at ? teamOfPage(at) : null;
  // Places and projects that share a start keep the ends that differ ("OneDrive - Purdue…", "OneDrive - Personal").
  const named = [...(model.folder ? [workspace.name] : []), ...model.places.map((p) => (p.is === "team" ? p.name : p.row.name)), ...model.drives.map((d) => placePage(d).name), ...model.projects.map((p) => placePage(p).name)];
  const ends = new Map(tabEnds(named).map((keep, i) => [named[i]!, keep]));
  const row = (page: FilePage, icon: ReactNode, on: boolean, down = false, count?: number): ReactNode => (
    <SideRow key={page.name + JSON.stringify(page.at)} icon={icon} name={page.name} keep={ends.get(page.name)} on={on} down={down} {...(count ? { count } : {})} onClick={() => onGo(page)} onAuxClick={() => onNewTab(page)} />
  );
  const lensIcon = (kind: PlaceCopy["place"]["kind"]): ReactNode => (kind === "mail" ? <Mail className="size-4" /> : kind === "made" ? <Ask className="size-4" /> : <Trash2 className="size-4" />);
  /** A place that is itself and not a folder of a disk: standing on it, or on a folder of it. */
  const onPlace = (copy: PlaceCopy): boolean => !!here && here.copy === copy;
  /** A place a file lives in: its row, its chevron, and under it its folders where it stands open. */
  const home = (copy: PlaceCopy, page: FilePage, icon: ReactNode, on: boolean, down = false): ReactNode => {
    const name = page.name;
    const key = `place:${copy.place.key ?? copy.place.id}`;
    const open = !!tree?.open.has(key);
    const listed = !!tree && copy.wire === "files" && !down;
    return (
      <div key={key} className="flex flex-col">
        <SideRow
          icon={icon}
          name={name}
          keep={ends.get(name)}
          on={on}
          down={down}
          {...(listed ? { fold: { open, toggle: () => tree!.toggle(key, !open) }, target: { key, to: { copy, at: page.at, name } }, drop } : {})}
          onClick={() => onGo(page)}
          onAuxClick={() => onNewTab(page)}
        />
        {listed && open ? <SideFolders from={{ workspaceId: tree!.workspaceId, copy }} at={page.at} depth={1} current={at} tree={tree!} drop={drop} onGo={onGo} onNewTab={onNewTab} /> : null}
      </div>
    );
  };
  const place = (p: SidebarRow): ReactNode => {
    if (p.is === "team") return row(teamPage(p.name), <Users className="size-4" />, team === p.name || (!!here?.row && here.row.group === p.name), p.rows.every(placeDown));
    return home(readCopy(p.row), placePage(readCopy(p.row), p.row.name), placeIcon(p.row), here?.row?.key === p.row.key, placeDown(p.row));
  };
  return (
    <nav aria-label="Places" data-files-sidebar className="flex w-[200px] shrink-0 flex-col gap-4 overflow-x-hidden overflow-y-auto border-r border-border bg-sidebar px-2 py-2">
      {model.marks.length || model.home ? (
        <div className="flex flex-col">
          {model.home ? row(HOME_PAGE, <Home className="size-4" />, !!at && isHomePage(at)) : null}
          {model.marks.map((mark) =>
            row({ at: mark.place.root, name: mark.place.name }, mark.place.kind === "recent" ? <Clock className="size-4" /> : <Star className="size-4" />, at?.at === "place" && at.id === mark.place.id),
          )}
          {searches.map((search) => row(savedSearchPage(search), <Search className="size-4" />, !!at && savedIdOf(at) === search.id))}
        </div>
      ) : null}
      <div className="flex flex-col">
        <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Places</h2>
        {model.folder ? home(model.folder, { at: { at: "place", id: PLACE.folder }, name: workspace.name }, <Folder className="size-4" />, !!here && here.copy === model.folder) : null}
        {/* A project open as a folder of LifeOS is marked on its own row below, where there is one. */}
        {model.lifeos ? row(placePage(model.lifeos), <Lifeos className="size-4" />, onPlace(model.lifeos) && !(at?.at === "project" && model.projects.some((p) => p.place.id === `project:${at.id}`)), model.lifeos.place.state.state !== "ok") : null}
        {model.places.map(place)}
        {model.drives.map((drive) => row(placePage(drive), <Cloud className="size-4" />, onPlace(drive), drive.place.state.state !== "ok"))}
        {/* No Teams place answered: one greyed row that says why when opened, never an empty group. */}
        {!model.places.length && note ? row(TEAMS_PAGE, <Users className="size-4" />, at?.at === "place" && at.id === "teams", true) : null}
      </div>
      {model.projects.length ? (
        <div className="flex flex-col">
          <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Projects</h2>
          {model.projects.map((project) => row(placePage(project), <Project className="size-4" />, (at?.at === "place" && at.id === project.place.id) || (at?.at === "project" && project.place.id === `project:${at.id}`)))}
        </div>
      ) : null}
      {model.lenses.length ? (
        <div className="flex flex-col">{model.lenses.map((lens) => row({ at: lens.place.root, name: lens.place.name }, lensIcon(lens.place.kind), at?.at === "place" && at.id === lens.place.id, false, lens.place.count))}</div>
      ) : null}
    </nav>
  );
}

const say = (title: string, err?: unknown): void => void loadToast().then((toast) => (err === undefined ? toast.message(title) : toast.error(title, { description: workErrorWords(err) || undefined })));

/** A note's press: it spins until done; a refusal is one toast. One this window's key may not make says who can instead. */
function useFixes(workspace: WorkspaceMeta, again: () => Promise<void>): NoteFixes {
  const [busy, setBusy] = useState(false);
  const may = useLinksMay();
  return {
    busy,
    elsewhere(fix) {
      const host = registry.environment(workspace.environmentId)?.name ?? "it";
      if (fix.kind === "allow") return may(workspace.environmentId, "work.workspace.set") ? null : managedElsewhere(host);
      if (fix.kind === "sign-in") return may(fix.link, "work.office.vmSignIn") ? null : managedElsewhere(registry.environment(fix.link)?.name ?? host);
      return null;
    },
    run(fix) {
      if (fix.kind === "settings") return shell.openSettings("work");
      if (fix.kind === "open-vm") return void openVm(fix.link);
      setBusy(true);
      // Retry asks each host for its places again, and spins until they have answered.
      if (fix.kind === "retry") return again().finally(() => setBusy(false));
      const done =
        fix.kind === "allow"
          ? allowComputers(workspace, { vm: fix.vm }).then(again)
          : fix.kind === "sign-in"
            ? signInOnVm(fix.link)
            : // Waking the VM is what listing a folder there does: the places are asked again once it answers.
              registry
                .linkOf(fix.link)
                .request("work.office.vmStatus", {})
                .then(again);
      void Promise.resolve(done)
        .catch((err: unknown) => say(fix.kind === "allow" ? "Not allowed" : fix.kind === "sign-in" ? "The sign-in did not open" : "The Windows VM did not wake", err))
        .finally(() => setBusy(false));
    },
  };
}

/** A place whose computer this window reaches only through the workspace's host: its greyed verbs name that road. */
const farOf = (copy: PlaceCopy, via: string): { far?: { computer: string; via: string } } => (registry.has(copy.link) ? {} : { far: { computer: copy.host, via: hostName(via) } });

export function View(props: WorkViewProps) {
  const { workspace } = props;
  const [attempt, setAttempt] = useState(0);
  const reach = useReach(workspace, attempt);
  const again = (): Promise<void> => {
    const asked = reachAnswered(workspace, attempt + 1);
    setAttempt((n) => n + 1);
    return asked;
  };
  if (!reach) return <Frame />;
  return <Place {...props} reach={reach} again={again} />;
}

/** The place's own frame while nothing has answered yet: its regions drawn, the list in bones, so nothing moves when the places land. */
function Frame() {
  return (
    <div data-files-view data-loading className="@container/files flex h-full min-h-0 bg-background">
      <div className="hidden w-[200px] shrink-0 border-r border-border bg-sidebar @[640px]/files:block" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="h-9 shrink-0 border-b border-border bg-sidebar" />
        <BarBones />
        <ListBones />
      </div>
    </div>
  );
}

function Place({ workspace, reach, again, startThread }: WorkViewProps & { reach: Reach; again(): Promise<void> }) {
  const link = workspace.environmentId;
  // A new tab opens on Home where the workspace's host has one; else on the workspace's folder.
  const first = reach.sidebar.home ? HOME_PAGE : firstPage(workspace);
  const view = useTabs(link, workspace.id, reach.tabs, first);
  const [folded, setFolded] = useSidebarFolded(workspace.id);
  const [width, setWidth] = useState(0);
  // The rows his acts are changing, each with its own words (busy.ts).
  const [busy, setBusy] = useState<Busy>(null);
  const markBusy = useCallback<MarkBusy>((keys, next) => setBusy((now) => marked(now, keys, next)), []);
  const [copyOn, setCopyOn] = useState(reach.copy);
  useEffect(() => setCopyOn(reach.copy), [reach.copy]);
  const root = useRef<HTMLDivElement>(null);
  const fixes = useFixes(workspace, again);

  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = (): void => setWidth(el.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const tab = view.tabs.find((t) => t.id === view.selected) ?? view.tabs[0] ?? null;
  const [docked] = useDock(workspace.id, tab?.kind === "file" ? tab.id : null);
  // Narrow, or under 900px with a chat docked beside the file, the sidebar is folded away until he asks for it; wide, it is there unless he folded it.
  const narrow = sidebarFolds(width, docked, SIDEBAR_FOLD_AT);
  const [peek, setPeek] = useState(false);
  const sidebarOpen = narrow ? peek : !folded;

  const pane = filesPaneOf(workspace.id);
  // The pane's items are asked for only where the host keeps tabs: a host a release behind has no such pane.
  const canvas = useCanvas(link, reach.tabs ? pane : `${pane}:none`);
  const page = tab?.kind === "page" ? (tab.page ?? first) : null;
  const history = tab ? historyOf(link, workspace.id, tab.id) : null;

  const go = (next: FilePage): void => {
    if (!tab) return;
    if (narrow) setPeek(false);
    // From a file's tab a place opens in a tab of its own: the file stays where it is.
    if (tab.kind !== "page") return void openPageTab(link, workspace.id, next, tab.id).catch((err: unknown) => say("The tab did not open", err));
    void goTo(link, workspace.id, tab.id, next).catch((err: unknown) => say("The folder did not open", err));
  };
  const newTab = (next: FilePage = first): void => void openPageTab(link, workspace.id, next, tab?.id).catch((err: unknown) => say("The tab did not open", err));
  // A tab is remembered as it closes, so the one last closed can be opened again (this window's own list).
  const [, closedNow] = useState(0);
  const remember = (tabId: string): void => {
    const gone = view.tabs.find((t) => t.id === tabId);
    if (!gone) return;
    if (gone.kind === "page" && gone.page) rememberClosed(link, workspace.id, { page: gone.page });
    const item = gone.kind === "file" ? canvas.items.find((i) => i.id === gone.itemId) : null;
    const ref = item ? fileOf(gone, item) : null;
    if (ref) rememberClosed(link, workspace.id, { file: { ref, name: gone.name, ...(gone.key ? { key: gone.key } : {}) } });
    closedNow((n) => n + 1);
  };
  // A copy whose changes have not reached its file asks once before its tab closes (copyClose.ts).
  const closeOne = async (tabId: string): Promise<void> => {
    // The door every canvas item leaves by (canvas/closeDoor.ts): what the tab's kind still holds reaches the host,
    // then a live file's guest unloads; Word may hold it while still saving (office/live/layer.ts).
    const pressed = view.tabs.find((t) => t.id === tabId);
    if (pressed?.itemId && !(await readyToClose(pressed.itemId, pressed.name))) return;
    // The file at its side goes with it: what that one holds is sent first too.
    if (pressed?.side && !(await readyToClose(pressed.side.itemId, pressed.side.name))) return;
    // The send may have changed how its copy stands (ok to away): the ask reads the tab as the host says it now.
    const gone = tabsNow(link, workspace.id).find((t) => t.id === tabId) ?? pressed;
    const done = async (discard: boolean): Promise<void> => {
      remember(tabId);
      // The file's History goes with its tab: it showed at the file's side, and nowhere else.
      const history = historyBeside(canvas.items, canvas.items.find((i) => i.id === pressed?.itemId) ?? null);
      await closeTab(link, workspace.id, tabId, first, discard);
      if (history) void closeItem(link, pane, history.id).catch(() => undefined);
    };
    if (!gone?.copyOf || (!gone.back && !gone.stays)) return done(false);
    // A copy whose edits go nowhere: whether it holds any is the host's look after the send above (its file's time).
    const now = gone.back ? gone : ((await loadTabs(link, workspace.id, first).then(() => tabsNow(link, workspace.id).find((t) => t.id === tabId))) ?? gone);
    await closeCopyTab(now, copyHostOf(now, reach), { choose: confirmChoice, confirm: confirmAction, close: done, keepBoth: () => keepBothCopy(link, workspace.id, tabId) });
  };
  // After a close the focus lands on what is left (chords.ts `landFocus`) once the window draws it.
  const landing = useRef(false);
  const close = (tabId: string): void => {
    landing.current = true;
    void closeOne(tabId).catch((err: unknown) => say("The tab did not close", err));
  };
  // The file at a tab's side leaves by the same door: what it holds is sent before it goes.
  const closeSideOf = async (tab: FileTab): Promise<void> => {
    if (tab.side && !(await readyToClose(tab.side.itemId, tab.side.name))) return;
    landing.current = true;
    await closeSide(link, workspace.id, tab.id);
  };
  const closeAtSide = (tab: FileTab): void => void closeSideOf(tab).catch((err: unknown) => say("The file did not close", err));
  // A file's History, at its side: closed as a pane item, since it is in no tab.
  const closeHistory = (itemId: string): void => {
    landing.current = true;
    void closeItem(link, pane, itemId).catch((err: unknown) => say("History did not close", err));
  };
  const shownHistory = tab?.kind === "file" ? historyBeside(canvas.items, canvas.items.find((i) => i.id === tab.itemId) ?? null) : null;
  const closeMany = async (tabIds: readonly string[]): Promise<void> => {
    for (const id of tabIds) await closeOne(id).catch((err: unknown) => say("The tab did not close", err));
  };
  const reopen = (): void => {
    const was = takeClosed(link, workspace.id);
    closedNow((n) => n + 1);
    if (!was) return;
    if ("page" in was) return void openPageTab(link, workspace.id, was.page, tab?.id).catch((err: unknown) => say("The tab did not open", err));
    void openFileTab(link, workspace.id, was.file, tab?.id).catch((err: unknown) => say(`${was.file.name} did not open`, err));
  };

  // The app's own tab chords act on these tabs while focus is in the place (lib/filesKeys.ts).
  const act = useRef<(command: FilesCommand) => void>(() => undefined);
  const pageCommands: PageCommands = useRef(null);
  act.current = (command) => {
    const ids = view.tabs.map((t) => t.id);
    const at = tab ? ids.indexOf(tab.id) : -1;
    if (command === "new-tab") return newTab();
    if (command === "reopen-tab") return reopen();
    if (command === "new-folder") return pageCommands.current?.("new-folder");
    if (command === "go-to" || command === "search") {
      if (!canFind) return;
      const mode = command === "go-to" ? "goto" : "search";
      if (tab?.kind === "page") return setFinding({ tab: tab.id, mode });
      // A file has no trail to turn into a field: Go to opens in a tab of its own.
      wantFind.current = mode;
      return newTab();
    }
    if (!tab) return;
    if (command === "close-tab") {
      if (closeOf(document.activeElement) !== "side") return close(tab.id);
      // The side's seat holds History while it is open, else the second file.
      if (shownHistory) return closeHistory(shownHistory.id);
      return tab.side ? closeAtSide(tab) : close(tab.id);
    }
    if (command === "next-tab" || command === "prev-tab") return ids.length > 1 ? selectTab(link, workspace.id, ids[(at + (command === "next-tab" ? 1 : ids.length - 1)) % ids.length]!) : undefined;
    if (tab.kind !== "page" || !tab.page) return;
    void goTo(link, workspace.id, tab.id, tab.page, command === "back" ? "back" : "forward").catch(() => undefined);
  };
  useEffect(() => {
    filesPort.set((command) => act.current(command), FILES_KEYS);
    return () => filesPort.set(null);
  }, []);
  useEffect(() => {
    if (!landing.current || !root.current) return;
    const at = document.activeElement;
    if (at && at !== document.body && root.current.contains(at)) return;
    landing.current = false;
    landFocus(root.current);
  }, [tab?.id, tab?.side?.key, shownHistory?.id]);

  // Go to and Search stand in the trail's place of one tab at a time, where the workspace's host keeps the names.
  const canFind = reach.tabs && !view.local;
  const [finding, setFinding] = useState<{ tab: string; mode: "goto" | "search" } | null>(null);
  const wantFind = useRef<"goto" | "search" | null>(null);
  useEffect(() => {
    if (!wantFind.current || tab?.kind !== "page") return;
    setFinding({ tab: tab.id, mode: wantFind.current });
    wantFind.current = null;
  }, [tab?.id, tab?.kind]);
  const searches = useSavedSearches(link, workspace.id, canFind);

  const open = (entry: FileEntry, copy: PlaceCopy): void =>
    // "Open copies here" turns the workspace's copy on, the host's admin rule: a key that may not is never offered it.
    void openEntry(entry, copy, { workspace, tabs: reach.tabs && !view.local, copy: copyOn, opener: tab?.id, busy: markBusy, ...(linkMay(workspace.environmentId, "work.office.filesCopySet") ? { allowed: () => setCopyOn(true) } : {}) });
  // Open to the Side: a file goes at the side of the file tab he was last in, in that tab. Where he has been in none, it is not offered.
  const [lastFile, setLastFile] = useState<string | null>(null);
  const shownFile = tab?.kind === "file" ? tab.id : null;
  if (shownFile && shownFile !== lastFile) setLastFile(shownFile);
  const sideTab = reach.tabs && !view.local ? (view.tabs.find((t) => t.id === lastFile && t.kind === "file") ?? null) : null;
  const toSide = (file: { ref: CanvasSource; name: string }, into: FileTab): void => void openAtSide(link, workspace.id, file, into.id).catch((err: unknown) => say(`${file.name} did not open`, err));
  /** A file tab's own file goes to the side of another file tab: its tab goes, its item stays. */
  const tabToSide = (tabId: string, into: FileTab): void => {
    const from = view.tabs.find((t) => t.id === tabId);
    const item = from?.kind === "file" ? canvas.items.find((i) => i.id === from.itemId) : null;
    const ref = from && item ? fileOf(from, item) : null;
    if (from && ref && !from.copyOf) toSide({ ref, name: from.name }, into);
  };

  // What changes files here: each asks the file's own host (acts.ts). The dialog and an upload are the view's own.
  const of: ActsOf = { workspaceId: workspace.id, home: link, busy: markBusy };
  const [carrying, setCarrying] = useState<Carrying | null>(null);
  const [uploading, setUploading] = useState<UploadProgress | null>(null);
  const stopUpload = useRef<AbortController | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pickInto = useRef<{ copy: PlaceCopy; at: FolderRef } | null>(null);
  const upload = (copy: PlaceCopy, at: FolderRef, files: readonly File[]): void => {
    if (!files.length || stopUpload.current) return;
    const stop = new AbortController();
    stopUpload.current = stop;
    void uploadTo(of, copy, at, files, { onProgress: setUploading, signal: stop.signal }).finally(() => {
      stopUpload.current = null;
      setUploading(null);
    });
  };
  /** The copy of the place a row from Go to, a search or Home lives in. */
  const copyOf = (entry: FileEntry): PlaceCopy | null => {
    // A LifeOS row or a mail's file opens as its own place's page opens it.
    if (readsSession(entry)) return sessionCopyOf(reach.sidebar, entry);
    const ref = entry.folder ?? entry.ref;
    if (!ref || ref.at !== "file") return null;
    const found = placeOfRef(reach.sidebar, { at: "file", host: ref.host, path: ref.path });
    return found ? (found.row ? (found.row.copies.includes(found.copy) && found.copy.place.state.state !== "unreachable" ? found.copy : readCopy(found.row)) : found.copy) : null;
  };
  /** Show in Its Folder: the folder a row of a lens or of a search's results lives in, in this tab. */
  const reveal = (entry: FileEntry): void => {
    // A LifeOS row's folder is its project, else the top of LifeOS; a mail's file is in From mail.
    const lifeosFolder = readsSession(entry) ? sessionFolderOf(reach.sidebar, entry) : null;
    if (lifeosFolder) return go(lifeosFolder);
    const ref = entry.folder ?? entry.ref;
    if (!ref || ref.at !== "file") return say(`${entry.name} is not in a folder listed now`);
    const parent = ref.path.replace(/[\\/]+[^\\/]*$/, "");
    go({ at: { at: "file", host: ref.host, path: parent }, name: parent.split(/[\\/]/).pop() || entry.where?.name || "Folder" });
  };
  const openFound = (entry: FileEntry): void => {
    // A change a thread holds for his press opens in the Outbox, where he presses it.
    if (entry.held) return openHeld({ at: "host", id: entry.held.id }, link);
    if (entry.folder) return go({ at: entry.folder, name: entry.name });
    const copy = copyOf(entry);
    if (copy) return open(entry, copy);
    say(`${entry.name} is not in a place listed now`);
  };
  const onGoTo = (row: GoToRow): void => {
    if (row.is === "tab") return selectTab(link, workspace.id, row.tab.id);
    if (row.is === "entry") return openFound(row.entry);
    // "New sheet called travel": made in the folder shown where its place makes that kind, else in the workspace's folder.
    const here = page ? placeOfRef(reach.sidebar, page.at) : null;
    const target = here && here.copy.place.makes?.includes(row.what) && page ? { copy: here.copy, at: page.at } : reach.sidebar.folder ? { copy: reach.sidebar.folder, at: reach.sidebar.folder.place.root } : null;
    if (!target) return say("There is no place here to make that in");
    void makeIn(of, target.copy, target.at, row.what, row.name).then((made) => made && openFound(made));
  };
  const find: PageFind | null =
    canFind && tab?.kind === "page"
      ? {
          link,
          workspaceId: workspace.id,
          tabs: view.tabs,
          mode: finding?.tab === tab.id ? finding.mode : null,
          setMode: (mode) => setFinding(mode ? { tab: tab.id, mode } : null),
          onGoTo,
          onSearch: (text) => go(searchPage(text)),
        }
      : null;

  // The sidebar's places stand open to their folders as this window left them, and each is a place to drop rows on.
  const [sideOpen, setSideOpen] = useSideOpen(workspace.id);
  const tree: SideTree | undefined = canFind ? { workspaceId: workspace.id, open: sideOpen, toggle: setSideOpen } : undefined;
  const [dropAt, setDropAt] = useState<string | null>(null);
  /** The verb a drop of the dragged rows on a target asks, or null where the grammar refuses it. */
  const dropHow = (to: MoveTarget, event: DragEvent): { verb: "move" | "copy"; drag: NonNullable<ReturnType<typeof dragging>> } | null => {
    const drag = dragging();
    const types = [...event.dataTransfer.types];
    // Rows the system carries read as files; they are still the rows being dragged.
    if (!drag || !(types.includes(ROWS_MIME) || types.includes("Files"))) return null;
    const verb = dropVerb(event, drag.from.place.id === to.copy.place.id && drag.from.link === to.copy.link);
    if (drag.entries.some((e) => (e.folder && samePage(e.folder, to.at)) || carryRefusal(drag.from.place, verb, e, to.copy.place) !== null)) return null;
    return { verb, drag };
  };
  const sideDrop: SideDrop = {
    at: dropAt,
    over(to, key, event) {
      const how = dropHow(to, event);
      if (!how) return false;
      event.dataTransfer.dropEffect = how.verb;
      if (dropAt !== key) setDropAt(key);
      setDragLabel({ text: `${how.verb === "copy" ? "Copy" : "Move"} to ${to.name}`, x: event.clientX, y: event.clientY });
      return true;
    },
    leave(key) {
      if (dropAt !== key) return;
      setDropAt(null);
      setDragLabel(null);
    },
    drop(to, event) {
      const how = dropHow(to, event);
      setDropAt(null);
      setDragLabel(null);
      setDragging(null);
      if (how) void carryTo(of, how.verb, how.drag.from, how.drag.entries, to, how.drag.back);
    },
  };
  /** The file tab another file tab can go to the side of: the one shown, else the one he was in before he pressed this one. Null where there is none, or the tab is a copy's. */
  const before = useRef<string | null>(null);
  if (shownFile !== lastFile && lastFile) before.current = lastFile;
  const sideInto = (tabId: string): FileTab | null => {
    const from = view.tabs.find((t) => t.id === tabId);
    if (!from || from.kind !== "file" || from.copyOf) return null;
    // Only a file on a disk sits at a side today: a LifeOS or Drive file opens in a tab of its own.
    const fromItem = canvas.items.find((i) => i.id === from.itemId);
    if (!fromItem || !sitsAtSide(fromItem.source)) return null;
    const target = view.tabs.find((t) => t.kind === "file" && t.id !== tabId && (t.id === (tab?.kind === "file" && tab.id !== tabId ? tab.id : before.current)));
    return target && !target.copyOf ? target : null;
  };
  /** A folder's tab takes a drop too, and comes forward when a drag rests on it. */
  const tabTarget = (tabId: string): MoveTarget | null => {
    const page = view.tabs.find((t) => t.id === tabId)?.page;
    if (!page || isHomePage(page.at) || isSearchPage(page.at)) return null;
    const found = placeOfRef(reach.sidebar, page.at);
    const copy = found ? (found.row ? readCopy(found.row) : found.copy) : null;
    return copy && copy.wire === "files" && copy.place.kind !== "recent" && copy.place.kind !== "starred" && copy.place.kind !== "trash" ? { copy, at: page.at, name: page.name } : null;
  };

  const verbs: Verbs = {
    of,
    carry: setCarrying,
    upload,
    pickUpload: (copy, at) => {
      pickInto.current = { copy, at };
      picker.current?.click();
    },
    uploading,
    cancelUpload: () => stopUpload.current?.abort(),
    newTab,
    page: pageCommands,
    // Ask about a selection: a new chat of the workspace whose first message holds the files. It is a thread only once he sends.
    ask: (entries, copy) => {
      const got = chipsOf(entries, copy.place);
      if ("refused" in got) return say(got.refused);
      startThread(got.chips, { cwd: workspace.path, projectId: null });
    },
    openApp: (entry, copy) => void openInApp(entry, copy, { busy: markBusy }),
    ...(sideTab ? { openSide: (entry: FileEntry, copy: PlaceCopy) => (entry.ref && copy.link === link && !copy.place.vm ? toSide({ ref: entry.ref, name: entry.name }, sideTab) : open(entry, copy)), sideOf: sideTab.id } : {}),
  };

  let body: ReactNode;
  // Until the tabs come the page is its bones, the bar's with the list's, so nothing moves when the page lands.
  if (!view.loaded || !tab)
    body = (
      <>
        <BarBones />
        <ListBones />
      </>
    );
  else if (tab.kind === "file")
    body = (
      <OpenFile
        tab={tab}
        workspace={workspace}
        reach={reach}
        items={canvas.items}
        verbs={verbs}
        onClose={() => close(tab.id)}
        onCloseSide={() => closeAtSide(tab)}
        onCloseHistory={closeHistory}
        onShowFolder={(page) => {
          const there = tabShowing(view.tabs, page.at, tab.opener);
          if (there) void selectTab(link, workspace.id, there.id);
          else newTab(page);
        }}
      />
    );
  else {
    const nav = { canBack: !!history?.back.length, canForward: !!history?.forward.length, onBack: () => act.current("back"), onForward: () => act.current("forward"), onGo: go };
    if (isHomePage(page!.at)) body = <HomeTab key={tab.id} tab={tab} workspace={workspace} busy={busy} find={find} onOpenFound={openFound} {...nav} />;
    else if (isSearchPage(page!.at)) body = <SearchTab key={tab.id} tab={tab} page={page!} workspace={workspace} reach={reach} busy={busy} fixes={fixes} find={find} searches={searches} onOpenFound={openFound} onReveal={reveal} {...nav} />;
    else body = <FolderPage key={tab.id} tab={tab} page={page!} workspace={workspace} reach={reach} busy={busy} fixes={fixes} verbs={verbs} find={find} onOpen={open} onReveal={reveal} {...nav} />;
  }

  return (
    <div ref={root} data-files-view className="@container/files relative flex h-full min-h-0 bg-background">
      {sidebarOpen ? (
        <div data-files-sidebar-over={narrow ? "" : undefined} className={narrow ? SIDEBAR_OVER : "flex"}>
          <SidebarView model={reach.sidebar} workspace={workspace} at={page?.at ?? null} note={reach.note} searches={searches} tree={tree} drop={sideDrop} onGo={go} onNewTab={newTab} />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <TabRow
          tabs={view.tabs}
          selected={tab?.id ?? null}
          sidebarOpen={sidebarOpen}
          onSidebar={() => (narrow ? setPeek((open) => !open) : setFolded(!folded))}
          onSelect={(id) => selectTab(link, workspace.id, id)}
          onClose={close}
          {...(view.local ? {} : { onCloseMany: (ids: string[]) => void closeMany(ids) })}
          {...(hasClosed(link, workspace.id) ? { onReopen: reopen } : {})}
          drop={{
            at: dropAt,
            over: (tabId, event) => {
              const to = tabTarget(tabId);
              return !!to && sideDrop.over(to, `tab:${tabId}`, event);
            },
            leave: (tabId) => sideDrop.leave(`tab:${tabId}`),
            drop: (tabId, event) => {
              const to = tabTarget(tabId);
              if (to) sideDrop.drop(to, event);
            },
          }}
          onReorder={(order) => void moveTabs(link, workspace.id, order).catch((err: unknown) => say("The tab did not move", err))}
          // A file tab goes to the side of the file tab shown, or of the one he was in before he pressed it.
          {...(reach.tabs && !view.local ? { side: { into: (tabId: string) => sideInto(tabId), move: (tabId: string) => { const into = sideInto(tabId); if (into) tabToSide(tabId, into); } } } : {})}
          onNew={() => newTab()}
        />
        {reach.behind.length ? <Behind hosts={reach.behind} tabs={reach.tabs} /> : null}
        {body}
      </div>
      <DragLabelLayer />
      {/* Upload files…: the system's picker, behind New. */}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        data-files-picker
        onChange={(event) => {
          const into = pickInto.current;
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (into) upload(into.copy, into.at, files);
        }}
      />
      {carrying ? (
        <MoveDialog
          verb={carrying.verb}
          entries={carrying.entries}
          from={carrying.from}
          start={carrying.start}
          sidebar={reach.sidebar}
          workspace={workspace}
          // Rows of one folder go back to it on Undo; a lens's rows each live somewhere of their own.
          onPick={(to, fail) => carryTo(of, carrying.verb, carrying.from, carrying.entries, to, carrying.entries.some((e) => e.where) ? undefined : carrying.start, fail)}
          onClose={() => setCarrying(null)}
        />
      ) : null}
    </div>
  );
}

/** Rows dragged out to the desktop: the system carries them where each is a file on this computer's disk; null where one is not. */
function dragOut(rows: readonly FileEntry[]): Promise<void> | null {
  const paths = rows.map((e) => (e.ref?.at === "file" && e.local !== false && e.state?.is !== "cloud" ? e.ref.path : null));
  if (!paths.length || paths.some((path) => path === null)) return null;
  return invoke<boolean>("drag_files_out", { paths }).then(
    () => undefined,
    () => undefined,
  );
}

/** Move to… or Copy to… under way: what goes, and the folder it is in. */
interface Carrying {
  verb: "move" | "copy";
  entries: readonly FileEntry[];
  from: PlaceCopy;
  start: { at: FolderRef; name: string };
}

/** What the view gives each page to change files with. */
interface Verbs {
  of: ActsOf;
  carry(next: Carrying): void;
  upload(copy: PlaceCopy, at: FolderRef, files: readonly File[]): void;
  pickUpload(copy: PlaceCopy, at: FolderRef): void;
  uploading: UploadProgress | null;
  cancelUpload(): void;
  newTab(page: FilePage): void;
  ask(entries: readonly FileEntry[], copy: PlaceCopy): void;
  openApp(entry: FileEntry, copy: PlaceCopy): void;
  /** Open to the Side, where a file tab he was last in can take a file at its side; `sideOf` is that tab */
  openSide?(entry: FileEntry, copy: PlaceCopy): void;
  sideOf?: string;
  /** the shown page's answer to a Files command it acts on (New Folder), set while it is drawn */
  page: PageCommands;
}

/** A host a release behind still lists its files; one quiet line says what it cannot do until it is updated. */
function Behind({ hosts, tabs }: { hosts: readonly string[]; tabs: boolean }) {
  const names = hosts.length < 2 ? (hosts[0] ?? "") : `${hosts.slice(0, -1).join(", ")} and ${hosts.at(-1)}`;
  return (
    <p data-files-behind role="status" className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
      {tabs ? `Update ${names} to open its files in tabs` : `Update ${names} to keep tabs here`}
    </p>
  );
}

function FolderPage({
  tab,
  page,
  workspace,
  reach,
  busy,
  fixes,
  verbs,
  find,
  canBack,
  canForward,
  onBack,
  onForward,
  onGo,
  onOpen,
  onReveal,
}: {
  tab: FileTab;
  page: FilePage;
  workspace: WorkspaceMeta;
  reach: Reach;
  busy: Busy;
  fixes: NoteFixes;
  verbs: Verbs;
  find: PageFind | null;
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
  onGo(page: FilePage): void;
  onOpen(entry: FileEntry, copy: PlaceCopy): void;
  onReveal(entry: FileEntry): void;
}) {
  const team = teamRows(reach.sidebar, page.at);
  const found = placeOfRef(reach.sidebar, page.at);
  // A team's page is read from no host; a lens and the folder from the workspace's own; a library folder from the copy that answers.
  const copy = found?.row ? (found.row.copies.includes(found.copy) && found.copy.place.state.state !== "unreachable" ? found.copy : readCopy(found.row)) : (found?.copy ?? null);
  const from: ListFrom | null = team ? (reach.sidebar.folder || reach.sidebar.rows[0] ? { workspaceId: workspace.id, copy: reach.sidebar.folder ?? readCopy(reach.sidebar.rows[0]!), team } : null) : copy ? { workspaceId: workspace.id, copy, old: reach.old.get(copy.link) } : null;
  // The host is asked in the order this window keeps for the page, so its pages come in the order the list shows.
  const [look] = usePageLook(page.at);
  const listing = useListing(from, page.at, look.sort ?? DEFAULT_SORT);
  const may = useLinksMay();
  const { offered: msOffered, making: makingForm, stage: formStage, make: makeAForm } = useFormMaking(workspace);
  const noTeams = page.at.at === "place" && page.at.id === "teams";
  const lost = !from && !team && !noTeams && !reach.waiting;
  const trail = team ? [{ name: page.name, at: page.at }] : trailOf(found?.row ?? null, listing?.trail ?? []);
  // The verbs for this page: only on the new wire, where the host says what its place does. A team's own page lists places, not files.
  const { of } = verbs;
  const trashIds = (entries: readonly FileEntry[]): string[] => entries.map((e) => e.key.replace(/^trash:/, ""));
  const into = (entry?: FileEntry): FolderRef => entry?.folder ?? page.at;
  // A document's or a sheet's Share sheet, from its row's menu: its links on the host that lists it.
  const [sharing, setSharing] = useState<FileEntry | null>(null);
  const shareTarget = sharing?.ref ? shareTargetOf(sharing.ref, sharing.kind === "sheet" ? "sheet" : "document") : null;
  const acts: PageActs | null =
    !team && copy && copy.wire === "files"
      ? {
          place: copy.place,
          from: copy,
          tabs: reach.tabs,
          ...farOf(copy, workspace.environmentId),
          make: (kind) => makeIn(of, copy, page.at, kind),
          forms: ((twin) => ({
            ...formKindsFor(copy.place, { sameHost: copy.link === workspace.environmentId, offered: msOffered, twin: !!twin }),
            making: makingForm,
            stage: formStage,
            // A library another computer holds is made in through the workspace host's copy of it.
            make: (kind) => makeAForm(kind, twin ? formFolderOf(page.at.at === "file" ? page.at : copy.place.root, copy, twin) : page.at.at === "file" ? page.at : copy.place.root),
          }))(twinOf(found?.row?.copies ?? [copy], copy, workspace.environmentId)),
          rename: (entry, name) => renameTo(of, copy, entry, name),
          carry: (verb, entries) => verbs.carry({ verb, entries, from: copy, start: { at: page.at, name: page.name } }),
          trash: (entries) => void trash(of, copy, entries),
          // Put Back and Delete for Good as this window's key may on the Trash's host: one it may not is not offered.
          ...(may(copy.link, "work.files.restore") ? { restore: (entries: readonly FileEntry[]) => void restore(of, copy.link, trashIds(entries)) } : {}),
          ...(may(copy.link, "work.files.purge") ? { purge: (entries?: readonly FileEntry[]) => void purge(of, copy.link, entries ? { ids: trashIds(entries), names: entries.map((e) => e.name) } : {}) } : {}),
          star: (entries, on) => void star(of, entries, on).then(() => listing.retry()),
          openTab: (entry) => entry.folder && verbs.newTab({ at: entry.folder, name: entry.name }),
          ...(verbs.openSide && copy.link === workspace.environmentId && !copy.place.vm ? { openSide: (entry: FileEntry) => verbs.openSide!(entry, copy) } : {}),
          // A mail's file is kept in the workspace's own folder; a project link is LifeOS's, kept on the workspace's host.
          ...(copy.place.kind === "mail" && reach.sidebar.folder ? { keep: (entries: readonly FileEntry[]) => void keepMail(of, copy, entries, { at: reach.sidebar.folder!.place.root, name: workspace.name }).then(() => listing.retry()) } : {}),
          ...(reach.sidebar.projects.length && copy.link === workspace.environmentId
            ? {
                projects: reach.sidebar.projects.map((p) => ({ id: p.place.id.replace(/^project:/, ""), name: p.place.name })),
                project: (entry: FileEntry, project: { id: string; name: string }, on: boolean) => void setProject(of, entry, project, on).then(() => listing.retry()),
              }
            : {}),
          ...(opensInApp(copy) ? { openApp: (entry: FileEntry) => verbs.openApp(entry, copy) } : {}),
          share: (entry: FileEntry) => entry.ref && setSharing(entry),
          ask: (entries) => verbs.ask(entries, copy),
          pickUpload: () => verbs.pickUpload(copy, page.at),
          // A Drive lists only what TempCode made or he picked: Add from Drive is the way more of it comes in.
          ...(copy.place.kind === "drive" && copy.place.root.at === "drive" ? { addFromDrive: () => void addFromDrive((copy.place.root as { account: string }).account).then((added) => void (added && listing.retry())) } : {}),
          // A template is a file: the templates pillar's dialog makes the copy here, in the workspace's own folder.
          ...(copy.place.kind === "folder" && workTemplatePort.get() ? { fromTemplate: () => void openTemplates({ workspaceId: workspace.id, into: page.at, intoName: page.name }) } : {}),
          upload: (files, entry) => verbs.upload(copy, into(entry), files),
          drop: (verb, entries, entry, from, back) => void carryTo(of, verb, from, entries, { copy, at: entry.folder!, name: entry.name }, back),
          // Out to the desktop, under Download's own rule: a file that lies on this computer, a shared one only where the workspace lives here too.
          ...(copy.link === LOCAL_ENVIRONMENT_ID && !copy.place.vm && (!copy.place.shared || copy.link === workspace.environmentId) ? { dragOut: (rows: readonly FileEntry[]) => dragOut(rows) } : {}),
          uploading: verbs.uploading,
          cancelUpload: verbs.cancelUpload,
        }
      : null;
  return (
    <>
      <PageView
        acts={noTeams || lost ? null : acts}
        find={find}
        page={page}
        panelId={filesPanelId(tab.id)}
        listing={noTeams || lost ? null : listing}
        copy={team ? null : copy}
        // A lens of his marks holds LifeOS's rows, which its host opens through its LifeOS session, for a job with a sector.
        lifeosHost={copy && workspace.sector && MARK_LENSES.has(copy.place.kind) ? copy.link : null}
        from={team ? null : from}
        trail={trail}
        canBack={canBack}
        canForward={canForward}
        busy={busy}
        commands={verbs.page}
        note={noTeams ? (reach.note ?? { title: "No Teams files" }) : lost ? { title: `${page.name} is not here any more`, line: "Its place is not listed now.", fix: { kind: "retry" } } : null}
        fixes={fixes}
        onBack={onBack}
        onForward={onForward}
        onGo={onGo}
        onOpen={(entry) => copy && onOpen(entry, copy)}
        onReveal={onReveal}
        // The Beside seat is the workspace's own host's: a file that lies there opens in it as itself.
        seat={!team && copy && copy.wire === "files" && reach.tabs && copy.link === workspace.environmentId && !copy.place.vm ? { workspace, can: (entry) => !!entry.ref } : null}
        {...(!team && copy ? { onFetch: (entry: FileEntry) => fetchHere(entry, copy, workspace.id).then(() => listing.retry()) } : {})}
      />
      {sharing && shareTarget && copy ? (
        <Suspense fallback={null}>
          <ShareSheet env={copy.link} target={shareTarget} title={sharing.name.replace(/\.tc(doc|sheet)$/i, "")} purdue={workspace.sector === "purdue"} onClose={() => setSharing(null)} />
        </Suspense>
      ) : null}
    </>
  );
}

interface Nav {
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
  onGo(page: FilePage): void;
}

/** Home in a tab: what waits on him, his stars and what he opened last, from the workspace's own host. */
function HomeTab({ tab, workspace, busy, find, onOpenFound, ...nav }: Nav & { tab: FileTab; workspace: WorkspaceMeta; busy: Busy; find: PageFind | null; onOpenFound(entry: FileEntry): void }) {
  const { home, error, retry } = useHome(workspace.environmentId, workspace.id);
  // Waiting on you holds LifeOS's rows too: while the host's LifeOS is down or on its way one line says so, and Home
  // reads again on return.
  const live = useHostLive(workspace.environmentId);
  useLiveDown(null, workspace.sector ? workspace.environmentId : null, retry);
  return <HomePage panelId={filesPanelId(tab.id)} home={home} error={error} busy={busy} onRetry={retry} onOpen={onOpenFound} lifeos={workspace.sector ? live : null} bar={<PageBar name="Home" trail={[]} find={find} {...nav} />} />;
}

/** A page of search results: his words in every place of the workspace's host, under the filters in its own bar. */
function SearchTab({
  tab,
  page,
  workspace,
  reach,
  busy,
  fixes,
  find,
  searches,
  onOpenFound,
  onReveal,
  ...nav
}: Nav & { tab: FileTab; page: FilePage; workspace: WorkspaceMeta; reach: Reach; busy: Busy; fixes: NoteFixes; find: PageFind | null; searches: readonly SavedFileSearch[]; onOpenFound(entry: FileEntry): void; onReveal(entry: FileEntry): void }) {
  const link = workspace.environmentId;
  const saved = searches.find((search) => search.id === savedIdOf(page.at)) ?? null;
  const [filter, setFilter] = useSearchFilter(tab.id, page, saved?.filter);
  const [saving, setSaving] = useState(false);
  const query = page.query ?? saved?.query ?? "";
  // The search is the workspace's own host's: it knows every place it lists. The folders on his desktops are
  // theirs to walk: the window asks each one it holds a link to itself, and a file found there opens from its place.
  const host = reach.sidebar.folder ?? reach.sidebar.home ?? reach.sidebar.marks[0] ?? null;
  const sidebar = useRef(reach.sidebar);
  useEffect(() => void (sidebar.current = reach.sidebar));
  const desks: DeskSearch = {
    find: () => desktopsFor([workspace], { nameOf: (id) => registry.environment(id)?.name ?? farName(id) }),
    placeOf: (desk, path) => deskPlace(sidebar.current, desk, path),
  };
  // New words name the ones this tab searched before: the host and his desktops stop those walks.
  const replaces = searchReplaces(tab.id, query);
  const from: ListFrom | null = host ? { workspaceId: workspace.id, copy: host, search: { query, filter, desks, ...(replaces !== undefined ? { replaces } : {}) } } : null;
  const listing = useListing(from, page.at, DEFAULT_SORT);
  return (
    <>
      <PageView
        page={page}
        panelId={filesPanelId(tab.id)}
        listing={from ? listing : null}
        copy={null}
        // The host the search is asked of reads LifeOS too, for a job with a sector, when the filter lets LifeOS's rows in.
        lifeosHost={from && workspace.sector && searchReadsLifeos(filter) ? from.copy.link : null}
        trail={[{ name: page.name, at: page.at }]}
        busy={busy}
        fixes={fixes}
        find={find}
        results
        onReveal={onReveal}
        pictures={host ? { workspaceId: workspace.id, copy: host } : null}
        under={
          <SearchFilters
            filter={filter}
            choices={filterChoices(reach.sidebar, host?.link ?? null)}
            saved={!!saved}
            onFilter={setFilter}
            onSave={() => setSaving(true)}
            onRemove={() => saved && void dropSearch(link, workspace.id, saved.id).catch((err: unknown) => say("The search was not removed", err))}
          />
        }
        onOpen={onOpenFound}
        {...nav}
      />
      {saving ? (
        <SaveSearchDialog
          query={query}
          onSave={(name) =>
            saveSearch(link, workspace.id, { name, query, filter }).then(
              (kept) => nav.onGo(savedSearchPage(kept)),
              (err: unknown) => say("The search was not saved", err),
            )
          }
          onClose={() => setSaving(false)}
        />
      ) : null}
    </>
  );
}

/** The computer a copy's file is on, as he names it: "MacBook", "the Windows VM". */
const copyHostOf = (tab: Pick<FileTab, "copyOf">, reach: Reach): string =>
  tab.copyOf?.vm ? "the Windows VM" : (reach.reads.find((r) => r.answer?.host === tab.copyOf?.host)?.name ?? "another computer");

function OpenFile({
  tab,
  workspace,
  reach,
  items,
  verbs,
  onClose,
  onCloseSide,
  onCloseHistory,
  onShowFolder,
}: {
  tab: FileTab;
  workspace: WorkspaceMeta;
  reach: Reach;
  items: readonly CanvasItem[];
  verbs: Verbs;
  onClose(): void;
  onCloseSide(): void;
  /** closes the file's History, open at its side */
  onCloseHistory(itemId: string): void;
  onShowFolder(page: FilePage): void;
}) {
  const item = items.find((i) => i.id === tab.itemId) ?? null;
  const sideItem = tab.side ? (items.find((i) => i.id === tab.side!.itemId) ?? null) : null;
  const historyItem = historyBeside(items, item);
  // Where the file is kept: the folder it lies in, by its place's own words where the place is known.
  const path = tab.copyOf?.path ?? (item ? canvasSourcePath(item.source) : null);
  const where = path ? (path.replace(/[\\/]+$/, "").split(/[\\/]/).slice(-2, -1)[0] ?? null) : null;
  const far = tab.copyOf ? reach.reads.find((r) => r.answer?.host === tab.copyOf!.host) : undefined;
  const farCopy = far && tab.copyOf ? reach.sidebar.rows.flatMap((r) => r.copies).find((c) => c.link === far.link && !!c.place.vm === !!tab.copyOf!.vm) : undefined;
  const link = workspace.environmentId;
  // A live tab keeps the file's origin in copyOf (for Edit here), but it is no copy: Office for the web holds the file itself.
  const copy = tab.copyOf && !liveSourceOf(item)
    ? {
        host: copyHostOf(tab, reach),
        ...(farCopy && opensInApp(farCopy) ? { openThere: () => void openInApp({ name: tab.name, key: tab.key ?? tab.id, ref: { at: "file", host: tab.copyOf!.host, path: tab.copyOf!.path } }, farCopy, { busy: () => undefined }) } : {}),
        // A copy that saves back: its line's presses, each asked of the workspace's host (files/copies.ts).
        ...(tab.back
          ? { send: () => sendCopyBack(link, workspace.id, tab.id), reload: () => reloadCopy(link, workspace.id, tab.id, tab.back?.writes), keepBoth: () => keepBothCopy(link, workspace.id, tab.id) }
          : {}),
      }
    : null;
  // The folder a file of this host is kept in opens beside it; a copy's folder is on another computer, shown from its place.
  const own = !tab.copyOf && item?.source.at === "file" && path ? item.source : null;
  const folder: FilePage | null = own && where ? { at: { at: "file", host: own.host, path: path!.replace(/[\\/]+[^\\/]*$/, "") }, name: where } : null;
  // The verbs for the file itself, as its row's menu has them: asked of the place it lies in, on that place's own host.
  const file = item ? fileOf(tab, item) : null;
  const lies = file?.at === "file" ? placeOfRef(reach.sidebar, { at: "file", host: file.host, path: file.path.replace(/[\\/]+[^\\/]*$/, "") }) : null;
  const place = lies ? (lies.row ? (lies.row.copies.includes(lies.copy) && lies.copy.place.state.state !== "unreachable" ? lies.copy : readCopy(lies.row)) : lies.copy) : null;
  // The ⋯ says Star or Unstar as his marks stand: the Starred lens on the workspace's host, which follows each star; his
  // own press stands until it does.
  const starredLens = reach.sidebar.marks.find((m) => m.place.kind === "starred") ?? null;
  const stars = useListing(starredLens ? { workspaceId: workspace.id, copy: starredLens } : null, starredLens?.place.root ?? STARRED_AT);
  const [pressed, setStarred] = useState<boolean | null>(null);
  const fileKey = tab.key ?? (file ? refKey(file) : null);
  const starred = pressed ?? (!!file && stars.entries.some((e) => e.key === fileKey || (!!e.ref && refKey(e.ref) === refKey(file))));
  const entry: FileEntry | null = file && place && place.wire === "files" ? { key: fileKey!, ref: file, folder: null, name: tab.name, kind: kindOfEntry(tab.name).kind, ...(place.place.shared ? { shared: true } : {}), ...(starred ? { starred: true } : {}) } : null;
  // Save As… opens in the folder the file lies in, in its format (saveAsPort.ts `tellOrigin`).
  const itemId = item?.id;
  const filePath = file?.at === "file" ? file.path : null;
  const fileHost = file?.at === "file" ? file.host : null;
  useEffect(() => {
    if (!itemId || !place || !filePath || !fileHost || place.wire !== "files") return;
    const dir = filePath.replace(/[\\/]+[^\\/]*$/, "");
    tellOrigin(itemId, { folder: { copy: place, at: { at: "file", host: fileHost, path: dir }, name: where ?? place.place.name, where: place.place.name }, name: tab.name });
    return () => tellOrigin(itemId, null);
  }, [itemId, place, filePath, fileHost, where, tab.name]);
  const { of } = verbs;
  const manage: FileManage | undefined =
    entry && place && file?.at === "file"
      ? {
          rows: actsFor([entry], place.place, { tabs: reach.tabs, app: opensInApp(place), ...farOf(place, workspace.environmentId) }),
          run: (act) => {
            const at: FolderRef = { at: "file", host: file.host, path: file.path.replace(/[\\/]+[^\\/]*$/, "") };
            if (act === "move" || act === "copy") return verbs.carry({ verb: act, entries: [entry], from: place, start: { at, name: where ?? place.place.name } });
            if (act === "star" || act === "unstar") return void star(of, [entry], act === "star").then(() => setStarred(act === "star"));
            if (act === "delete") return void trash(of, place, [entry]);
            if (act === "open-app") return verbs.openApp(entry, place);
          },
          rename: (name) => void renameTo(of, place, entry, name),
          // A copy of a file on another computer or in the VM downloads the copy this tab holds, asked of the workspace's
          // host by its item: the original's bytes go to no window but its own computer's, so asking for them was refused.
          // Any other file is read from where it lies: a shared library's only in the window of the computer that holds it.
          ...downloadOf({ copy: !!tab.copyOf && !!item, shared: !!entry.shared, there: place.link !== workspace.environmentId }, {
            copy: () => void download(of, { ...place, link: workspace.environmentId }, { ...entry, ref: item!.source }, item!.id),
            lies: () => void download(of, place, entry),
          }),
        }
      : undefined;
  return (
    <FileTabView
      tab={tab}
      item={item}
      panelId={filesPanelId(tab.id)}
      workspace={workspace}
      where={where}
      copy={copy}
      sideItem={sideItem}
      onCloseSide={onCloseSide}
      historyItem={historyItem}
      onCloseHistory={() => historyItem && onCloseHistory(historyItem.id)}
      onClose={onClose}
      {...(manage ? { manage } : {})}
      {...(folder ? { onShowFolder: () => onShowFolder(folder) } : {})}
      desktopsOf={(of) =>
        of.desktops.map((d) => {
          const read = reach.reads.find((r) => r.answer?.host === d.source.host);
          const at = read?.link ?? link;
          return { name: d.vm ? "the Windows VM" : (read?.name ?? "this computer"), open: () => void registry.linkOf(at).request("work.office.filesOpen", { source: d.source }, { timeoutMs: 120_000 }).catch((err: unknown) => say(`${tab.name} did not open`, err)) };
        })
      }
    />
  );
}
