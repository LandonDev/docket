import type { LaunchMirrorSnapshot, MirrorCursor, MirrorSummary, MirrorWrite } from "@server/shared/launchMirror";
import { isWebMode, readLaunchMirror, writeLaunchMirror } from "../native";
import { registry, savedEnvironment } from "../connection";
import { metaEqual, sessionStore } from "./store";
import { workspaceStore } from "./workspaces";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "./types";

/**
 * The launch mirror on the renderer side (CLAUDE.md "Launch: the rail
 * paints from the launch mirror"). At boot `askLaunchMirror` asks preload once
 * for what every host last showed and `hydrateFromLaunchMirror` registers
 * the saved hosts so the rail has their sections, and seeds the session and
 * workspace stores, all before the first render and before any socket.
 * Then `installLaunchMirrorWriter` keeps the mirror current: after every
 * meta or catalog change it diffs each listed host's rows against what it
 * last wrote and sends the difference, coalesced, to the main process.
 */

/** Fields a meta carries only while a turn runs; the mirror leaves them out. */
const TRANSIENT: readonly (keyof SessionMeta)[] = ["activity", "activityKind", "background"];

export const MIRROR_WRITE_DELAY_MS = 750;

/** Two metas the mirror keeps the same: equal but for the transient fields. A
 *  running thread's push moves its activity and nothing the mirror holds. */
export function sameSummary(a: SessionMeta, b: SessionMeta): boolean {
  if (a === b) return true;
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!(TRANSIENT as readonly string[]).includes(key) && !metaEqual(left[key], right[key])) return false;
  }
  return true;
}

/** A meta as the mirror keeps it: the same object minus its transient fields. */
export function summarize(meta: SessionMeta): MirrorSummary {
  const out = { ...meta } as Record<string, unknown>;
  for (const key of TRANSIENT) delete out[key];
  return out as unknown as MirrorSummary;
}

/** The mirror's one ask, started at module top (main.tsx) so it rides beside
 *  the index chunk's evaluation; main answers it from its own read while the
 *  server boots. Null at /ui, in a test, or when the read fails. */
export function askLaunchMirror(): Promise<LaunchMirrorSnapshot | null> {
  if (isWebMode() || typeof window === "undefined") return Promise.resolve(null);
  return readLaunchMirror().catch((err: unknown) => {
    console.error("[launch-mirror] read failed", err);
    return null;
  });
}

/** Paint from the mirror. Returns what was read, or null when there is
 *  nothing to paint from (the /ui page, a first launch, a test). */
export function hydrateFromLaunchMirror(snapshot: LaunchMirrorSnapshot | null): LaunchMirrorSnapshot | null {
  if (!snapshot) return null;
  // The saved hosts first, so the rail groups their rows under their own
  // sections from the first frame; loadSavedEnvironments confirms them later.
  for (const env of snapshot.environments) registry.add(savedEnvironment(env));
  sessionStore.hydrate(snapshot.hosts);
  workspaceStore.hydrate(snapshot.hosts);
  return snapshot;
}

export type WriterSessionSource = {
  /** A flush's changed ids, when the source names them: the writer then visits those alone. */
  onMetaChange(listener: (changes?: { ids: ReadonlySet<string> }) => void): () => void;
  metas(): SessionMeta[];
  /** One meta by id; a source without it is diffed whole at each write. */
  metaOf?(id: string): SessionMeta | null;
  cursorOf(environmentId: string): MirrorCursor | null;
  listedEnvironmentIds(): string[];
};
export type WriterCatalogSource = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { workspaces: readonly WorkspaceMeta[]; projects: readonly ProjectMeta[] };
};
export type WriterDeps = {
  sessions: WriterSessionSource;
  catalog: WriterCatalogSource;
  write(write: MirrorWrite): void;
  delayMs?: number;
  /** The document whose `visibilitychange` flushes a pending write at once. */
  doc?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> | null;
};

type HostState = {
  /** The metas last written, by id, as the objects they were: identity is the diff. */
  written: Map<string, SessionMeta>;
  workspaces: readonly WorkspaceMeta[] | null;
  projects: readonly ProjectMeta[] | null;
  cursor: MirrorCursor | null;
};

/**
 * Keep the mirror current. Only a host whose list has landed this boot is
 * written (a host still painted from the mirror would be rewritten from
 * itself); its first write is `full`, every later one the rows whose meta
 * object changed and the ids that left. Pending writes flush after a quiet
 * `delayMs`, or at once when the page hides.
 */
