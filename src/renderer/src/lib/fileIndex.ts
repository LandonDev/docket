import { hostOfCwd } from "./tcserver/projects";
import { registry } from "./connection";
import { sameCheckout, subscribeGitChangedAt } from "./gitChanged";
import { listProjectFiles, type ProjectFile } from "./fs";
import { loweredPaths, prepareQuery, scorePathPrepared, type FuzzyHit } from "./fuzzy";
import { resolveWorkspacePath } from "./paths";
import { looksLikeProject } from "./recents";
import { normalizeEditorPath } from "./search";

const MAX_RECENTS = 30;
const MAX_RESULTS = 80;

/**
 * The project's file list, kept by host and cwd for the last
 * KEPT_CHECKOUTS checkouts asked. A kept list is names for ranking alone:
 * opening a file still goes through the host's checks. It paints at once
 * and is asked again behind the paint (`loadProjectFiles(cwd, true)`) only
 * when it is older than FRESH_MS or the window's own git-changed event
 * named its checkout: no host push tells of a file his editor, a terminal or
 * another host made, so age is the rule. A list is dropped when the link's
 * key (or credential) changes, or its host leaves the registry.
 */
export const KEPT_CHECKOUTS = 4;
export const FRESH_MS = 30_000;

type Kept = {
  host: string;
  cwd: string;
  files: ProjectFile[];
  /** When the answer landed (Date.now()). */
  at: number;
  /** The window's git-changed event named this checkout since. */
  dirty: boolean;
  /** The link's key when it was asked. */
  key: string;
};

const kept = new Map<string, Kept>();
/** An ask out, per slot, under the link key it was asked with; `changed` when a git-changed event named its
 *  checkout while it was out. */
const inflight = new Map<string, { cwd: string; key: string; promise: Promise<ProjectFile[]>; changed: boolean }>();
const epochs = new Map<string, number>();
const recentsByCwd = new Map<string, string[]>();
let offGitChanged: (() => void) | null = null;

function normCwd(cwd: string): string {
  return cwd.replace(/\/+$/, "") || "/";
}

const slotOf = (host: string, cwd: string): string => `${host}\n${cwd}`;

/** The link's key as the registry holds it now: a change drops what was kept under the old one. */
function linkKeyOf(host: string): string {
  const env = registry.environment(host);
  return env ? `${env.keyId ?? ""}\n${env.credentialRef ?? ""}` : "";
}

/** A kept list goes as soon as its host's key changes or its host leaves the registry, not at its next read. */
let offKeys: (() => void) | null = null;
function watchKeys(): void {
  if (offKeys || typeof registry.subscribe !== "function") return;
  offKeys = registry.subscribe(() => {
    for (const [slot, entry] of kept) if (entry.key !== linkKeyOf(entry.host)) kept.delete(slot);
  });
}

/** The window's git-changed event marks the checkouts it names (all, unscoped) to be asked again on their next open. */
function watchGitChanged(): void {
  if (offGitChanged || typeof window === "undefined") return;
  offGitChanged = subscribeGitChangedAt((changed) => {
    const names = (at: string) => !changed || sameCheckout(changed, at);
    for (const entry of kept.values()) if (names(entry.cwd)) entry.dirty = true;
    for (const ask of inflight.values()) if (names(ask.cwd)) ask.changed = true;
  });
}

/** The kept entry for this cwd on its host now, or null; one kept under another key is dropped. */
function keptFor(cwd: string): Kept | null {
  const host = hostOfCwd(cwd);
  const slot = slotOf(host, cwd);
  const entry = kept.get(slot);
  if (!entry) return null;
  if (entry.key !== linkKeyOf(host)) {
    kept.delete(slot);
    return null;
  }
  return entry;
}

export function peekProjectFiles(cwd: string): ProjectFile[] | null {
  return keptFor(cwd)?.files ?? null;
}

