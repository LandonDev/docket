import { useSyncExternalStore } from "react";
import type { MenuRow } from "../chrome/menuRows";
import type { Link } from "./connection/link";
import type { Environment } from "./connection/types";

/**
 * The Work switch as this window knows it (docs/agents/work.md "The
 * switch"): one `work.get` per host when its socket opens, kept current by
 * the `work` push. It is first-paint code, so it holds only the answer and
 * the seams Work's own chunk (work/shell) fills when it loads: nothing of
 * Work's screens or wire types comes in through here.
 *
 * The rail, the column and Settings show Work things only while some host
 * has the switch on; with every host off they are today's app. The last
 * answers are remembered so a launch paints the rail it had, and the first
 * answer of this launch replaces them.
 */

const STORAGE_KEY = "work.on.v1";
const REMEMBERED_GRACE_MS = 15_000;
type Listener = () => void;

function remembered(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

let on = remembered();
let outboxWaiting = 0;
let outboxFailed = 0;
const listeners = new Set<Listener>();
const links = new Map<string, () => void>();

function write(next: Set<string>): void {
  if (next.size === on.size && [...next].every((id) => on.has(id))) return;
  on = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...on]));
  } catch {
    // private mode / quota
  }
  for (const listener of listeners) listener();
}

/** One host's switch, as it answered. */
export function setWorkOn(environmentId: string, enabled: boolean): void {
  const next = new Set(on);
  if (enabled) next.add(environmentId);
  else next.delete(environmentId);
  write(next);
}

function attach(link: Link): void {
  links.get(link.environmentId)?.();
  const ask = (): void => {
    link
      .request<{ enabled: boolean }>("work.get")
      .then((answer) => setWorkOn(link.environmentId, !!answer?.enabled))
      // A host from before Work cannot answer: it has no Work. A dropped socket says nothing: the next open asks again.
      .catch((error: unknown) => {
        if (/unknown method|bad request|invalid request/i.test(error instanceof Error ? error.message : String(error))) setWorkOn(link.environmentId, false);
      });
  };
  const offPush = link.onPush((push) => {
    if (push.push === "work") setWorkOn(link.environmentId, !!push.settings.enabled);
  });
  const offOpen = link.onOpen(ask);
  if (link.connected) ask();
  links.set(link.environmentId, () => {
    offPush();
    offOpen();
  });
}