export function installLaunchMirrorWriter(deps: WriterDeps): () => void {
  const delay = deps.delayMs ?? MIRROR_WRITE_DELAY_MS;
  const hosts = new Map<string, HostState>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  /** The ids changed since the last write; null when a change named none (diff every row). */
  let changed: Set<string> | null = new Set();
  /** The hosts listed at the last write: one listed again may have missed changes while it was not. */
  let wasListed = new Set<string>();

  /** Whether a meta moves what the mirror holds for it. */
  const moves = (was: SessionMeta | undefined, now: SessionMeta): boolean => was !== now && (!was || !sameSummary(was, now));

  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    const listed = new Set(deps.sessions.listedEnvironmentIds());
    if (listed.size === 0) return;
    const ids = changed;
    changed = new Set();
    const metaOf = deps.sessions.metaOf ? (id: string) => deps.sessions.metaOf!(id) : null;
    // A host's first write, a change that named no ids or a source that cannot
    // look one up diffs every row; otherwise only the changed ids are visited.
    let byHost: Map<string, Map<string, SessionMeta>> | null = null;
    const anew = [...listed].some((environmentId) => !hosts.has(environmentId) || !wasListed.has(environmentId));
    wasListed = listed;
    if (!ids || !metaOf || anew) {
      byHost = new Map();
      for (const meta of deps.sessions.metas()) {
        if (!listed.has(meta.environmentId)) continue;
        let rows = byHost.get(meta.environmentId);
        if (!rows) byHost.set(meta.environmentId, (rows = new Map()));
        rows.set(meta.id, meta);
      }
    }
    const catalog = deps.catalog.getSnapshot();
    for (const environmentId of listed) {
      let state = hosts.get(environmentId);
      const first = !state;
      if (!state) hosts.set(environmentId, (state = { written: new Map(), workspaces: null, projects: null, cursor: null }));
      const write: MirrorWrite = { environmentId };
      const upserts: MirrorSummary[] = [];
      const removed: string[] = [];
      if (byHost) {
        const current = byHost.get(environmentId) ?? new Map<string, SessionMeta>();
        for (const [id, meta] of current) if (moves(state.written.get(id), meta)) upserts.push(summarize(meta));
        for (const id of state.written.keys()) if (!current.has(id)) removed.push(id);
        state.written = current;
      } else {
        for (const id of ids!) {
          const meta = metaOf!(id);
          const here = meta && meta.environmentId === environmentId ? meta : null;
          const was = state.written.get(id);
          if (here) {
            if (moves(was, here)) upserts.push(summarize(here));
            state.written.set(id, here);
          } else if (was) {
            removed.push(id);
            state.written.delete(id);
          }
        }
      }
      if (first) write.full = true;
      if (upserts.length > 0) write.upserts = upserts;
      if (removed.length > 0) write.removed = removed;
      const cursor = deps.sessions.cursorOf(environmentId);
      if (first || cursor?.seq !== state.cursor?.seq || cursor?.generation !== state.cursor?.generation) {
        write.cursor = cursor;
      }
      const workspaces = catalog.workspaces.filter((w) => w.environmentId === environmentId);
      const projects = catalog.projects.filter((p) => p.environmentId === environmentId);
      if (first || !sameRows(workspaces, state.workspaces)) write.workspaces = workspaces;
      if (first || !sameRows(projects, state.projects)) write.projects = projects;
      const wrote = first || upserts.length > 0 || removed.length > 0 || "cursor" in write || "workspaces" in write || "projects" in write;
      if (!wrote) continue;
      state.cursor = cursor;
      state.workspaces = workspaces;
      state.projects = projects;
      try {
        deps.write(write);
      } catch (err) {
        console.error("[launch-mirror] write failed", err);
      }
    }
  };

  const schedule = (): void => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(flush, delay);
  };
  const onVisibility = (): void => {
    if (deps.doc?.visibilityState === "hidden") flush();
  };
  const onMetas = (changes?: { ids: ReadonlySet<string> }): void => {
    if (!changes || changes.ids.size === 0) changed = null;
    else if (changed) for (const id of changes.ids) changed.add(id);
    schedule();
  };
  const offs = [deps.sessions.onMetaChange(onMetas), deps.catalog.subscribe(schedule)];
  deps.doc?.addEventListener("visibilitychange", onVisibility);
  // The lists that landed before the writer was installed.
  schedule();
  return () => {
    for (const off of offs) off();
    deps.doc?.removeEventListener("visibilitychange", onVisibility);
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

function sameRows<T>(a: readonly T[], b: readonly T[] | null): boolean {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The desktop wiring: the stores, the registry's primary and preload's write. */
export function installLaunchMirror(): () => void {
  if (isWebMode() || typeof window === "undefined") return () => {};
  return installLaunchMirrorWriter({
    sessions: sessionStore,
    catalog: workspaceStore,
    write: writeLaunchMirror,
    doc: document,
  });
}
