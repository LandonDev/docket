import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CopyBack, FileCrumb, FilePage, FileSearchFilter, FilesHome, FilesListing, FilesOpened, FilesPlaces, FilesTabs, FileTab, SavedFileSearch, WordSaved } from "@shared/contract-work-files";
import type { TeamsEntry, TeamsLibrariesAnswer } from "@shared/contract-work-office";
import type { CanvasSource } from "@shared/work";
import { DEFAULT_SORT, PLACE, refKey, sortEntries, type FileEntry, type FileSort, type FolderRef } from "@shared/work/files";
import type { LibraryPlace } from "@shared/work/filePlaces";
import { LOCAL_ENVIRONMENT_ID, registry } from "../../lib/connection";
import { workSwitch } from "../../lib/workSwitch";
import { LISTING_FRESH_MS, LISTING_KEEP_MOST, LISTING_KEEP_MS } from "./keep";
import { workErrorWords } from "../../lib/workErrorWords";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { linkIdOfHost, localHostId, windowDesktops, workspaceSettings } from "../shell/actions";
import type { Desktops } from "../shell/desktops";
import { farName, filesLink, keepFarName, reachThrough } from "./farLink";
import {
  clampDock,
  deskRows,
  desksJoin,
  DOCK,
  entryFromOld,
  mergeBelow,
  newestFirst,
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
import { inReopenLane } from "../reopenLane";

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
 * Each workspace's reach as last painted, by link and workspace (`REACH_KEEP_MOST` of them): a return to Files paints
 * it in its first frame and asks every host again behind it, each answer taking its host's place as it lands. Names
 * of places and their states only; each host holds its own gates again on every call that reads a file.
 */
const REACH_KEEP_MOST = 24;
interface KeptReach {
  reach: Reach;
  /** each host's own answer, before the VM switch hides the VM's places */
  reads: Map<string, HostRead>;
  copy: boolean;
  old: Map<string, LibraryPlace[]>;
}
const reachKept = new Map<string, KeptReach>();
const reachKey = (workspace: Pick<WorkspaceMeta, "id" | "environmentId">): string => `${workspace.environmentId}\u0000${workspace.id}`;
function keepReach(key: string, kept: KeptReach): void {
  reachKept.delete(key);
  reachKept.set(key, kept);
  while (reachKept.size > REACH_KEEP_MOST) reachKept.delete(reachKept.keys().next().value!);
}
/** A workspace switched off, or gone: what was painted of it goes. */
export const forgetReach = (workspace: Pick<WorkspaceMeta, "id" | "environmentId">): void => void reachKept.delete(reachKey(workspace));

/** Whether a host's LifeOS places, as its last answer gave them, say other than a session that is (or is not) connected. */
export const lifeosMoved = (answer: FilesPlaces | undefined, connected: boolean): boolean =>
  !!answer?.places.some((p) => (p.kind === "lifeos" || p.kind === "mail") && (p.state.state === "ok") !== connected);

/**
 * The hosts this workspace's files are on (its own, then each desktop it may use), and what each said. A workspace
 * seen before paints what it last said at once. The workspace's own host is asked at once, beside its settings; the
 * desktops its settings name are asked once they are known; the sidebar is painted once the settings say whether the
 * Windows VM is the workspace's. Each host paints as it answers; one past its deadline is said not to answer. A host
 * that pushes a change to its places is asked again, its last answer kept on screen until the new one lands. A host
 * that does not know `work.files.*` (a release behind) is read through `work.office.filesLibraries` instead.
 */
export function useReach(workspace: WorkspaceMeta, attempt: number): Reach | null {
  const key = reachKey(workspace);
  const [shown, setShown] = useState<{ key: string; reach: Reach | null }>(() => ({ key, reach: reachKept.get(key)?.reach ?? null }));
  // Another workspace: what was painted of it, at once, in the same render.
  const reach = shown.key === key ? shown.reach : (reachKept.get(key)?.reach ?? null);
  if (shown.key !== key) setShown({ key, reach });
  useEffect(() => {
    let live = true;
    const offs: (() => void)[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const kept = reachKept.get(key);
    const own = workspace.environmentId;
    const reads = new Map<string, HostRead>(kept?.reads ?? []);
    const old = new Map<string, LibraryPlace[]>(kept?.old ?? []);
    let copy = kept?.copy ?? false;
    // Known once the settings answer: until then the own host's answer is held, never painted.
    let ready = false;
    let hosts: string[] = [own];
    let far: string[] = [];
    let windowsVm = false;
    let notAllowed: string[] = [];
    let desktops: Awaited<ReturnType<typeof windowDesktops>> = [];
    const paint = (): void => {
      if (!live || !ready) return;
      const got = hosts.flatMap((link) => {
        const r = reads.get(link);
        return r ? [{ ...r, desktop: far.includes(link) || desktops.some((d) => d.link === link) }] : [];
      });
      // A library in the Windows VM is this workspace's only while its VM switch is on.
      const shownReads = got.map((r) => (r.answer ? { ...r, answer: { ...r.answer, places: r.answer.places.filter((p) => windowsVm || !p.vm) } } : r));
      const sidebar = sidebarOf(shownReads, own);
      const waiting = got.length < hosts.length || (windowsVm && reading(reads.get(own)?.answer));
      const mine = reads.get(own);
      const next: Reach = {
        reads: shownReads,
        sidebar,
        copy,
        windowsVm,
        waiting,
        note: teamsNote({ workspaceLink: own, reads: shownReads, windowsVm, notAllowed, rows: sidebar.rows }),
        // Its host keeps tabs unless it is known to be a release behind: a host that is slow to say its places, or
        // has not yet, is still asked for its tabs, and a file there opens in one, never in a thread.
        tabs: mine?.wire !== "office",
        behind: got.filter((r) => r.wire === "office" && r.answer).map((r) => r.name),
        old,
      };
      keepReach(key, { reach: next, reads: new Map(reads), copy, old: new Map(old) });
      // A place a host answered without (a library no longer synced, the VM switched off for the workspace): what was kept of its folders goes now.
      for (const r of shownReads) {
        if (!r.answer) continue;
        const live = new Set(r.answer.places.map((p) => p.id));
        dropListings((m) => m.workspaceId === workspace.id && m.link === r.link && !live.has(m.placeId));
      }
      setShown({ key, reach: next });
    };
    // Only the newest ask of a host lands.
    const asked = new Map<string, number>();
    const ask = (link: string): void => {
      const mine = (asked.get(link) ?? 0) + 1;
      asked.set(link, mine);
      let name = registry.environment(link)?.name ?? farName(link) ?? link;
      const current = (): boolean => live && asked.get(link) === mine;
      const failed = (err: unknown): void => {
        if (!current()) return;
        reads.set(link, { link, name, desktop: false, wire: reads.get(link)?.wire ?? "files", failed: { words: workErrorWords(err, { host: name }) || "No answer.", unreachable: unreachable(err) } });
        paint();
      };
      // Past the deadline the host shows as not answering; an answer that comes later still takes its place.
      const late = setTimeout(() => (timers.delete(late), failed(deadlineError(HOST_DEADLINE_MS))), HOST_DEADLINE_MS);
      timers.add(late);
      const settle = (): void => void (clearTimeout(late), timers.delete(late));
      const landed = (answer: FilesPlaces, wire: "files" | "office"): void => {
        settle();
        if (!current()) return;
        name = answer.name ?? name;
        keepFarName(link, answer.name);
        reads.set(link, { link, name, desktop: false, wire, answer });
        paint();
        if (!reading(answer)) return;
        const timer = setTimeout(() => (timers.delete(timer), ask(link)), READING_AGAIN_MS);
        timers.add(timer);
      };
      const host = filesLink(link);
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
    const listen = (link: string): void =>
      void offs.push(
        filesLink(link).onPush((push) => {
          if (push.push === "work.office.files") ask(link);
          if (push.push === "work.files" && push.workspaceId === workspace.id && push.places) ask(link);
          // The host's LifeOS session came back or went: its LifeOS places say otherwise now, so they are asked again.
          if (push.push === "work.lifeos" && lifeosMoved(reads.get(link)?.answer, push.status.lifeos.state === "connected")) ask(link);
        }),
      );
    // The workspace's own host is asked now, beside its settings: a cold open waits on the two together, not one after the other.
    if (registry.has(own)) {
      ask(own);
      listen(own);
    }
    void (async () => {
      const [settings, local, mineDesktops] = await Promise.all([workspaceSettings(workspace).catch(() => null), localHostId(), windowDesktops()]);
      if (!live) return;
      desktops = mineDesktops;
      const mayUse = settings?.mayUseDesktop ?? [];
      const allowed = mayUse.map((id) => linkIdOfHost(id, local)).filter((id): id is string => id !== null);
      // A desktop this window has no link to (a PC linked only to the box) is asked through the workspace's own host.
      far = own === LOCAL_ENVIRONMENT_ID ? [] : mayUse.filter((id) => linkIdOfHost(id, local) === null && id !== own);
      for (const id of far) reachThrough(id, own, workspace.id);
      hosts = [...new Set([own, ...allowed])].filter((id) => registry.has(id)).concat(far);
      windowsVm = !!settings?.windowsVm;
      const ownDesktop = desktops.find((d) => d.link === own);
      notAllowed = desktops.filter((d) => d !== ownDesktop && !hosts.includes(d.link)).map((d) => d.name);
      // A host no longer the workspace's says nothing of it.
      for (const link of [...reads.keys()]) if (!hosts.includes(link)) reads.delete(link);
      ready = true;
      for (const link of hosts) {
        if (link === own && asked.has(own)) continue;
        ask(link);
        listen(link);
      }
      paint();
      copy = await registry
        .linkOf(own)
        .request<{ on: boolean }>("work.office.filesCopyGet", { workspaceId: workspace.id })
        .then(
          (a) => a.on,
          () => false,
        );
      paint();
    })();
    return () => {
      live = false;
      for (const off of offs) off();
      for (const timer of timers) clearTimeout(timer);
    };
    // The key names the workspace and its host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
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

const ask = <T,>(link: string, method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T> => filesLink(link).request<T>(method, params, options);

/** Select a saved file's tab without opening a new file or adding to Recent. */
export async function showSavedTab(link: string, workspaceId: string, saved: { tab: string; itemId: string }, show: () => boolean): Promise<boolean> {
  const answer = await ask<FilesTabs>(link, "work.files.tabs", { workspaceId });
  if (!show()) return false;
  putTabs(link, workspaceId, answer);
  const tab = tabsOf(link, workspaceId).tabs.find((tab) => tab.id === saved.tab);
  if (tab?.itemId !== saved.itemId && tab?.side?.itemId !== saved.itemId) return false;
  selectTab(link, workspaceId, saved.tab);
  return true;
}

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
    firstPages.set(key, first);
    void loadTabs(link, workspaceId, first);
    const host = registry.linkOf(link);
    const offPush = host.onPush((push) => {
      // The push names the new revision alone: the list is asked for, and comes cut to what this window may see.
      if (push.push !== "work.files" || push.workspaceId !== workspaceId || push.tabs === undefined || push.tabs === tabsOf(link, workspaceId).rev) return;
      // A change of this window's own is out: its answer brings the list, and only a newer revision is asked after it.
      const out = changing.get(key);
      if (out) return void (out.rev = Math.max(out.rev, push.tabs));
      void loadTabs(link, workspaceId, first);
    });
    // A socket that came back may have missed a push.
    // (the tabs of the workspace on screen: the front of the host's reopen lane)
    const offOpen = host.onOpen(() => inReopenLane(link, () => loadTabs(link, workspaceId, first), true));
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
  const tab = entry.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  // A tab he picked is his press for its folder; a tab shown again by a restore is not.
  if (tab.page) pressFor(tab.page.at);
  writeTabs(entry, { selected: tabId });
}

/** This window's own changes to a workspace's tabs that are out, and the newest revision a push named meanwhile. */
const changing = new Map<string, { count: number; rev: number }>();
/** Each shown workspace's first page, for a list asked again after a change (an empty place gets it as its first tab). */
const firstPages = new Map<string, FilePage>();

/** A change to the tabs: shown at once, sent to the host, and put right by the host's answer (or its list again, when it refused). */
async function change(link: string, workspaceId: string, guess: FileTab[] | null, method: string, params: Record<string, unknown>, show?: (answer: FilesTabs & { tabId?: string }) => string | undefined): Promise<FilesTabs & { tabId?: string }> {
  const entry = tabsOf(link, workspaceId);
  if (guess) writeTabs(entry, { tabs: guess, selected: selectedAfter(entry.tabs, guess, entry.selected) });
  const key = tabsKey(link, workspaceId);
  const out = changing.get(key) ?? { count: 0, rev: -1 };
  out.count++;
  changing.set(key, out);
  const done = (): void => {
    if (--out.count) return;
    changing.delete(key);
    // A push named a revision past what the answers brought: the list is asked for once.
    const first = firstPages.get(key);
    if (first && out.rev > tabsOf(link, workspaceId).rev) void loadTabs(link, workspaceId, first);
  };
  try {
    const answer = await ask<FilesTabs & { tabId?: string }>(link, method, { workspaceId, ...params });
    putTabs(link, workspaceId, answer, show?.(answer));
    done();
    return answer;
  } catch (error) {
    done();
    await ask<FilesTabs>(link, "work.files.tabs", { workspaceId }).then(
      (answer) => putTabs(link, workspaceId, { ...answer, rev: Math.max(answer.rev, tabsOf(link, workspaceId).rev) }),
      () => undefined,
    );
    throw error;
  }
}

/** A new page tab after `after` (last when absent), shown. */
export async function openPageTab(link: string, workspaceId: string, page: FilePage, after?: string): Promise<void> {
  pressFor(page.at);
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

/** The workspace's tabs as this window last heard them from its host. */
export const tabsNow = (link: string, workspaceId: string): readonly FileTab[] => tabsOf(link, workspaceId).tabs;

/** Closes a tab at once; the last one closed becomes the workspace's folder. `discard`: a copy's changes that have not reached its file go with it. */
export async function closeTab(link: string, workspaceId: string, tabId: string, last: FilePage, discard = false): Promise<void> {
  const entry = tabsOf(link, workspaceId);
  const rest = entry.tabs.filter((t) => t.id !== tabId);
  if (entry.local) {
    const tabs = rest.length ? rest : [{ id: `local-${++localIds}`, kind: "page" as const, name: last.name, page: last }];
    entry.history.delete(tabId);
    return writeTabs(entry, { tabs, selected: selectedAfter(entry.tabs, tabs, entry.selected) });
  }
  await change(link, workspaceId, rest.length ? rest : null, "work.files.tabClose", { tabId, ...(discard ? { discard: true } : {}) });
}

/** A copy's kind saved: the workspace's host sends the copy to the file it is a copy of, when the two differ (files/copies.ts). Its tab says how that stands. */
export const sendCopyBack = (link: string, workspaceId: string, tabId: string): Promise<CopyBack> => ask<CopyBack>(link, "work.files.copyBack", { workspaceId, tabId });

/** Save as Word: the document a Word file of another computer became, written over that file by its version, or beside it with `keep` (files/word.ts). */
export const saveWordFile = (link: string, workspaceId: string, tabId: string, keep: boolean, replace = false, seen?: number): Promise<WordSaved> =>
  ask<WordSaved>(link, "work.files.wordSave", { workspaceId, tabId, ...(keep ? { keep: true } : {}), ...(replace ? { replace: true } : {}), ...(replace && seen !== undefined ? { seen } : {}) }, { timeoutMs: 180_000 });

/** His choice for a Word file opened as its document: save it by itself, or ask each time (files/word.ts). */
export async function setWordAuto(link: string, workspaceId: string, tabId: string, on: boolean): Promise<void> {
  putTabs(link, workspaceId, await ask<FilesTabs>(link, "work.files.wordAuto", { workspaceId, tabId, on }));
}

/** Reload: the file as it is on its computer now, in the copy's place; what was not sent is dropped. */
export async function reloadCopy(link: string, workspaceId: string, tabId: string): Promise<void> {
  putTabs(link, workspaceId, await ask<FilesTabs>(link, "work.files.copyReload", { workspaceId, tabId }));
}

/** Keep Both: his copy saved beside the file on its computer under the keep-both name, and the tab shows that file. */
export async function keepBothCopy(link: string, workspaceId: string, tabId: string): Promise<void> {
  putTabs(link, workspaceId, await ask<FilesTabs>(link, "work.files.copyKeep", { workspaceId, tabId }));
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
  pressFor(to.at);
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
  options?: { timeoutMs?: number; seated?(answer: FilesOpened): Promise<void>; /** asked when the host has answered: false keeps the new tab behind the one shown (he chose something else while a slow host made it) */ show?(): boolean },
): Promise<FilesOpened> {
  const answer = await ask<FilesOpened>(link, "work.files.open", { workspaceId, ref: file.ref, name: file.name, ...(file.key ? { key: file.key } : {}), ...(opener ? { opener } : {}) }, options?.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined);
  await options?.seated?.(answer);
  putTabs(link, workspaceId, answer, options?.show?.() === false ? undefined : answer.tabId);
  return answer;
}

/** A pillar's own new item in a tab (`work.forms.make`): the host answers the tabs with it, and its tab is shown. */
export async function openMadeTab(link: string, workspaceId: string, method: string, params: Record<string, unknown>): Promise<FilesTabs & { tabId: string }> {
  const answer = await ask<FilesTabs & { tabId: string }>(link, method, { workspaceId, ...params });
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
  pressed.clear();
  reachKept.clear();
  listingMeta.clear();
  listingRound.clear();
  listingListeners.clear();
  keepHears.clear();
  changing.clear();
  firstPages.clear();
  deskAsks.clear();
  tabSearches.clear();
  homes.clear();
  homeReads.clear();
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
  /** his Retry is out: the page keeps what it said (a failure and its words, a search's gap) and that Retry spins */
  retrying?: boolean;
  /** when a kept list was read (a machine asleep) */
  asOf?: number;
  /** the error is a later page's: the rows above it stay, and its cursor is kept for Retry */
  lostPage?: boolean;
  /** a search stopped before it looked through every place */
  incomplete?: boolean;
  /** a search left these places out because their machine sleeps */
  asleep?: string[];
  /** a search did not search the folders on these desktops: no link of this window reaches them, or theirs is down */
  unsearched?: string[];
  /** a search's rows are in, and his desktops are still searching their folders */
  searching?: boolean;
  /** a search's places still being searched, by name (the host's, then his desktops'): their rows join below as each answers */
  pending?: string[];
  /** the folder's machine sleeps (the Windows VM): `waking` while a wake goes on, its rows pushed once they land */
  sleeping?: "asleep" | "waking";
  /** a wake this window saw under way ended with the machine still asleep */
  unwoken?: boolean;
}

/** What his desktops' own search found for a search page: their rows, the ones not searched, and whether a walk stopped short. */
interface DeskFound {
  rows: FileEntry[];
  unsearched: string[];
  more: boolean;
}

interface ListingEntry extends Listing {
  /** his desktops still searching their folders, by name */
  deskPending?: string[];
  next?: string;
  round: number;
  desk?: DeskFound;
}

const listings = new Map<string, ListingEntry>();
const listingListeners = new Map<string, Set<() => void>>();
const EMPTY_LISTING: Listing = { entries: [], trail: [], loaded: false, more: false, loading: true, error: null, away: false };

/** What the keep knows of each listing: where it is read from and how a push names it, when it was last shown, when its first page last landed. */
interface ListingMeta {
  link: string;
  workspaceId: string;
  /** the place it lies in: a place its host no longer lists takes its listings with it */
  placeId: string;
  pushAt: string | null;
  lens: boolean;
  seenAt: number;
  loadedAt: number;
  /** a push named it while no one read it, or while its read was out: shown again, it is read again */
  dirty: boolean;
  /** a drop rule named it while it was on screen: it goes as its last reader leaves */
  gone?: boolean;
}
const listingMeta = new Map<string, ListingMeta>();
/** The newest load of each listing: an older one that lands is dropped. */
const listingRound = new Map<string, number>();
let rounds = 0;

function putListing(key: string, next: ListingEntry): void {
  const fresh = !listings.has(key);
  listings.set(key, next);
  // A new one may put the keep past its bound.
  if (fresh) sweepListings();
  for (const listener of listingListeners.get(key) ?? []) listener();
}

function dropListing(key: string): void {
  listings.delete(key);
  deskAsks.delete(key);
  listingMeta.delete(key);
  listingRound.delete(key);
}

/** The keep's rules (keep.ts): one not shown for `LISTING_KEEP_MS` goes, and past `LISTING_KEEP_MOST` the one shown longest ago. One on screen stays. */
function sweepListings(now = Date.now()): void {
  const unread: [string, number][] = [];
  for (const key of listings.keys()) {
    const meta = listingMeta.get(key);
    if (listingListeners.get(key)?.size) {
      if (meta) meta.seenAt = now;
      continue;
    }
    const seen = meta?.seenAt ?? 0;
    if (now - seen > LISTING_KEEP_MS) dropListing(key);
    else unread.push([key, seen]);
  }
  unread.sort((a, b) => a[1] - b[1]);
  while (listings.size > LISTING_KEEP_MOST && unread.length) dropListing(unread.shift()![0]);
}

/**
 * Listings a drop rule names go at once (a place its host no longer lists, Work off). One on screen stays: its page
 * reads from a place that is still listed, and a page whose place went has no reader left.
 */
export function dropListings(which: (meta: Pick<ListingMeta, "link" | "workspaceId" | "placeId">) => boolean): void {
  for (const [key, meta] of [...listingMeta]) {
    if (!which(meta)) continue;
    if (listingListeners.get(key)?.size) meta.gone = true;
    else dropListing(key);
  }
}

/** How many listings are kept, and listener sets (tests). */
export const listingsKept = (): { listings: number; sets: number; empty: number } => ({ listings: listings.size, sets: listingListeners.size, empty: [...listingListeners.values()].filter((set) => !set.size).length });

/** Each host's pushes, heard once for the keep: a folder named while no one shows it is read again when it is shown. */
const keepHears = new Map<string, unknown>();
function hearForKeep(link: string): void {
  // Once per link: again only for a link made anew (a host paired again).
  const host = filesLink(link);
  if (keepHears.get(link) === host) return;
  keepHears.set(link, host);
  host.onPush((push) => {
    if (push.push !== "work.files") return;
    for (const meta of listingMeta.values()) {
      if (meta.link !== link || meta.workspaceId !== push.workspaceId) continue;
      if ((meta.pushAt && push.at === meta.pushAt) || (meta.lens && (push.tabs !== undefined || push.marks))) meta.dirty = true;
    }
  });
}

/** Work off on a host: what was kept of its folders, its workspaces' reach and Home goes. */
let offHeard = false;
function hearWorkOff(): void {
  if (offHeard) return;
  offHeard = true;
  workSwitch.subscribe(() => {
    const on = workSwitch.hosts();
    dropListings((meta) => !on.has(meta.link));
    for (const key of [...reachKept.keys()]) if (!on.has(key.split("\u0000")[0]!)) reachKept.delete(key);
    for (const key of [...homes.keys()]) if (!on.has(key.split("\u0000")[0]!)) homes.delete(key);
  });
}

/** Where a folder is read from: the copy of its place that answers, and how (the new wire, or a host a release behind). */
export interface ListFrom {
  workspaceId: string;
  copy: PlaceCopy;
  /** the old wire's library places of that host */
  old?: readonly LibraryPlace[];
  /** a team's own page: its channels, which no host is asked for */
  team?: readonly FileEntry[];
  /** a page of search results: every place of the host is searched for these words, under this filter, and the folders on his desktops by `desks` */
  search?: { query: string; filter?: FileSearchFilter; desks?: DeskSearch; /** the words this tab searched before: their walks stop */ replaces?: string };
  /** the folders alone (Move to… and Copy to…, which pick a folder): the host leaves the files out of every page */
  foldersOnly?: boolean;
}

/** His desktops for a search of every place: which ones the window may ask itself, and the place a file of one lies in. */
export interface DeskSearch {
  find(): Promise<Desktops>;
  placeOf(link: string, path: string): PlaceCopy | null;
}

/** A desktop's walk keeps its own cap of 15 s. */
const DESK_MS = 20_000;

const readMs = (copy: PlaceCopy): { timeoutMs?: number } => (copy.place.vm ? { timeoutMs: 120_000 } : {});

/**
 * Folders he just pressed for (a row, the trail, Back, a tab he picked, a new tab), by key: the first page of each
 * that loads next may wake its machine (the Windows VM), and no other list does: a restored tab, a refetch on a push
 * or a reconnect, a later page. A press not followed by its list within `PRESS_MS` lapses.
 */
const pressed = new Map<string, number>();
const PRESS_MS = 10_000;
export function pressFor(at: FolderRef, now = Date.now()): void {
  pressed.set(refKey(at), now);
}
function takePress(at: FolderRef, now = Date.now()): boolean {
  const key = refKey(at);
  const when = pressed.get(key);
  pressed.delete(key);
  return when !== undefined && now - when <= PRESS_MS;
}

/** A seam for a preview page and tests, which have no host: set, it answers a folder's page in the host's place. */
export const listingSeams: { fetch?: (from: ListFrom, at: FolderRef, sort: FileSort, cursor?: string, wake?: boolean, seen?: number) => Promise<FilesListing>; desk?: (link: string, query: string) => Promise<{ entries: TeamsEntry[]; more?: boolean }> } = {};

/** Each tab's search words, and the ones before them: a search names the one it replaces, whose walks then stop. */
const tabSearches = new Map<string, { query: string; before?: string }>();
export function searchReplaces(tabId: string, query: string): string | undefined {
  const was = tabSearches.get(tabId);
  if (!was) return void tabSearches.set(tabId, { query });
  if (was.query !== query) tabSearches.set(tabId, { query, before: was.query });
  return tabSearches.get(tabId)!.before;
}

/**
 * The folders on his desktops for a search of every place (docs/agents/work-files.md "Search and Go to"): the
 * workspace's host cannot walk another computer's folders, so the window asks each desktop it holds a link to
 * with the search Files already has there (names alone), and names the rest. Never rejects.
 */
async function searchDesks(desks: DeskSearch, query: string, filter: FileSearchFilter, o: { replaces?: string; asking?(names: string[]): void } = {}): Promise<DeskFound> {
  const { linked, far } = await desks.find().catch((): Desktops => ({ linked: [], far: [] }));
  const found: DeskFound = { rows: [], unsearched: [...far], more: false };
  o.asking?.(linked.map((desk) => desk.name));
  await Promise.all(
    linked.map(async (desk) => {
      try {
        // The words this tab searched before name the desktop's walk that stops now.
        const got = await (listingSeams.desk?.(desk.link, query) ?? ask<{ entries: TeamsEntry[]; more?: boolean }>(desk.link, "work.office.filesSearch", { query, ...(o.replaces ? { replaces: o.replaces } : {}) }, { timeoutMs: DESK_MS }));
        found.rows.push(...deskRows(got.entries, (path) => desks.placeOf(desk.link, path), filter));
        if (got.more) found.more = true;
      } catch {
        // Its link went down, or its walk did not answer in time: named, with Retry.
        found.unsearched.push(desk.name);
        found.more = true;
      }
    }),
  );
  return found;
}

/** A desktop's part of a search, as the listing says it. */
const deskSays = (desk: DeskFound | undefined): Partial<Listing> => (desk ? { ...(desk.more ? { incomplete: true } : {}), ...(desk.unsearched.length ? { unsearched: desk.unsearched } : {}) } : {});

/** `seen`: a search's first page in parts (0 the first time, then the parts the last answer said). */
async function fetchPage(from: ListFrom, at: FolderRef, sort: FileSort, cursor?: string, wake = false, seen?: number): Promise<FilesListing> {
  if (listingSeams.fetch) return listingSeams.fetch(from, at, sort, cursor, wake, from.search && !cursor ? (seen ?? 0) : seen);
  if (from.search) {
    const parts = cursor ? {} : { seen: seen ?? 0, ...(!seen && from.search.replaces ? { replaces: from.search.replaces } : {}) };
    return ask<FilesListing>(from.copy.link, "work.files.search", { workspaceId: from.workspaceId, query: from.search.query, ...(from.search.filter ? { filter: from.search.filter } : {}), ...(cursor ? { cursor } : {}), ...parts }, { timeoutMs: 30_000 });
  }
  // A folder in the VM says whether he pressed for it: only then may its host wake the machine.
  if (from.copy.wire === "files") return ask<FilesListing>(from.copy.link, "work.files.list", { workspaceId: from.workspaceId, at, sort, ...(cursor ? { cursor } : {}), ...(from.foldersOnly ? { foldersOnly: true } : {}), ...(from.copy.place.vm ? { wake } : {}) }, readMs(from.copy));
  // A host a release behind lists a folder whole, unsorted by the asker: the window orders it.
  const folder = at.at === "place" ? from.copy.place.root : at;
  const { entries } = await ask<{ entries: TeamsEntry[] }>(from.copy.link, "work.office.filesList", { source: folder }, readMs(from.copy));
  const host = from.copy.place.root.at === "file" ? from.copy.place.root.host : from.copy.place.env;
  const all = sortEntries(entries.map((e) => entryFromOld(e, from.copy.place, host)), sort);
  return { entries: from.foldersOnly ? all.filter((e) => e.folder) : all, place: from.copy.place.id, trail: trailFromOld(from.copy.place, folder) };
}

/** Who last saved each Office file of a page, asked once for its first hundred: a list never reads a file, so this comes after. Never for the Windows VM, whose guest names no one. */
async function fillWho(key: string, from: ListFrom, round: number): Promise<void> {
  const entry = listings.get(key);
  if (!entry || from.copy.wire !== "files" || from.copy.place.vm) return;
  const want = entry.entries.filter((e) => e.ref && e.local !== false && e.by === undefined && /\.(docx|docm|xlsx|xlsm|pptx|pptm)$/i.test(e.name)).slice(0, 100);
  if (!want.length) return;
  const got = await ask<{ entries: (FileEntry | null)[] }>(from.copy.link, "work.files.stat", { workspaceId: from.workspaceId, refs: want.map((e) => e.ref) }, readMs(from.copy)).catch(() => null);
  const now = listings.get(key);
  if (!got || !now || listingRound.get(key) !== round) return;
  const who = new Map(got.entries.flatMap((e) => (e?.by ? [[e.key, e.by] as const] : [])));
  if (who.size) putListing(key, { ...now, entries: now.entries.map((e) => (who.has(e.key) ? { ...e, by: who.get(e.key)! } : e)) });
}

/** A page's rows, the objects it had kept where a row says the same (with who saved it, which a list leaves out), so a row that did not change does not draw again. */
function steady(was: readonly FileEntry[], next: readonly FileEntry[]): FileEntry[] {
  if (!was.length) return [...next];
  const old = new Map(was.map((e) => [e.key, e]));
  return next.map((e) => {
    const prev = old.get(e.key);
    if (!prev) return e;
    const same = prev.by !== undefined && e.by === undefined ? { ...e, by: prev.by } : e;
    return JSON.stringify(same) === JSON.stringify(prev) ? prev : same;
  });
}

/**
 * `again`: a host's push lists the page again; a search keeps what his desktops found rather than walking their
 * folders again. `wake`: his press, which may wake the folder's machine. `retry`: his Retry, which shows the page busy;
 * any other read of a page already drawn keeps it as it is until the answer lands.
 */
async function load(key: string, from: ListFrom, at: FolderRef, sort: FileSort, more: boolean, again = false, wake = false, retry = false): Promise<void> {
  const was = listings.get(key);
  if (more && (!was?.next || was.loading)) return;
  const meta = listingMeta.get(key);
  const round = more ? (listingRound.get(key) ?? ++rounds) : ++rounds;
  listingRound.set(key, round);
  if (!more) {
    // Read from now: a push from here on marks it again.
    if (meta) meta.dirty = false;
  }
  const quiet = !more && !retry && !!was?.loaded && !was.error;
  // His Retry keeps what the page said until the answer replaces it; any other read of a page that failed clears the
  // failure, and the page draws its bones (never "empty" while a read is out).
  if (retry && !more && was?.loaded) putListing(key, { ...was, loading: true, retrying: true, round });
  else if (!quiet) putListing(key, { ...(was ?? { ...EMPTY_LISTING }), loading: true, error: null, lostPage: false, round });
  const search = from.search;
  // A search's desktops are asked once a search, beside its host, and only for its first page: a push's read or a
  // part of the host's answer reuses that ask, and only his Retry asks them again.
  if (retry) deskAsks.delete(key);
  let deskSaid: string[] | undefined;
  const deskNames = (names: string[]): void => {
    deskSaid = names;
    const cur = listings.get(key);
    if (cur && listingRound.get(key) === round && cur.searching) putListing(key, { ...cur, deskPending: names });
  };
  const desks = !more && search?.desks && desksJoin(search.filter ?? {}) ? (again && was?.desk ? Promise.resolve(was.desk) : (deskAsks.get(key) ?? deskAsks.set(key, searchDesks(search.desks, search.query, search.filter ?? {}, { replaces: search.replaces, asking: deskNames })).get(key)!)) : null;
  try {
    if (from.team) return putListing(key, { ...EMPTY_LISTING, entries: sortEntries(from.team, sort), trail: [], loaded: true, loading: false, round });
    let first = !more;
    let page = await fetchPage(from, at, sort, more ? was!.next : undefined, wake && !more);
    // The folder changed between pages: it is listed again from the top.
    if (page.stale) {
      page = await fetchPage(from, at, sort, undefined, wake);
      first = true;
    }
    const now = listings.get(key);
    if (!now || listingRound.get(key) !== round) return;
    const desk = more ? now.desk : undefined;
    if (first) {
      const m = listingMeta.get(key);
      if (m) m.loadedAt = Date.now();
    }
    putListing(key, {
      // A later page of a search joins below what is shown (a row a part of it drew already stays where it is).
      entries: first ? steady(now.entries, page.entries) : search ? mergeBelow(now.entries, page.entries) : [...now.entries, ...page.entries],
      trail: first ? (page.trail ?? []) : now.trail,
      loaded: true,
      more: !!page.next,
      next: page.next,
      loading: false,
      error: null,
      away: false,
      asOf: first ? page.asOf : now.asOf,
      // A sleeping machine's state is the first page's; a wake he saw under way that ended asleep is said as such.
      ...(first ? (page.sleeping ? { sleeping: page.sleeping } : {}) : now.sleeping ? { sleeping: now.sleeping } : {}),
      ...(first && page.sleeping === "asleep" && now.sleeping === "waking" ? { unwoken: true } : {}),
      // What a search left out is said by every page of it alike.
      ...(page.more ? { incomplete: true } : {}),
      ...(page.asleep?.length ? { asleep: page.asleep } : {}),
      ...deskSays(desk),
      ...(desks || (more && now.searching) ? { searching: true, ...((deskSaid ?? now.deskPending) ? { deskPending: deskSaid ?? now.deskPending } : {}) } : {}),
      ...(desk ? { desk } : {}),
      ...(first ? (page.pending?.length ? { pending: page.pending } : {}) : now.pending ? { pending: now.pending } : {}),
      round,
    });
    void fillWho(key, from, round);
    // The places the host is still searching: asked again until each has answered, each part joined below.
    if (search && first && page.pending?.length && page.parts !== undefined) void restOf(key, from, at, sort, round, page.parts);
    if (!desks) return;
    // The host's rows are drawn first; the desktops' join below them when they come, so nothing shown moves.
    const found = await desks;
    const then = listings.get(key);
    if (!then || listingRound.get(key) !== round) return;
    const said = deskSays(found);
    const { deskPending: _, ...rest } = then;
    putListing(key, { ...rest, entries: mergeBelow(then.entries, [...found.rows].sort(newestFirst)), searching: false, desk: found, ...said, ...(said.incomplete || then.incomplete ? { incomplete: true } : {}) });
  } catch (err) {
    const now = listings.get(key);
    if (!now || listingRound.get(key) !== round) return;
    putListing(key, { ...now, loaded: true, loading: false, searching: false, retrying: false, error: workErrorWords(err, { host: registry.environment(from.copy.link)?.name }) || "The host did not answer.", away: unreachable(err), lostPage: more });
  }
}

/** The rest of a search the host answers in parts: asked again with the parts seen until no place is pending, each part joined below the rows shown. */
async function restOf(key: string, from: ListFrom, at: FolderRef, sort: FileSort, round: number, parts: number): Promise<void> {
  let seen = parts;
  for (;;) {
    let page: FilesListing;
    try {
      page = await fetchPage(from, at, sort, undefined, false, seen);
    } catch {
      // The host did not answer the rest: what came stays, and the line stops saying it is searching.
      const cur = listings.get(key);
      if (cur && listingRound.get(key) === round) putListing(key, { ...cur, pending: undefined, incomplete: true });
      return;
    }
    const cur = listings.get(key);
    if (!cur || listingRound.get(key) !== round) return;
    putListing(key, {
      ...cur,
      entries: mergeBelow(cur.entries, page.entries),
      // Past what is shown the next page goes on from the newest answer.
      ...(page.next ? { next: page.next, more: true } : {}),
      pending: page.pending?.length ? page.pending : undefined,
      ...(page.more ? { incomplete: true } : {}),
      ...(page.asleep?.length ? { asleep: page.asleep } : {}),
    });
    if (!page.pending?.length || page.parts === undefined || page.parts <= seen) return;
    seen = page.parts;
  }
}

/** Each search's ask of his desktops, by listing: one a search. */
const deskAsks = new Map<string, Promise<DeskFound>>();

const listingKey = (from: ListFrom, at: FolderRef, sort: FileSort): string =>
  `${from.copy.link}\u0000${from.workspaceId}\u0000${refKey(at)}\u0000${sort.by}:${sort.dir}${from.search ? `\u0000${from.search.query}\u0000${JSON.stringify(from.search.filter ?? {})}` : ""}${from.foldersOnly ? "\u0000folders" : ""}`;

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
export function useListing(from: ListFrom | null, at: FolderRef, sort: FileSort = DEFAULT_SORT): Listing & { loadMore(): void; retry(): Promise<void> } {
  const key = from ? listingKey(from, at, sort) : "";
  const value = useSyncExternalStore(
    (listener) => {
      const set = listingListeners.get(key) ?? new Set();
      listingListeners.set(key, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        // No empty set is kept; the listing's own life starts now.
        if (set.size) return;
        listingListeners.delete(key);
        const meta = listingMeta.get(key);
        if (meta?.gone) return dropListing(key);
        if (meta) meta.seenAt = Date.now();
        sweepListings();
      };
    },
    () => listings.get(key) ?? EMPTY_LISTING,
  );
  // A team's rows are made afresh each render: what they say, not which array holds them, decides when to list again.
  const team = from?.team?.map((e) => e.key).join("\n");
  useEffect(() => {
    if (!from) return;
    const watched = pushKey(from.copy, at);
    const lens = at.at === "place" && (at.id === PLACE.recent || at.id === PLACE.starred);
    const now = Date.now();
    const meta = listingMeta.get(key);
    listingMeta.set(key, { link: from.copy.link, workspaceId: from.workspaceId, placeId: from.copy.place.id, pushAt: watched, lens, seenAt: now, loadedAt: meta?.loadedAt ?? 0, dirty: meta?.dirty ?? false });
    hearWorkOff();
    const was = listings.get(key);
    // Shown again this soon (Back, a tab switched to and back), as it was and with nothing named since: drawn, not asked.
    const fresh = !!was?.loaded && !was.error && !was.sleeping && !was.loading && !meta?.dirty && now - (meta?.loadedAt ?? 0) <= LISTING_FRESH_MS && !from.search && !from.team;
    // Shown because he pressed for it, or shown again (a restored tab): only the first may wake its machine.
    const wake = takePress(at);
    if (!fresh) void load(key, from, at, sort, false, false, wake);
    // A team's page asks no host, and a page fed by the seam has none to hear from.
    if (from.team || listingSeams.fetch) return;
    hearForKeep(from.copy.link);
    const off = filesLink(from.copy.link).onPush((push) => {
      if (push.push !== "work.files" || push.workspaceId !== from.workspaceId) return;
      // A lens follows his marks, which change with the tabs he opens.
      if ((watched && push.at === watched) || (lens && (push.tabs !== undefined || push.marks))) void load(key, from, at, sort, false, true);
    });
    return off;
    // The key names the host, the folder and the order; a team's rows are its own input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, team]);
  // The places still searched, the host's and his desktops', as one list for the page's line.
  const deskPending = value.searching ? ((value as ListingEntry).deskPending ?? []) : [];
  const pending = value.pending?.length || deskPending.length ? [...(value.pending ?? []), ...deskPending] : undefined;
  return {
    ...value,
    ...(pending ? { pending } : { pending: undefined }),
    loadMore: () => void (from && load(key, from, at, sort, true)),
    // Retry, and Wake it over a sleeping folder, are his press; it settles when the answer lands.
    retry: () => (from ? load(key, from, at, sort, false, false, true, true) : Promise.resolve()),
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

/**
 * Home's three lists from the workspace's own host, kept per link and workspace: a return paints what was kept at
 * once and reads once behind it; after that only a push that names his marks (`marks`: a star, a recent, what a
 * thread made) or the link coming back reads again, and pushes that come while a read is out make one more read
 * after it, never one each.
 */
interface HomeKept {
  home: FilesHome | null;
  error: string | null;
  reading: boolean;
  again: boolean;
}
const homes = new Map<string, HomeKept>();
const homeListeners = new Map<string, Set<() => void>>();
const NO_HOME: HomeKept = { home: null, error: null, reading: false, again: false };
const homeKey = (link: string, workspaceId: string): string => `${link}\u0000${workspaceId}`;
function putHome(key: string, next: HomeKept): void {
  homes.set(key, next);
  for (const listener of homeListeners.get(key) ?? []) listener();
}
/** Each Home read out, by key: a read asked while one is out settles with the one after it. */
const homeReads = new Map<string, Promise<void>>();

function readHome(link: string, workspaceId: string): Promise<void> {
  const key = homeKey(link, workspaceId);
  const was = homes.get(key) ?? NO_HOME;
  if (was.reading) {
    putHome(key, { ...was, again: true });
    return homeReads.get(key) ?? Promise.resolve();
  }
  putHome(key, { ...was, reading: true, again: false });
  const read = ask<FilesHome>(link, "work.files.home", { workspaceId }).then(
    (home) => ({ home, error: null }),
    (err: unknown) => ({ home: (homes.get(key) ?? NO_HOME).home, error: workErrorWords(err) || "The host did not answer." }),
  ).then((got): Promise<void> | undefined => {
    const now = homes.get(key) ?? NO_HOME;
    putHome(key, { ...got, reading: false, again: false });
    if (homeReads.get(key) === read) homeReads.delete(key);
    return now.again ? readHome(link, workspaceId) : undefined;
  });
  homeReads.set(key, read);
  return read;
}

export function useHome(link: string, workspaceId: string): { home: FilesHome | null; error: string | null; retry(): Promise<void> } {
  const key = homeKey(link, workspaceId);
  const state = useSyncExternalStore(
    (listener) => {
      const set = homeListeners.get(key) ?? new Set();
      homeListeners.set(key, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) homeListeners.delete(key);
      };
    },
    () => homes.get(key) ?? NO_HOME,
  );
  useEffect(() => {
    void readHome(link, workspaceId);
    const host = registry.linkOf(link);
    const offPush = host.onPush((push) => {
      if (push.push === "work.files" && push.workspaceId === workspaceId && push.marks) readHome(link, workspaceId);
    });
    const offOpen = host.onOpen(() => inReopenLane(link, () => readHome(link, workspaceId), true));
    return () => {
      offPush();
      offOpen();
    };
  }, [link, workspaceId]);
  return { home: state.home, error: state.error, retry: () => readHome(link, workspaceId) };
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

/**
 * The filter each search page of this window stands under, by its tab and the search it shows: his own until he
 * saves the search. Another search opened in the same tab starts from its own saved filter, not the last one's.
 */
const pageFilters = new Map<string, FileSearchFilter>();
const filterListeners = new Set<() => void>();
export const searchFilterKey = (tabId: string, page: FilePage): string => `${tabId}\u0000${refKey(page.at)}\u0000${page.query ?? ""}`;
export function useSearchFilter(tabId: string, page: FilePage, start?: FileSearchFilter): [FileSearchFilter, (next: FileSearchFilter) => void] {
  const key = searchFilterKey(tabId, page);
  const value = useSyncExternalStore(
    (listener) => (filterListeners.add(listener), () => void filterListeners.delete(listener)),
    () => pageFilters.get(key),
  );
  return [
    value ?? start ?? NO_FILTER,
    (next) => {
      pageFilters.set(key, next);
      for (const listener of filterListeners) listener();
    },
  ];
}
const NO_FILTER: FileSearchFilter = {};
