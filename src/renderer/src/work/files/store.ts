import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FileCrumb, FilePage, FileSearchFilter, FilesHome, FilesListing, FilesOpened, FilesPlaces, FilesTabs, FileTab, SavedFileSearch } from "@shared/contract-work-files";
import type { TeamsEntry, TeamsLibrariesAnswer } from "@shared/contract-work-office";
import type { CanvasSource } from "@shared/work";
import { DEFAULT_SORT, PLACE, refKey, sortEntries, type FileEntry, type FileSort, type FolderRef } from "@shared/work/files";
import type { LibraryPlace } from "@shared/work/filePlaces";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { linkIdOfHost, localHostId, windowDesktops, workspaceSettings } from "../shell/actions";
import {
  clampDock,
  DOCK,
  entryFromOld,
  NO_HISTORY,
  pageKey,
  placesFromOld,
  selectedAfter,
  sidebarOf,
  startPage,
  teamEntries,
  teamOfPage,
  teamsNote,
  trailFromOld,
  unknownMethod,
  wentBack,
  wentForward,
  wentTo,
  type FilesNote,
  type HostRead,
  type PageHistory,
  type PageLook,
  type PlaceCopy,
  type Sidebar,
} from "./model";

/**
 * What the Files place holds in the window (docs/agents/work-files.md): what each host answered for its places,
 * the workspace's tabs as its host keeps them, the folders listed, and what only this window knows (which tab is
 * shown, each page's order). The tabs belong to the workspace: a change here goes to the host, and the host's push
 * brings every other window's change back.
 */

// ── asking the hosts ──────────────────────────────────────────────────

/** How long a host has to answer for its places before the view says it did not: a host answers from what it keeps, never waiting on its VM. */
export const HOST_DEADLINE_MS = 4_000;
/** While a VM's first read is under way, its host is asked again this often, in case its push is missed. */
export const READING_AGAIN_MS = 5_000;

/** What a host past its deadline fails with: it reads as a machine out of reach. */
export const deadlineError = (ms: number): Error => Object.assign(new Error(`No answer in ${Math.round(ms / 1000)} s`), { name: "TimeoutError" });

/** A failure that says the machine could not be reached, not a refusal about the thing asked for. */
export function unreachable(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  const words = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return name === "ConnectionLostError" || name === "TimeoutError" || /^(not connected|connection closed)$|timed out|not reachable|unreachable|could not wake|did not wake|not answering|is offline|is asleep/i.test(words);
}

export interface Reach {
  reads: HostRead[];
  sidebar: Sidebar;
  /** the workspace may copy Teams files from his other computers to its host */
  copy: boolean;
  windowsVm: boolean;
  /** a host has not answered yet, or a VM's first read is under way: more is coming */
  waiting: boolean;
  /** why no Teams place is listed, or one needs him; null: nothing to say */
  note: FilesNote | null;
  /** the workspace's own host keeps tabs and marks: false only once it is known to be a release behind (the old wire answered) */
  tabs: boolean;
  /** the hosts read through the old wire, by name: each is a release behind */
  behind: string[];
  /** the old wire's libraries by link, for listing a folder there */
  old: Map<string, LibraryPlace[]>;
}

const reading = (answer: FilesPlaces | undefined): boolean => !!answer?.sources.some((p) => p.kind === "vm" && p.state === "reading");

/**
 * The hosts this workspace's files are on (its own, then each desktop it may use), and what each said. Each host
 * paints as it answers; one past its deadline is said not to answer. A host that pushes a change to its places is
 * asked again, its last answer kept on screen until the new one lands. A host that does not know `work.files.*`
 * (a release behind) is read through `work.office.filesLibraries` instead.
 */