export function invalidateProjectFiles(cwd?: string) {
  if (!cwd) {
    kept.clear();
    for (const ask of inflight.values()) ask.changed = true;
    return;
  }
  for (const [slot, entry] of kept) if (entry.cwd === cwd) kept.delete(slot);
  for (const ask of inflight.values()) if (ask.cwd === cwd) ask.changed = true;
}

export function rememberOpenedFile(cwd: string, path: string) {
  if (!path) return;
  const key = normCwd(cwd);
  const prev = recentsByCwd.get(key) ?? [];
  recentsByCwd.set(
    key,
    [path, ...prev.filter((item) => item !== path)].slice(0, MAX_RECENTS),
  );
}

export function recentOpenedFiles(cwd: string): string[] {
  return recentsByCwd.get(normCwd(cwd)) ?? [];
}

/**
 * The project's files. Without `revalidate`, a kept list answers at once
 * whatever its age. With it (a picker's open), a kept list still answers
 * when it is fresh; one older than FRESH_MS, or named by a git-changed
 * event, is asked again. Opens while an ask is out join it: at most one
 * ask an open burst.
 */
export function loadProjectFiles(
  cwd: string,
  revalidate = false,
): Promise<ProjectFile[]> {
  if (!looksLikeProject(cwd)) return Promise.resolve([]);
  watchGitChanged();
  watchKeys();
  const host = hostOfCwd(cwd);
  const slot = slotOf(host, cwd);
  const entry = keptFor(cwd);
  if (entry && (!revalidate || (!entry.dirty && Date.now() - entry.at < FRESH_MS))) {
    // Most recent last: the LRU drops the first.
    kept.delete(slot);
    kept.set(slot, entry);
    return Promise.resolve(entry.files);
  }
  const key = linkKeyOf(host);
  // An ask out under another key is not joined: its names are not this key's.
  const running = inflight.get(slot);
  if (running && running.key === key) return running.promise;

  const id = (epochs.get(slot) ?? 0) + 1;
  epochs.set(slot, id);
  const promise = listProjectFiles(host, cwd)
    .then((files) => {
      // Asked under a key that has changed since: its names reach no caller and nothing keeps them.
      if (key !== linkKeyOf(host)) return [];
      if (id === epochs.get(slot)) {
        kept.delete(slot);
        kept.set(slot, { host, cwd, files, at: Date.now(), dirty: ask.changed, key });
        while (kept.size > KEPT_CHECKOUTS) kept.delete(kept.keys().next().value!);
      }
      return files;
    })
    .finally(() => {
      if (inflight.get(slot) === ask) inflight.delete(slot);
    });
  // A git-changed event while the ask is out still marks what lands.
  const ask = { cwd, key, promise, changed: false };
  inflight.set(slot, ask);
  return promise;
}

/**
 * An open picker's names for `cwd` are no longer good: its host's link key (or credential) changed, or the host
 * left (its key then reads empty). `dropped` is told once a change; the picker clears what it shows and asks again
 * (Composer's @, SearchView, Go to File).
 */
export function subscribeProjectFilesDropped(cwd: string, dropped: () => void): () => void {
  const host = hostOfCwd(cwd);
  let key = linkKeyOf(host);
  return registry.subscribe(() => {
    const now = linkKeyOf(host);
    if (now === key) return;
    key = now;
    dropped();
  });
}

/** Test seam: forget every kept list and stop listening. */
export function resetProjectFiles(): void {
  kept.clear();
  inflight.clear();
  epochs.clear();
  offGitChanged?.();
  offGitChanged = null;
  offKeys?.();
  offKeys = null;
}

export type RankedFile = ProjectFile & FuzzyHit;