export const workSwitch = {
  /** Follow the registry: each host's switch while its link lives. */
  connect(registry: { onLink(listener: (link: Link, event: "added" | "removed") => void): () => void }): () => void {
    // A host remembered on that never comes back (unpaired while the app was closed) stops counting once the links have had their time.
    const prune = setTimeout(() => write(new Set([...on].filter((id) => links.has(id)))), REMEMBERED_GRACE_MS);
    const off = registry.onLink((link, event) => {
      if (event === "added") attach(link);
      else {
        links.get(link.environmentId)?.();
        links.delete(link.environmentId);
        setWorkOn(link.environmentId, false);
      }
    });
    return () => {
      clearTimeout(prune);
      off();
    };
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  /** The hosts whose switch is on. */
  hosts: (): ReadonlySet<string> => on,
  /** Whether any host has Work on. */
  anyOn: (): boolean => on.size > 0,
  /** Test seam. */
  reset(): void {
    for (const off of links.values()) off();
    links.clear();
    on = new Set();
    outboxWaiting = 0;
    outboxFailed = 0;
    lifeosProjects.clear();
    openView = null;
    for (const listener of listeners) listener();
  },
};

/** True while some host has Work on. */
export function useWorkOn(): boolean {
  return useSyncExternalStore(workSwitch.subscribe, workSwitch.anyOn, workSwitch.anyOn);
}

/** The hosts whose switch is on, the same set until one changes. */
export function useWorkHosts(): ReadonlySet<string> {
  return useSyncExternalStore(workSwitch.subscribe, workSwitch.hosts, workSwitch.hosts);
}

/** How many held items wait in the Outbox, across hosts: the Outbox's
 *  milestone (14) sets it; the rail shows its row only while it is above 0. */
export function setOutboxWaiting(count: number): void {
  if (count === outboxWaiting) return;
  outboxWaiting = count;
  for (const listener of listeners) listener();
}

/** Of those waiting, how many failed to send: the rail's Outbox row then shows the failed mark in place of its count. */
export function setOutboxFailed(count: number): void {
  if (count === outboxFailed) return;
  outboxFailed = count;
  for (const listener of listeners) listener();
}

export function useOutboxFailed(): number {
  const read = (): number => outboxFailed;
  return useSyncExternalStore(workSwitch.subscribe, read, read);
}

export function useOutboxWaiting(): number {
  const read = (): number => outboxWaiting;
  return useSyncExternalStore(workSwitch.subscribe, read, read);
}

/**
 * What the rail asks of Work's chunk (work/shell/WorkRailHost.tsx registers it
 * when the chunk loads): the rows of the Work heading's + menu and of a
 * code workspace's "LifeOS sector" submenu, and what a pick does. Null
 * until the chunk has loaded.
 */
export interface WorkRailPort {
  addRows(): MenuRow[];
  sectorRows(workspacePath: string): MenuRow[];
  pick(action: string, workspacePath: string | null): void;
}

let port: WorkRailPort | null = null;
let portWaiters: (() => void)[] = [];
export const workRailPort = {
  get: (): WorkRailPort | null => port,
  set(next: WorkRailPort | null): void {
    port = next;
    if (next) for (const resolve of portWaiters.splice(0)) resolve();
  },
  /** Resolves once the chunk's host has registered (it does so a commit after the chunk lands). */
  ready: (): Promise<void> => (port ? Promise.resolve() : new Promise((resolve) => portWaiters.push(resolve))),
};

/** The menu id of the Work heading's +, and the prefix of every row the port answers. */
export const WORK_ADD_MENU = "work:add";
export const isWorkMenuAction = (action: string): boolean => action.startsWith("work:");

// ── the Work column ────────────────────────────────────────────────────

/** A LifeOS project of a linked Work workspace, as Work's chunk lists it live. */
export interface LifeosProjectRow {
  id: string;
  name: string;
}

const lifeosProjects = new Map<string, readonly LifeosProjectRow[]>();
const NO_PROJECTS: readonly LifeosProjectRow[] = [];

/** A Work workspace's LifeOS projects, set by Work's column (work/shell/WorkColumn.tsx) while it is on screen. */
export function setLifeosProjects(workspaceId: string, rows: readonly LifeosProjectRow[]): void {
  const prev = lifeosProjects.get(workspaceId) ?? NO_PROJECTS;
  if (prev.length === rows.length && prev.every((p, i) => p.id === rows[i]!.id && p.name === rows[i]!.name)) return;
  lifeosProjects.set(workspaceId, rows);
  for (const listener of listeners) listener();
}

export function useLifeosProjects(workspaceId: string | null | undefined): readonly LifeosProjectRow[] {
  const read = (): readonly LifeosProjectRow[] => (workspaceId ? (lifeosProjects.get(workspaceId) ?? NO_PROJECTS) : NO_PROJECTS);
  return useSyncExternalStore(workSwitch.subscribe, read, read);
}

/** The id of a LifeOS project's card before it holds a thread: no project row exists yet. */
export const LIFEOS_CARD = "lifeos:";
export const lifeosCardId = (lifeosProjectId: string): string => `${LIFEOS_CARD}${lifeosProjectId}`;

/** What the column asks of Work's chunk: the project that holds a LifeOS project's threads, made at the first ask. */
export interface WorkColumnPort {
  openProject(workspaceId: string, lifeosProjectId: string): Promise<string>;
}
let columnPort: WorkColumnPort | null = null;
export const workColumnPort = {
  get: (): WorkColumnPort | null => columnPort,
  set(next: WorkColumnPort | null): void {
    columnPort = next;
  },
};

/** A Work view open in the main pane, under the thread strip (Mail, Tasks, Agenda or Docs of one workspace). */
export interface OpenWorkView {
  workspaceId: string;
  view: string;
  /** Projects alone: the LifeOS project to stand on (a card's Open project). The view takes it once and clears it. */
  project?: string;
}
let openView: OpenWorkView | null = null;

export function openWorkView(next: OpenWorkView | null): void {
  if (openView?.workspaceId === next?.workspaceId && openView?.view === next?.view && openView?.project === next?.project) return;
  openView = next;
  for (const listener of listeners) listener();
}

/** The view open now, read outside React. */
export const workViewNow = (): OpenWorkView | null => openView;

export function useWorkView(): OpenWorkView | null {
  const read = (): OpenWorkView | null => openView;
  return useSyncExternalStore(workSwitch.subscribe, read, read);
}

/** How Work's views start a thread (App registers it): a new thread's draft, focused, in `projectId` or none,
 *  in the window's workspace or, given `cwd`, in that workspace, which the window moves to (a task's code
 *  thread); answers the draft's id, which the caller gives its chip. */
type StartPort = (projectId: string | null, cwd?: string) => string;
let startPort: StartPort | null = null;
export const workStartPort = {
  get: () => startPort,
  set(next: StartPort | null): void {
    startPort = next;
  },
};

/** How Work's views open a thread (App registers it): a routine's run, the thread that set a watch. */
let openPort: ((sessionId: string) => void) | null = null;
export const workOpenPort = {
  get: () => openPort,
  set(next: ((sessionId: string) => void) | null): void {
    openPort = next;
  },
};

const HOME_KEY = "work.home.v1";

/**
 * The host new Work things go to (a Work workspace from the + menu, a Work
 * Chat): the one picked on the Work page, else the box (the Linux host, the
 * owner's default), else this machine, else any; always one whose switch is
 * on. Null while no host has Work on.
 */
export function workHome(environments: readonly Pick<Environment, "id" | "platform">[], primary: string): string | null {
  const candidates = environments.filter((e) => on.has(e.id));
  let picked: string | null = null;
  try {
    picked = globalThis.localStorage?.getItem(HOME_KEY) ?? null;
  } catch {
    picked = null;
  }
  if (picked && candidates.some((e) => e.id === picked)) return picked;
  return (candidates.find((e) => e.platform === "linux") ?? candidates.find((e) => e.id === primary) ?? candidates[0])?.id ?? null;
}

export function setWorkHome(environmentId: string): void {
  try {
    globalThis.localStorage?.setItem(HOME_KEY, environmentId);
  } catch {
    // private mode / quota
  }
}