export function useReach(workspace: WorkspaceMeta, attempt: number): Reach | null {
  const [reach, setReach] = useState<Reach | null>(null);
  useEffect(() => {
    let live = true;
    const offs: (() => void)[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>();
    setReach(null);
    void (async () => {
      const [settings, local, desktops] = await Promise.all([workspaceSettings(workspace).catch(() => null), localHostId(), windowDesktops()]);
      const allowed = (settings?.mayUseDesktop ?? []).map((id) => linkIdOfHost(id, local)).filter((id): id is string => id !== null);
      const hosts = [...new Set([workspace.environmentId, ...allowed])].filter((id) => registry.has(id));
      if (!live) return;
      const windowsVm = !!settings?.windowsVm;
      const own = desktops.find((d) => d.link === workspace.environmentId);
      const notAllowed = desktops.filter((d) => d !== own && !hosts.includes(d.link)).map((d) => d.name);
      const reads = new Map<string, HostRead>();
      const old = new Map<string, LibraryPlace[]>();
      let copy = false;
      const paint = (): void => {
        if (!live) return;
        const got = hosts.flatMap((link) => reads.get(link) ?? []);
        // A library in the Windows VM is this workspace's only while its VM switch is on.
        const shown = got.map((r) => (r.answer ? { ...r, answer: { ...r.answer, places: r.answer.places.filter((p) => windowsVm || !p.vm) } } : r));
        const sidebar = sidebarOf(shown, workspace.environmentId);
        const waiting = got.length < hosts.length || (windowsVm && reading(reads.get(workspace.environmentId)?.answer));
        const mine = reads.get(workspace.environmentId);
        setReach({
          reads: shown,
          sidebar,
          copy,
          windowsVm,
          waiting,
          note: teamsNote({ workspaceLink: workspace.environmentId, reads: shown, windowsVm, notAllowed, rows: sidebar.rows }),
          // Its host keeps tabs unless it is known to be a release behind: a host that is slow to say its places, or
          // has not yet, is still asked for its tabs, and a file there opens in one, never in a thread.
          tabs: mine?.wire !== "office",
          behind: got.filter((r) => r.wire === "office" && r.answer).map((r) => r.name),
          old,
        });
      };
      // Only the newest ask of a host lands.
      const asked = new Map<string, number>();
      const ask = (link: string): void => {
        const mine = (asked.get(link) ?? 0) + 1;
        asked.set(link, mine);
        const name = registry.environment(link)?.name ?? link;
        const desktop = desktops.some((d) => d.link === link);
        const current = (): boolean => live && asked.get(link) === mine;
        const failed = (err: unknown): void => {
          if (!current()) return;
          reads.set(link, { link, name, desktop, wire: reads.get(link)?.wire ?? "files", failed: { words: refusalWords(err) || "No answer.", unreachable: unreachable(err) } });
          paint();
        };
        // Past the deadline the host shows as not answering; an answer that comes later still takes its place.
        const late = setTimeout(() => (timers.delete(late), failed(deadlineError(HOST_DEADLINE_MS))), HOST_DEADLINE_MS);
        timers.add(late);
        const settle = (): void => void (clearTimeout(late), timers.delete(late));
        const landed = (answer: FilesPlaces, wire: "files" | "office"): void => {
          settle();
          if (!current()) return;
          reads.set(link, { link, name, desktop, wire, answer });
          paint();
          if (!reading(answer)) return;
          const timer = setTimeout(() => (timers.delete(timer), ask(link)), READING_AGAIN_MS);
          timers.add(timer);
        };
        const host = registry.linkOf(link);
        void host.request<FilesPlaces>("work.files.places", { workspaceId: workspace.id }).then(
          (answer) => landed(answer, "files"),
          (err: unknown) => {
            if (!unknownMethod(err)) return void (settle(), failed(err));
            // A host a release behind: its libraries through the old wire, as the places the new one would say.
            void host.request<TeamsLibrariesAnswer>("work.office.filesLibraries", {}).then(
              (answer) => {
                const made = placesFromOld(answer);
                old.set(link, made.libraries);
                landed(made.places, "office");
              },
              (again: unknown) => (settle(), failed(again)),
            );
          },
        );
      };
      for (const link of hosts) {
        ask(link);
        offs.push(
          registry.linkOf(link).onPush((push) => {
            if (push.push === "work.office.files") ask(link);
            if (push.push === "work.files" && push.workspaceId === workspace.id && push.places) ask(link);
          }),
        );
      }
      paint();
      copy = await registry
        .linkOf(workspace.environmentId)
        .request<{ on: boolean }>("work.office.filesCopyGet", { workspaceId: workspace.id })
        .then(
          (a) => a.on,
          () => false,
        );
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

// ── what only this window knows ───────────────────────────────────────

const VIEW_KEY = "work.files.view.v1";
const WINDOW_KEY = "work.files.window";
/** Windows whose state is kept; the least recently written go first. */
const WINDOWS_MOST = 12;

interface WindowLook {
  /** the tab shown, by workspace */
  selected?: Record<string, string>;
  /** the sidebar is folded away, by workspace */
  folded?: Record<string, boolean>;
  /** the sidebar's places and folders that stand open, by workspace */
  open?: Record<string, string[]>;
  /** each page's order and row size, by its key */
  pages?: Record<string, PageLook>;
  /** the file tabs whose chat is docked beside them, by `dockKey` */
  docks?: Record<string, true>;
  /** the dock's width in px, one for the window */
  dock?: number;
  at: number;
}

let windowId: string | null = null;
/** This window's own id: every window of the app shares one store, so what a window keeps is kept under its id. It lives as long as the window does. */
export function thisWindow(): string {
  if (windowId) return windowId;
  try {
    windowId = globalThis.sessionStorage?.getItem(WINDOW_KEY) ?? null;
    if (!windowId) {
      windowId = `w${Math.random().toString(36).slice(2, 10)}`;
      globalThis.sessionStorage?.setItem(WINDOW_KEY, windowId);
    }
  } catch {
    windowId = `w${Math.random().toString(36).slice(2, 10)}`;
  }
  return windowId;
}

function allLooks(): Record<string, WindowLook> {
  try {
    const raw = globalThis.localStorage?.getItem(VIEW_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, WindowLook>) : {};
  } catch {
    return {};
  }
}

let look: WindowLook | null = null;
/** What this window kept; a window that has kept nothing yet starts from what the last window to write left (the app launched again). */
function lookNow(): WindowLook {
  if (look) return look;
  const all = allLooks();
  const mine = all[thisWindow()];
  const latest = Object.values(all).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
  look = mine ?? (latest ? { ...latest } : { at: 0 });
  return look;
}

const lookListeners = new Set<() => void>();
function keepLook(next: WindowLook): void {
  look = { ...next, at: Date.now() };
  try {
    const all = allLooks();
    all[thisWindow()] = look;
    const ids = Object.keys(all).sort((a, b) => (all[a]!.at ?? 0) - (all[b]!.at ?? 0));
    for (const id of ids.slice(0, Math.max(0, ids.length - WINDOWS_MOST))) delete all[id];
    globalThis.localStorage?.setItem(VIEW_KEY, JSON.stringify(all));
  } catch {
    // A window that may not store keeps its look for its own life.
  }
  for (const listener of lookListeners) listener();
}
const subscribeLook = (listener: () => void): (() => void) => (lookListeners.add(listener), () => lookListeners.delete(listener));

/** Pages whose look is kept; the rest fall back to a list by name. */
const PAGES_MOST = 300;

/** Keeps a page's look for this window; a look that says nothing is dropped. */
export function keepPageLook(at: FolderRef, next: PageLook): void {
  const key = pageKey(at);
  const now = lookNow();
  const pages = { ...now.pages };
  delete pages[key];
  if (next.sort || next.compact || next.shape || next.tile || next.group || next.details) pages[key] = next;
  const keys = Object.keys(pages);
  for (const k of keys.slice(0, Math.max(0, keys.length - PAGES_MOST))) delete pages[k];
  keepLook({ ...now, pages });
}
/** A page's look as this window keeps it now. */
export const pageLookOf = (at: FolderRef): PageLook => lookNow().pages?.[pageKey(at)] ?? {};

export function usePageLook(at: FolderRef): [PageLook, (next: PageLook) => void] {
  const key = pageKey(at);
  const value = useSyncExternalStore(subscribeLook, () => lookNow().pages?.[key]);
  return [value ?? {}, (next) => keepPageLook(at, next)];
}

export function useSidebarFolded(workspaceId: string): [boolean, (folded: boolean) => void] {
  const folded = useSyncExternalStore(subscribeLook, () => lookNow().folded?.[workspaceId] === true);
  return [folded, (next) => keepLook({ ...lookNow(), folded: { ...lookNow().folded, [workspaceId]: next } })];
}

/** Which places and folders of the sidebar stand open in this window, by workspace: each a key of its own. */
export function useSideOpen(workspaceId: string): [ReadonlySet<string>, (key: string, open: boolean) => void] {
  const kept = useSyncExternalStore(subscribeLook, () => lookNow().open?.[workspaceId]);
  const open = useMemo(() => new Set(kept ?? []), [kept]);
  return [
    open,
    (key, on) => {
      const now = lookNow();
      const next = new Set(now.open?.[workspaceId] ?? []);
      if (on) next.add(key);
      else next.delete(key);
      // The last two hundred: a tree he walked once does not grow the window's state for good.
      keepLook({ ...now, open: { ...now.open, [workspaceId]: [...next].slice(-200) } });
    },
  ];
}

/** A file tab's key among the docks this window keeps. */
export const dockKey = (workspaceId: string, tabId: string): string => `${workspaceId}/${tabId}`;

/** Whether this file tab's chat is docked beside it, in this window. */
export function useDock(workspaceId: string, tabId: string | null): [boolean, (open: boolean) => void] {
  const key = tabId ? dockKey(workspaceId, tabId) : "";
  const open = useSyncExternalStore(subscribeLook, () => !!key && lookNow().docks?.[key] === true);
  return [open, (next) => void (key && setDock(key, next))];
}

function setDock(key: string, open: boolean): void {
  const docks = { ...lookNow().docks };
  if (open) docks[key] = true;
  else delete docks[key];
  keepLook({ ...lookNow(), docks });
}

/** The dock's width in this window. */
export function useDockWidth(): [number, (width: number) => void] {
  const width = useSyncExternalStore(subscribeLook, () => clampDock(lookNow().dock ?? DOCK.width));
  return [width, (next) => keepLook({ ...lookNow(), dock: clampDock(next) })];
}

/** A tab that is gone takes its dock with it: whoever closed it, in this window or another. */
function dropDocks(workspaceId: string, tabs: readonly FileTab[]): void {
  const docks = lookNow().docks;
  if (!docks) return;
  const prefix = dockKey(workspaceId, "");
  const gone = Object.keys(docks).filter((key) => key.startsWith(prefix) && !tabs.some((t) => t.id === key.slice(prefix.length)));
  if (!gone.length) return;
  const next = { ...docks };
  for (const key of gone) delete next[key];
  keepLook({ ...lookNow(), docks: next });
}

// ── the tabs ──────────────────────────────────────────────────────────

export interface TabsView {
  tabs: readonly FileTab[];
  /** the host's first answer has come (or this workspace keeps its tabs in the window alone) */
  loaded: boolean;
  selected: string | null;
  /** the tabs are this window's alone: the workspace's host is a release behind and keeps none */
  local: boolean;
}

interface TabsEntry extends TabsView {
  link: string;
  workspaceId: string;
  rev: number;
  history: Map<string, PageHistory>;
  pending: Promise<void> | null;
}

const tabEntries = new Map<string, TabsEntry>();
const tabListeners = new Map<string, Set<() => void>>();
const EMPTY_TABS: TabsView = { tabs: [], loaded: false, selected: null, local: false };
const tabsKey = (link: string, workspaceId: string): string => `${link}\u0000${workspaceId}`;

function tabsOf(link: string, workspaceId: string): TabsEntry {
  const key = tabsKey(link, workspaceId);
  let entry = tabEntries.get(key);
  if (!entry) {
    entry = { ...EMPTY_TABS, link, workspaceId, rev: -1, history: new Map(), pending: null, selected: lookNow().selected?.[workspaceId] ?? null };
    tabEntries.set(key, entry);
  }
  return entry;
}

function writeTabs(entry: TabsEntry, patch: Partial<TabsEntry>): void {
  const key = tabsKey(entry.link, entry.workspaceId);
  const next = { ...entry, ...patch };
  tabEntries.set(key, next);
  if (next.loaded) dropDocks(entry.workspaceId, next.tabs);
  if (next.selected !== entry.selected && next.selected) keepLook({ ...lookNow(), selected: { ...lookNow().selected, [entry.workspaceId]: next.selected } });
  for (const listener of tabListeners.get(key) ?? []) listener();
}

/** The host's word on the tabs: the list as it is, the tab shown kept or moved to its neighbour. `show`: the tab a change of this window's own just made. */
function putTabs(link: string, workspaceId: string, answer: FilesTabs, show?: string): void {
  const entry = tabsOf(link, workspaceId);
  // An answer older than what is shown (a slow request that lost to a push) is dropped.
  if (answer.rev < entry.rev && !show) return;
  const selected = show && answer.tabs.some((t) => t.id === show) ? show : selectedAfter(entry.tabs, answer.tabs, entry.selected);
  for (const id of entry.history.keys()) if (!answer.tabs.some((t) => t.id === id)) entry.history.delete(id);
  // The host's word takes the place of tabs this window kept alone.
  writeTabs(entry, { tabs: answer.tabs, rev: Math.max(answer.rev, entry.rev), loaded: true, local: false, selected });
}

const ask = <T,>(link: string, method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T> => registry.linkOf(link).request<T>(method, params, options);

/** Fetch (or fetch again) the workspace's tabs from its host; an empty place gets its first tab, made once whichever window asks first. */
export function loadTabs(link: string, workspaceId: string, first: FilePage): Promise<void> {
  const entry = tabsOf(link, workspaceId);
  if (entry.pending) return entry.pending;
  const load = ask<FilesTabs>(link, "work.files.tabs", { workspaceId })
    .then(async (answer) => {
      if (answer.tabs.length) return putTabs(link, workspaceId, answer);
      const made = await ask<FilesTabs & { tabId: string }>(link, "work.files.tabOpen", { workspaceId, page: first, first: true }).catch(() => null);
      putTabs(link, workspaceId, made ?? answer, made?.tabId);
    })
    .catch(() => writeTabs(tabsOf(link, workspaceId), { loaded: true }))
    .finally(() => void (tabsOf(link, workspaceId).pending = null));
  entry.pending = load;
  return load;
}

let localIds = 0;
/** A workspace whose host keeps no tabs: this window's own, for as long as it is open. */
function localTabs(link: string, workspaceId: string, first: FilePage): void {
  const entry = tabsOf(link, workspaceId);
  // Whatever was asked of it while it was taken for a host that keeps tabs came to nothing: the window's own start here.
  if (entry.local) return;
  const id = `local-${++localIds}`;
  writeTabs(entry, { tabs: [{ id, kind: "page", name: first.name, page: first }], loaded: true, local: true, selected: id, rev: 0 });
}

/** The workspace's tabs, live. `hosted`: its host keeps them; else they are this window's alone. */
export function useTabs(link: string, workspaceId: string, hosted: boolean, first: FilePage): TabsView {
  const key = tabsKey(link, workspaceId);
  const view = useSyncExternalStore(
    (listener) => {
      const set = tabListeners.get(key) ?? new Set();
      tabListeners.set(key, set);
      set.add(listener);
      return () => void set.delete(listener);
    },
    () => tabEntries.get(key) ?? EMPTY_TABS,
  );
  useEffect(() => {
    if (!hosted) return void localTabs(link, workspaceId, first);
    void loadTabs(link, workspaceId, first);
    const host = registry.linkOf(link);
    const offPush = host.onPush((push) => {
      // The push names the new revision alone: the list is asked for, and comes cut to what this window may see.
      if (push.push === "work.files" && push.workspaceId === workspaceId && push.tabs !== undefined && push.tabs !== tabsOf(link, workspaceId).rev) void loadTabs(link, workspaceId, first);
    });
    // A socket that came back may have missed a push.
    const offOpen = host.onOpen(() => void loadTabs(link, workspaceId, first));
    return () => {
      offPush();
      offOpen();
    };
    // The first page is read once, when the place is empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, workspaceId, hosted]);
  return view;
}

export function selectTab(link: string, workspaceId: string, tabId: string): void {
  const entry = tabsOf(link, workspaceId);
  if (entry.tabs.some((t) => t.id === tabId)) writeTabs(entry, { selected: tabId });
}

/** A change to the tabs: shown at once, sent to the host, and put right by the host's answer (or its list again, when it refused). */
async function change(link: string, workspaceId: string, guess: FileTab[] | null, method: string, params: Record<string, unknown>, show?: (answer: FilesTabs & { tabId?: string }) => string | undefined): Promise<FilesTabs & { tabId?: string }> {
  const entry = tabsOf(link, workspaceId);
  if (guess) writeTabs(entry, { tabs: guess, selected: selectedAfter(entry.tabs, guess, entry.selected) });
  try {
    const answer = await ask<FilesTabs & { tabId?: string }>(link, method, { workspaceId, ...params });
    putTabs(link, workspaceId, answer, show?.(answer));
    return answer;
  } catch (error) {
    await ask<FilesTabs>(link, "work.files.tabs", { workspaceId }).then(
      (answer) => putTabs(link, workspaceId, { ...answer, rev: Math.max(answer.rev, tabsOf(link, workspaceId).rev) }),
      () => undefined,
    );
    throw error;
  }
}

/** A new page tab after `after` (last when absent), shown. */
export async function openPageTab(link: string, workspaceId: string, page: FilePage, after?: string): Promise<void> {
  const entry = tabsOf(link, workspaceId);
  if (entry.local) {
    const id = `local-${++localIds}`;
    const at = after ? entry.tabs.findIndex((t) => t.id === after) : -1;
    const tabs = [...entry.tabs];
    tabs.splice(at < 0 ? tabs.length : at + 1, 0, { id, kind: "page", name: page.name, page, ...(after ? { opener: after } : {}) });
    return writeTabs(entry, { tabs, selected: id });
  }
  await change(link, workspaceId, null, "work.files.tabOpen", { page, ...(after ? { after } : {}) }, (answer) => answer.tabId);
}

/** Closes a tab at once; the last one closed becomes the workspace's folder. */
export async function closeTab(link: string, workspaceId: string, tabId: string, last: FilePage): Promise<void> {
  const entry = tabsOf(link, workspaceId);
  const rest = entry.tabs.filter((t) => t.id !== tabId);
  if (entry.local) {
    const tabs = rest.length ? rest : [{ id: `local-${++localIds}`, kind: "page" as const, name: last.name, page: last }];
    entry.history.delete(tabId);
    return writeTabs(entry, { tabs, selected: selectedAfter(entry.tabs, tabs, entry.selected) });
  }
  await change(link, workspaceId, rest.length ? rest : null, "work.files.tabClose", { tabId });
}

/** A tab that was closed, as it can be opened again: the page it stood on, or the file it held. */
export type ClosedTab = { page: FilePage } | { file: { ref: CanvasSource; name: string; key?: string } };
const CLOSED_MOST = 20;
const closedTabs = new Map<string, ClosedTab[]>();
const closedKey = (link: string, workspaceId: string): string => `${link}\u0000${workspaceId}`;
/** Remembers a tab as it closes, in this window alone: the last twenty. */
export function rememberClosed(link: string, workspaceId: string, tab: ClosedTab): void {
  const key = closedKey(link, workspaceId);
  closedTabs.set(key, [...(closedTabs.get(key) ?? []), tab].slice(-CLOSED_MOST));
}
/** The tab last closed, taken off the list; null when there is none. */
export function takeClosed(link: string, workspaceId: string): ClosedTab | null {
  return closedTabs.get(closedKey(link, workspaceId))?.pop() ?? null;
}
export const hasClosed = (link: string, workspaceId: string): boolean => (closedTabs.get(closedKey(link, workspaceId))?.length ?? 0) > 0;

/** The tab order as dragged: the whole row, first tab first. */
export async function moveTabs(link: string, workspaceId: string, order: readonly string[]): Promise<void> {
  const entry = tabsOf(link, workspaceId);
  const byId = new Map(entry.tabs.map((t) => [t.id, t]));
  const next = [...order.flatMap((id) => byId.get(id) ?? []), ...entry.tabs.filter((t) => !order.includes(t.id))];
  if (entry.local) return writeTabs(entry, { tabs: next });
  // One tab moved: the first place the two orders differ names it, or the tab that now stands there.
  const was = entry.tabs.map((t) => t.id);
  const now = next.map((t) => t.id);
  const at = now.findIndex((id, i) => id !== was[i]);
  if (at < 0) return;
  const moved = was[at] === now[at + 1] ? now[at]! : was[at]!;
  const to = now.indexOf(moved);
  await change(link, workspaceId, next, "work.files.tabMove", { tabId: moved, before: now[to + 1] ?? null });
}

/** A page tab goes somewhere: its Back grows, and the host learns where it stands. */
export async function goTo(link: string, workspaceId: string, tabId: string, page: FilePage, how: "push" | "back" | "forward" = "push"): Promise<void> {
  const entry = tabsOf(link, workspaceId);
  const tab = entry.tabs.find((t) => t.id === tabId);
  if (!tab || tab.kind !== "page" || !tab.page) return;
  const history = entry.history.get(tabId) ?? NO_HISTORY;
  let to = page;
  if (how === "push") {
    if (refKey(tab.page.at) === refKey(page.at) && tab.page.query === page.query) return;
    entry.history.set(tabId, wentTo(history, tab.page));
  } else {
    const moved = how === "back" ? wentBack(history, tab.page) : wentForward(history, tab.page);
    if (!moved) return;
    entry.history.set(tabId, moved.history);
    to = moved.to;
  }
  const guess = entry.tabs.map((t) => (t.id === tabId ? { ...t, name: to.name, page: to } : t));
  if (entry.local) return writeTabs(entry, { tabs: guess });
  await change(link, workspaceId, guess, "work.files.tabSet", { tabId, page: to });
}

/** A tab's Back and Forward, as they stand now. */
export const historyOf = (link: string, workspaceId: string, tabId: string): PageHistory => tabsOf(link, workspaceId).history.get(tabId) ?? NO_HISTORY;

/** Opens a file in a tab of its own beside the tab it came from; the host answers the tab that holds it, or the thread that does. */
/** `seated`: run once the host has said what the file opened as, before the tab is drawn (the file's own app is started there, where one stands behind it). */
export async function openFileTab(
  link: string,
  workspaceId: string,
  file: { ref: CanvasSource; name: string; key?: string },
  opener?: string,
  options?: { timeoutMs?: number; seated?(answer: FilesOpened): Promise<void> },
): Promise<FilesOpened> {
  const answer = await ask<FilesOpened>(link, "work.files.open", { workspaceId, ref: file.ref, name: file.name, ...(file.key ? { key: file.key } : {}), ...(opener ? { opener } : {}) }, options?.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined);
  await options?.seated?.(answer);
  putTabs(link, workspaceId, answer, answer.tabId);
  return answer;
}

/** Open to the Side: the file goes at the side of a file tab, in the same tab, and that tab is shown. A file a tab of its own holds moves there. */
export async function openAtSide(link: string, workspaceId: string, file: { ref: CanvasSource; name: string }, tabId: string): Promise<FilesOpened> {
  const answer = await ask<FilesOpened>(link, "work.files.open", { workspaceId, ref: file.ref, name: file.name, side: tabId });
  putTabs(link, workspaceId, answer, answer.tabId ?? tabId);
  return answer;
}

/** Closes the file at a tab's side alone: the tab stays. */
export async function closeSide(link: string, workspaceId: string, tabId: string): Promise<void> {
  const answer = await ask<FilesTabs>(link, "work.files.tabClose", { workspaceId, tabId, side: true });
  putTabs(link, workspaceId, answer, tabId);
}

/** Test seam: forget every tab and what this window kept. */
export function resetFilesStore(): void {
  tabEntries.clear();
  listings.clear();
  savedSearches.clear();
  pageFilters.clear();
  closedTabs.clear();
  look = null;
  windowId = null;
}

// ── a folder's rows ───────────────────────────────────────────────────

export interface Listing {
  entries: FileEntry[];
  trail: FileCrumb[];
  /** the first page has come (or failed) */
  loaded: boolean;
  /** more pages wait on the host */
  more: boolean;
  /** a page is on its way */
  loading: boolean;
  error: string | null;
  /** the machine did not answer, as against a refusal about the folder */
  away: boolean;
  /** when a kept list was read (a machine asleep) */
  asOf?: number;
}

interface ListingEntry extends Listing {
  next?: string;
  round: number;
}

const listings = new Map<string, ListingEntry>();
const listingListeners = new Map<string, Set<() => void>>();
const EMPTY_LISTING: Listing = { entries: [], trail: [], loaded: false, more: false, loading: true, error: null, away: false };

function putListing(key: string, next: ListingEntry): void {
  listings.set(key, next);
  for (const listener of listingListeners.get(key) ?? []) listener();
}

/** Where a folder is read from: the copy of its place that answers, and how (the new wire, or a host a release behind). */
export interface ListFrom {
  workspaceId: string;
  copy: PlaceCopy;
  /** the old wire's library places of that host */
  old?: readonly LibraryPlace[];
  /** a team's own page: its channels, which no host is asked for */
  team?: readonly FileEntry[];
  /** a page of search results: every place of the host is searched for these words, under this filter */
  search?: { query: string; filter?: FileSearchFilter };
}

const readMs = (copy: PlaceCopy): { timeoutMs?: number } => (copy.place.vm ? { timeoutMs: 120_000 } : {});

/** A seam for a preview page and tests, which have no host: set, it answers a folder's page in the host's place. */
export const listingSeams: { fetch?: (from: ListFrom, at: FolderRef, sort: FileSort, cursor?: string) => Promise<FilesListing> } = {};

async function fetchPage(from: ListFrom, at: FolderRef, sort: FileSort, cursor?: string): Promise<FilesListing> {
  if (listingSeams.fetch) return listingSeams.fetch(from, at, sort, cursor);
  if (from.search) return ask<FilesListing>(from.copy.link, "work.files.search", { workspaceId: from.workspaceId, query: from.search.query, ...(from.search.filter ? { filter: from.search.filter } : {}), ...(cursor ? { cursor } : {}) }, { timeoutMs: 30_000 });
  if (from.copy.wire === "files") return ask<FilesListing>(from.copy.link, "work.files.list", { workspaceId: from.workspaceId, at, sort, ...(cursor ? { cursor } : {}) }, readMs(from.copy));
  // A host a release behind lists a folder whole, unsorted by the asker: the window orders it.
  const folder = at.at === "place" ? from.copy.place.root : at;
  const { entries } = await ask<{ entries: TeamsEntry[] }>(from.copy.link, "work.office.filesList", { source: folder }, readMs(from.copy));
  const host = from.copy.place.root.at === "file" ? from.copy.place.root.host : from.copy.place.env;
  return { entries: sortEntries(entries.map((e) => entryFromOld(e, from.copy.place, host)), sort), place: from.copy.place.id, trail: trailFromOld(from.copy.place, folder) };
}

/** Who last saved each Office file of a page, asked once for its first hundred: a list never reads a file, so this comes after. */
async function fillWho(key: string, from: ListFrom, round: number): Promise<void> {
  const entry = listings.get(key);
  if (!entry || from.copy.wire !== "files") return;
  const want = entry.entries.filter((e) => e.ref && e.local !== false && e.by === undefined && /\.(docx|docm|xlsx|xlsm|pptx|pptm)$/i.test(e.name)).slice(0, 100);
  if (!want.length) return;
  const got = await ask<{ entries: (FileEntry | null)[] }>(from.copy.link, "work.files.stat", { workspaceId: from.workspaceId, refs: want.map((e) => e.ref) }, readMs(from.copy)).catch(() => null);
  const now = listings.get(key);
  if (!got || !now || now.round !== round) return;
  const who = new Map(got.entries.flatMap((e) => (e?.by ? [[e.key, e.by] as const] : [])));
  if (who.size) putListing(key, { ...now, entries: now.entries.map((e) => (who.has(e.key) ? { ...e, by: who.get(e.key)! } : e)) });
}

async function load(key: string, from: ListFrom, at: FolderRef, sort: FileSort, more: boolean): Promise<void> {
  const was = listings.get(key);
  if (more && (!was?.next || was.loading)) return;
  const round = more ? was!.round : (was?.round ?? 0) + 1;
  putListing(key, { ...(was ?? { ...EMPTY_LISTING }), loading: true, error: null, round });
  try {
    if (from.team) return putListing(key, { ...EMPTY_LISTING, entries: sortEntries(from.team, sort), trail: [], loaded: true, loading: false, round });
    let first = !more;
    let page = await fetchPage(from, at, sort, more ? was!.next : undefined);
    // The folder changed between pages: it is listed again from the top.
    if (page.stale) {
      page = await fetchPage(from, at, sort);
      first = true;
    }
    const now = listings.get(key);
    if (!now || now.round !== round) return;
    putListing(key, {
      entries: first ? page.entries : [...now.entries, ...page.entries],
      trail: first ? (page.trail ?? []) : now.trail,
      loaded: true,
      more: !!page.next,
      next: page.next,
      loading: false,
      error: null,
      away: false,
      asOf: first ? page.asOf : now.asOf,
      round,
    });
    void fillWho(key, from, round);
  } catch (err) {
    const now = listings.get(key);
    if (!now || now.round !== round) return;
    putListing(key, { ...now, loaded: true, loading: false, error: refusalWords(err) || "The host did not answer.", away: unreachable(err) });
  }
}

const listingKey = (from: ListFrom, at: FolderRef, sort: FileSort): string =>
  `${from.copy.link}\u0000${from.workspaceId}\u0000${refKey(at)}\u0000${sort.by}:${sort.dir}${from.search ? `\u0000${from.search.query}\u0000${JSON.stringify(from.search.filter ?? {})}` : ""}`;

/** The key a host's push names a folder by: its own key as a row of its parent. */
function pushKey(copy: PlaceCopy, at: FolderRef): string | null {
  const folder = at.at === "place" ? copy.place.root : at;
  if (folder.at !== "file") return null;
  const root = copy.place.root;
  return copy.place.kind === "folder" || root.at !== "file" ? refKey(folder) : refKey(folder, { key: copy.place.key ?? copy.place.id, path: root.path });
}

/**
 * A folder's rows, live: the first page on first use, more as the list nears its end (`loadMore`), again from the top
 * when its host says a name in it changed, and again when the window comes back to it.
 */
export function useListing(from: ListFrom | null, at: FolderRef, sort: FileSort = DEFAULT_SORT): Listing & { loadMore(): void; retry(): void } {
  const key = from ? listingKey(from, at, sort) : "";
  const value = useSyncExternalStore(
    (listener) => {
      const set = listingListeners.get(key) ?? new Set();
      listingListeners.set(key, set);
      set.add(listener);
      return () => void set.delete(listener);
    },
    () => listings.get(key) ?? EMPTY_LISTING,
  );
  // A team's rows are made afresh each render: what they say, not which array holds them, decides when to list again.
  const team = from?.team?.map((e) => e.key).join("\n");
  useEffect(() => {
    if (!from) return;
    void load(key, from, at, sort, false);
    // A team's page asks no host, and a page fed by the seam has none to hear from.
    if (from.team || listingSeams.fetch) return;
    const watched = pushKey(from.copy, at);
    const lens = at.at === "place" && (at.id === PLACE.recent || at.id === PLACE.starred);
    const off = registry.linkOf(from.copy.link).onPush((push) => {
      if (push.push !== "work.files" || push.workspaceId !== from.workspaceId) return;
      // A lens follows his marks, which change with the tabs he opens.
      if ((watched && push.at === watched) || (lens && push.tabs !== undefined)) void load(key, from, at, sort, false);
    });
    return off;
    // The key names the host, the folder and the order; a team's rows are its own input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, team]);
  return {
    ...value,
    loadMore: () => void (from && load(key, from, at, sort, true)),
    retry: () => void (from && load(key, from, at, sort, false)),
  };
}

/** A team's page lists its channels from the places already read. */
export const teamRows = (sidebar: Sidebar, at: FolderRef): FileEntry[] | null => {
  const team = teamOfPage(at);
  if (team === null) return null;
  const found = sidebar.places.find((p) => p.is === "team" && p.name === team);
  return found?.is === "team" ? teamEntries(found.rows) : [];
};

/** The page a workspace's Files starts on. */
export const firstPage = (workspace: Pick<WorkspaceMeta, "name">): FilePage => startPage(workspace.name);

// ── Home and saved searches ───────────────────────────────────────────

/** Home's three lists from the workspace's own host: what waits on him, his stars, what he opened last. Read on mount and when his tabs or marks change. */
export function useHome(link: string, workspaceId: string): { home: FilesHome | null; error: string | null; retry(): void } {
  const [state, setState] = useState<{ home: FilesHome | null; error: string | null }>({ home: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const read = (): void =>
      void ask<FilesHome>(link, "work.files.home", { workspaceId }).then(
        (home) => live && setState({ home, error: null }),
        (err: unknown) => live && setState((was) => ({ home: was.home, error: refusalWords(err) || "The host did not answer." })),
      );
    read();
    const off = registry.linkOf(link).onPush((push) => {
      if (push.push === "work.files" && push.workspaceId === workspaceId && push.tabs !== undefined) read();
    });
    return () => {
      live = false;
      off();
    };
  }, [link, workspaceId, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

const savedSearches = new Map<string, readonly SavedFileSearch[]>();
const savedListeners = new Set<() => void>();
const NO_SEARCHES: readonly SavedFileSearch[] = [];
const savedKey = (link: string, workspaceId: string): string => `${link}\u0000${workspaceId}`;
const putSaved = (key: string, list: readonly SavedFileSearch[]): void => {
  savedSearches.set(key, list);
  for (const listener of savedListeners) listener();
};

/** The workspace's saved searches (the Docs view's saved views, read as searches), kept on its host: a row each under Starred. */
export function useSavedSearches(link: string, workspaceId: string, hosted: boolean): readonly SavedFileSearch[] {
  const key = savedKey(link, workspaceId);
  const list = useSyncExternalStore(
    (listener) => (savedListeners.add(listener), () => void savedListeners.delete(listener)),
    () => savedSearches.get(key) ?? NO_SEARCHES,
  );
  useEffect(() => {
    if (!hosted) return;
    void ask<{ searches: SavedFileSearch[] }>(link, "work.files.searches", { workspaceId }).then(
      (got) => putSaved(key, got.searches),
      () => undefined,
    );
  }, [link, workspaceId, hosted, key]);
  return list;
}

/** Keeps a search under a name; answers it as its host kept it. */
export async function saveSearch(link: string, workspaceId: string, search: { id?: string; name: string; query: string; filter?: FileSearchFilter }): Promise<SavedFileSearch> {
  const saved = await ask<SavedFileSearch>(link, "work.files.saveSearch", { workspaceId, ...search });
  const key = savedKey(link, workspaceId);
  putSaved(key, [...(savedSearches.get(key) ?? []).filter((s) => s.id !== saved.id), saved]);
  return saved;
}

export async function dropSearch(link: string, workspaceId: string, id: string): Promise<void> {
  await ask(link, "work.files.dropSearch", { workspaceId, id });
  const key = savedKey(link, workspaceId);
  putSaved(key, (savedSearches.get(key) ?? []).filter((s) => s.id !== id));
}

/** The filter each search page of this window stands under, by its tab: his own until he saves the search. */
const pageFilters = new Map<string, FileSearchFilter>();
const filterListeners = new Set<() => void>();
export function useSearchFilter(tabId: string, start?: FileSearchFilter): [FileSearchFilter, (next: FileSearchFilter) => void] {
  const value = useSyncExternalStore(
    (listener) => (filterListeners.add(listener), () => void filterListeners.delete(listener)),
    () => pageFilters.get(tabId),
  );
  return [
    value ?? start ?? NO_FILTER,
    (next) => {
      pageFilters.set(tabId, next);
      for (const listener of filterListeners) listener();
    },
  ];
}
const NO_FILTER: FileSearchFilter = {};