export function rankProjectFiles(
  files: ProjectFile[],
  query: string,
  recents: string[],
  limit = MAX_RESULTS,
): RankedFile[] {
  const recentRank = new Map(recents.map((path, index) => [path, index]));

  if (!query.trim()) {
    const byPath = new Map(files.map((file) => [file.path, file]));
    const out: RankedFile[] = [];
    const seen = new Set<string>();
    for (const path of recents) {
      if (seen.has(path)) continue;
      seen.add(path);
      const file = byPath.get(path);
      if (!file) continue;
      out.push({ ...file, score: 0, positions: [] });
      if (out.length >= limit) break;
    }
    return out;
  }

  // The query split once a key, each path lower-cased once a list: a key visits each path once.
  const tokens = prepareQuery(query);
  const lower = loweredPaths(files);
  const scored: RankedFile[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const hit = scorePathPrepared(tokens, file.relative, lower.relative[i]!, file.name, lower.name[i]!);
    if (!hit) continue;
    const recency = recentRank.get(file.path);
    const score =
      hit.score + (recency == null ? 0 : (MAX_RECENTS - recency) * 8);
    scored.push({ ...file, score, positions: hit.positions });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.relative.length !== b.relative.length) {
      return a.relative.length - b.relative.length;
    }
    return a.relative.localeCompare(b.relative);
  });
  return scored.slice(0, limit);
}

/** Resolve a transcript or markdown file link to an existing project file. */
export async function resolveOpenablePath(
  cwd: string,
  href: string,
): Promise<string | undefined> {
  const direct = resolveWorkspacePath(href, cwd);
  if (!direct) return undefined;

  const files = await loadProjectFiles(cwd);
  if (files.length === 0) return direct;

  const byPath = new Map(
    files.map((file) => [normalizeEditorPath(file.path), file]),
  );
  const normalizedDirect = normalizeEditorPath(direct);
  const exact = byPath.get(normalizedDirect);
  if (exact) return exact.path;

  const relHint = relativePathHint(href, cwd, direct);
  const exactRelative = files.find(
    (file) =>
      file.relative === relHint ||
      normalizeEditorPath(file.relative) === relHint,
  );
  if (exactRelative) return exactRelative.path;

  const suffixMatches = files.filter(
    (file) =>
      file.relative === relHint ||
      file.relative.endsWith(`/${relHint}`) ||
      relHint.endsWith(file.relative),
  );
  if (suffixMatches.length === 1) return suffixMatches[0].path;

  const baseName = relHint.split("/").filter(Boolean).pop() ?? relHint;
  const byName = files.filter((file) => file.name === baseName);
  if (byName.length === 0) return direct;
  if (byName.length === 1) return byName[0].path;

  return pickOpenableFile(byName, cwd, relHint).path;
}

function relativePathHint(href: string, cwd: string, direct: string): string {
  let value = href.trim().replace(/\\/g, "/");
  value = value.replace(
    /(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)$/,
    "",
  );
  if (value.startsWith("file://")) {
    try {
      value = decodeURIComponent(value.slice("file://".length));
    } catch {
      value = value.slice("file://".length);
    }
    value = value.replace(/\\/g, "/");
  }
  value = value.replace(/^\.\//, "").replace(/^\/+/, "");

  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedDirect = normalizeEditorPath(direct);
  if (base && base !== "~" && normalizedDirect.startsWith(`${base}/`)) {
    return normalizedDirect.slice(base.length + 1);
  }
  return value;
}

function pickOpenableFile(
  candidates: ProjectFile[],
  cwd: string,
  relHint: string,
): ProjectFile {
  const recents = recentOpenedFiles(cwd);
  for (const recent of recents) {
    const normalizedRecent = normalizeEditorPath(recent);
    const hit = candidates.find(
      (file) => normalizeEditorPath(file.path) === normalizedRecent,
    );
    if (hit) return hit;
  }

  const suffixMatches = candidates.filter(
    (file) =>
      file.relative === relHint || file.relative.endsWith(`/${relHint}`),
  );
  if (suffixMatches.length > 0) {
    return suffixMatches.sort(
      (a, b) => a.relative.length - b.relative.length,
    )[0];
  }

  return candidates.sort((a, b) => a.relative.length - b.relative.length)[0];
}
