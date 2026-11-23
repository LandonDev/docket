import type { FileCrumb, FilePage, FilesPlaces, FileTab } from "@shared/contract-work-files";
import type { TeamsEntry, TeamsLibrariesAnswer, TeamsPlace } from "@shared/contract-work-office";
import { kindOfEntry, PLACE, refKey, refusal, threadCanvasOf, type FileEntry, type FilePlace, type FileSort, type FileVerb, type FolderRef, type PlaceKind } from "@shared/work/files";
import { placesIn, type LibraryPlace } from "@shared/work/filePlaces";

/**
 * The Files place's own rules in the window (docs/agents/work-files.md), kept apart from the screen so they are
 * tested alone: how each host's places read as one sidebar, which computer answers for a place two hold, where a
 * file opens, the one line said when Teams files are missing, and what a host a release behind still answers.
 */

/** One host's answer to `work.files.places`, or why it gave none. */
export interface HostRead {
  /** the window's link to the host ("local" for this machine) */
  link: string;
  /** the host as he names it */
  name: string;
  /** a Mac or a PC: its own OneDrive folders count */
  desktop: boolean;
  /** `office`: a host a release behind, read through the old wire (`work.office.files*`) */
  wire: "files" | "office";
  answer?: FilesPlaces;
  failed?: { words: string; unreachable: boolean };
}

/** One copy of a place: the place as one host answered it, and the link the window asks it through. */
export interface PlaceCopy {
  place: FilePlace;
  link: string;
  /** the computer, as he names it */
  host: string;
  wire: "files" | "office";
}

/** One place, once, however many computers hold it (`key`), with its copies in the order they are read. */
export interface PlaceRow {
  key: string;
  name: string;
  /** the team or site it is under; "" for his own files and folders he added */
  group: string;
  kind: PlaceKind;
  copies: PlaceCopy[];
}

/** A row of the sidebar's Places: one place, or a team whose channels are one level in. */
export type SidebarRow = { is: "place"; row: PlaceRow } | { is: "team"; name: string; rows: PlaceRow[] };

export interface Sidebar {
  /** Home, where the workspace's own host has one: the page a new tab opens on */
  home: PlaceCopy | null;
  /** Recent and Starred, from the workspace's own host */
  marks: PlaceCopy[];
  /** the lenses under the places (Trash; From mail and Made by threads as they land), from the workspace's own host */
  lenses: PlaceCopy[];
  /** the workspace's folder, where its host answered it */
  folder: PlaceCopy | null;
  /** LifeOS, where the workspace has a sector: its documents and sheets, its projects as folders */
  lifeos: PlaceCopy | null;
  /** each Google Drive of the workspace, one row an account */
  drives: PlaceCopy[];
  /** the sector's projects, each a lens, in the order its host lists them */
  projects: PlaceCopy[];
  places: SidebarRow[];
  /** every library place, each once */
  rows: PlaceRow[];
}

const LIBRARY: readonly PlaceKind[] = ["teams", "onedrive"];
const usable = (copy: PlaceCopy): boolean => copy.place.state.state === "ok" || copy.place.state.state === "asleep";

/**
 * The sidebar from what each host answered. A place two computers hold is one row: its copy on the workspace's own
 * host first while it answers (a library in its VM needs no Mac), then a desktop's, then the rest. A merged row takes
 * its name and team from a copy that names them apart (a team's library under Windows: "RecWell", "Team RecWell"),
 * so a Mac's one-word folders read as that team's. A team with several channels is one row, its channels one level in.
 */
export function sidebarOf(reads: readonly HostRead[], workspaceLink: string): Sidebar {
  const copies = reads.flatMap((read) => (read.answer?.places ?? []).map((place): PlaceCopy => ({ place, link: read.link, host: place.vm ? "Windows VM" : read.name, wire: read.wire })));
  const own = copies.filter((c) => c.link === workspaceLink);
  const marks = own.filter((c) => c.place.kind === "recent" || c.place.kind === "starred");
  const LENS_ORDER: readonly PlaceKind[] = ["mail", "made", "trash"];
  const lenses = own.filter((c) => LENS_ORDER.includes(c.place.kind)).sort((a, b) => LENS_ORDER.indexOf(a.place.kind) - LENS_ORDER.indexOf(b.place.kind));
  const folder = own.find((c) => c.place.kind === "folder") ?? null;
  const rank = (c: PlaceCopy): number => (c.link === workspaceLink ? (usable(c) ? 0 : 2) : 1);
  const byKey = new Map<string, { named: PlaceCopy[]; copies: (PlaceCopy & { order: number })[] }>();
  let order = 0;
  for (const copy of copies) {
    if (!LIBRARY.includes(copy.place.kind)) continue;
    const key = copy.place.key ?? copy.place.id;
    const row = byKey.get(key) ?? { named: [], copies: [] };
    // A copy that names its team apart from its own name names the row.
    if (copy.place.group && copy.place.group !== copy.place.name) row.named.unshift(copy);
    else row.named.push(copy);
    row.copies.push({ ...copy, order: order++ });
    byKey.set(key, row);
  }
  const rows: PlaceRow[] = [...byKey].map(([key, { named, copies: all }]) => {
    const { place } = named[0]!;
    return { key, name: place.name, group: place.group ?? "", kind: place.kind, copies: all.sort((a, b) => rank(a) - rank(b) || a.order - b.order).map(({ order: _order, ...copy }) => copy) };
  });
  const teams = new Map<string, PlaceRow[]>();
  for (const row of rows) teams.set(row.group, [...(teams.get(row.group) ?? []), row]);
  const places: SidebarRow[] = [];
  for (const [name, of] of [...teams].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))) {
    // His own files and folders he added are rows of their own; so is a library known by one name.
    if (name === "" || (of.length === 1 && of[0]!.name === name)) places.push(...of.map((row): SidebarRow => ({ is: "place", row })));
    else places.push({ is: "team", name, rows: of.sort((a, b) => a.name.localeCompare(b.name)) });
  }
  return {
    home: own.find((c) => c.place.kind === "home") ?? null,
    marks,
    lenses,
    folder,
    lifeos: own.find((c) => c.place.kind === "lifeos") ?? null,
    drives: own.filter((c) => c.place.kind === "drive"),
    projects: own.filter((c) => c.place.kind === "project"),
    places,
    rows,
  };
}

/** A team's own page: its channels as folders. No host is asked: the places already say them. */
export const TEAM_PREFIX = "team:";
export const teamPage = (name: string): FilePage => ({ at: { at: "place", id: `${TEAM_PREFIX}${name}` }, name });
export const teamOfPage = (at: FolderRef): string | null => (at.at === "place" && at.id.startsWith(TEAM_PREFIX) ? at.id.slice(TEAM_PREFIX.length) : null);

/** The copy a place is read from: the first whose computer answers; else the first, which says why not. */
export const readCopy = (row: PlaceRow): PlaceCopy => row.copies.find(usable) ?? row.copies[0]!;

/** A team's channels as the rows of its page. */
export function teamEntries(rows: readonly PlaceRow[]): FileEntry[] {
  return rows.map((row) => {
    const { place } = readCopy(row);
    return { key: `place:${row.key}`, ref: null, folder: place.root, name: row.name, kind: "folder", shared: true };
  });
}

/** The page a place opens on. */
export const placePage = (copy: PlaceCopy, name = copy.place.name): FilePage => ({ at: copy.place.root, name });

/** Whether two folder refs name the same place to stand on. */
export const samePage = (a: FolderRef, b: FolderRef): boolean => refKey(a) === refKey(b);

/**
 * The place a folder ref lies in, among the places the hosts answered: the place whose top is the folder or holds
 * it (the longest top wins), and the copy that holds it. A lens or a team's page is itself.
 */
export function placeOfRef(sidebar: Sidebar, at: FolderRef): { copy: PlaceCopy; row: PlaceRow | null } | null {
  if (at.at === "place") {
    const copy = [...(sidebar.home ? [sidebar.home] : []), ...sidebar.marks, ...sidebar.lenses, ...(sidebar.folder ? [sidebar.folder] : []), ...(sidebar.lifeos ? [sidebar.lifeos] : []), ...sidebar.drives, ...sidebar.projects].find((c) => c.place.id === at.id);
    if (copy) return { copy, row: null };
    for (const row of sidebar.rows) for (const c of row.copies) if (c.place.id === at.id) return { copy: c, row };
    return null;
  }
  // A project is a folder of LifeOS: what can be done in it is LifeOS's own to say. A Drive folder is its account's.
  if (at.at === "project") return sidebar.lifeos ? { copy: sidebar.lifeos, row: null } : null;
  if (at.at === "drive") {
    const drive = sidebar.drives.find((c) => c.place.root.at === "drive" && c.place.root.account === at.account);
    return drive ? { copy: drive, row: null } : null;
  }
  if (at.at !== "file") return null;
  const under = (top: FolderRef): boolean => {
    if (top.at !== "file" || top.host !== at.host) return false;
    const guest = top.path.includes("\\") && !top.path.includes("/");
    const [a, b] = guest ? [at.path.toLowerCase(), top.path.toLowerCase()] : [at.path, top.path];
    return a === b || a.startsWith(`${b.replace(/[\\/]+$/, "")}${guest ? "\\" : "/"}`);
  };
  let best: { copy: PlaceCopy; row: PlaceRow | null } | null = null;
  const consider = (copy: PlaceCopy, row: PlaceRow | null): void => {
    if (!under(copy.place.root)) return;
    const len = copy.place.root.at === "file" ? copy.place.root.path.length : 0;
    const was = best && best.copy.place.root.at === "file" ? best.copy.place.root.path.length : -1;
    if (len > was) best = { copy, row };
  };
  if (sidebar.folder) consider(sidebar.folder, null);
  for (const row of sidebar.rows) for (const copy of row.copies) consider(copy, row);
  return best;
}

/** The trail over a folder: its team first when the place is one of a team's channels, then what the host said. */
export function trailOf(row: PlaceRow | null, trail: readonly FileCrumb[]): FileCrumb[] {
  if (!row || !row.group || row.group === row.name) return [...trail];
  return [{ name: row.group, at: teamPage(row.group).at }, ...trail];
}

// ── where a file opens ────────────────────────────────────────────────

/**
 * How a file opens from a row: `tab` in the Files pane, on the workspace's host (a file of another computer comes
 * as a copy he allowed); `thread` as it did before there were tabs, in a new thread's canvas, for a workspace whose
 * host is a release behind and keeps none; `app` in its own app where it lies: an old Office form or a sound in a
 * library, which has its app behind it and no viewer here, and any file where no copy is allowed. In a tab every
 * file opens (`seatOf`): what has no viewer of its own shows its facts.
 */
export type OpenWay = "tab" | "thread" | "app";

export function openWay(entry: Pick<FileEntry, "name" | "kind">, copy: Pick<PlaceCopy, "link" | "place" | "wire">, workspace: { link: string; tabs: boolean; copy: boolean }): OpenWay {
  const what = kindOfEntry(entry.name);
  const library = LIBRARY.includes(copy.place.kind);
  const here = copy.link === workspace.link && !copy.place.vm;
  const office = library && here && isOffice(entry.name);
  if (!workspace.tabs) {
    // Beside a thread the `file` kind does not seat yet: text and sound in a library, and what no kind shows, open in their app.
    const shown = threadCanvasOf(entry.name) !== null && !(library && (what.kind === "text" || what.kind === "audio"));
    if (!shown && !office) return "app";
    return !here && !workspace.copy ? "app" : "thread";
  }
  if (library && !office && (what.canvas === null || what.kind === "audio")) return "app";
  if (!here && !workspace.copy) return "app";
  return "tab";
}
const isOffice = (name: string): boolean => /\.(xlsx|xlsm|xlsb|xls|docx|docm|doc|rtf|odt|pptx|pptm|ppt|odp)$/i.test(name);

/** The verb for a file's own app: "Open in Excel", or "Open in its app". */
export function appVerb(entry: Pick<FileEntry, "name" | "kind">): string {
  if (entry.kind === "sheet" && !/\.csv$/i.test(entry.name)) return "Open in Excel";
  if (entry.kind === "document") return "Open in Word";
  if (entry.kind === "deck") return "Open in PowerPoint";
  return "Open in its app";
}

// ── a host a release behind ───────────────────────────────────────────

/** Whether a failure says the host does not know `work.files.*`: an older build, read through the old wire. */
export function unknownMethod(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /unknown method|not built: work\.files|unsupported method|method not found|invalid request|Invalid input/i.test(text) && !/timed? ?out|not connected/i.test(text);
}

const OLD_STATE: Record<TeamsPlace["state"], FilePlace["state"]["state"]> = { ok: "ok", "no-onedrive": "no-onedrive", "signed-out": "signed-out", "no-libraries": "no-libraries", "not-set-up": "not-set-up", error: "error", reading: "reading" };

/** What `work.office.filesLibraries` answered, as the places the new wire would have said. Such a host keeps no tabs and no marks. */
export function placesFromOld(answer: TeamsLibrariesAnswer): { places: FilesPlaces; libraries: LibraryPlace[] } {
  const vm = answer.places?.find((p) => p.kind === "vm");
  const libraries = answer.libraries.flatMap((library) => placesIn(library, library.vm && vm && vm.state !== "ok" ? { state: OLD_STATE[vm.state], ...(vm.detail ? { detail: vm.detail } : {}) } : { state: "ok" }));
  return { places: { host: answer.host, places: libraries.map((l) => l.place), rev: 0, sources: answer.places ?? [] }, libraries };
}

/** An old wire's entry as the new wire's row, keyed as the new wire keys it. */
export function entryFromOld(entry: TeamsEntry, place: Pick<FilePlace, "key" | "id" | "root">, host: string): FileEntry {
  const here = { at: "file" as const, host, path: entry.path };
  const folder = entry.kind === "folder";
  const top = place.root.at === "file" ? place.root.path : "";
  return {
    key: refKey(here, { key: place.key ?? place.id, path: top }),
    ref: folder ? null : here,
    folder: folder ? here : null,
    name: entry.name,
    kind: folder ? "folder" : kindOfEntry(entry.name).kind,
    ...(folder ? {} : { size: entry.size, local: entry.local }),
    changed: entry.modified,
    ...(entry.by ? { by: entry.by } : {}),
    shared: true,
    ...(!folder && !entry.local ? { state: { is: "cloud" as const } } : {}),
  };
}

/** The trail the old wire never said: the place, then each folder below its top. */
export function trailFromOld(place: Pick<FilePlace, "name" | "root">, at: FolderRef): FileCrumb[] {
  if (place.root.at !== "file" || at.at !== "file") return [{ name: place.name, at: place.root }];
  const sep = place.root.path.includes("\\") && !place.root.path.includes("/") ? "\\" : "/";
  const parts = at.path.slice(place.root.path.length).split(/[\\/]/).filter(Boolean);
  let dir = place.root.path.replace(/[\\/]+$/, "");
  const host = place.root.host;
  return [{ name: place.name, at: place.root }, ...parts.map((name) => ({ name, at: { at: "file" as const, host, path: (dir = `${dir}${sep}${name}`) } }))];
}

// ── what stands between him and Teams files ───────────────────────────

/** What the view says when Teams files are missing, or one place needs him: the one most useful thing, and its one press. */
export interface FilesNote {
  title: string;
  line?: string;
  /** a machine did not answer: said on the state line */
  away?: true;
  fix?: { kind: "allow"; vm: boolean } | { kind: "retry" } | { kind: "sign-in"; link: string } | { kind: "open-vm"; link: string } | { kind: "settings" } | { kind: "wake"; link: string };
}

export interface NoteInput {
  workspaceLink: string;
  /** the workspace's own host first, then each desktop it may use */
  reads: readonly HostRead[];
  windowsVm: boolean;
  /** his desktops this workspace may not use yet, by name */
  notAllowed: readonly string[];
  /** the library places listed */
  rows: readonly PlaceRow[];
}

const names = (list: readonly string[]): string => (list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);
const vmSource = (read: HostRead | undefined): TeamsPlace | undefined => read?.answer?.sources.find((p) => p.kind === "vm");
const VM = "the Windows VM";

/**
 * Why no Teams place (or fewer than he expects) is listed, in the order the causes are checked (the Teams view's own
 * table, docs/agents/work-teams-files.md "When nothing is listed"). With places listed it names only one that needs
 * him; null: nothing to say.
 */
export function teamsNote({ workspaceLink, reads, windowsVm, notAllowed, rows }: NoteInput): FilesNote | null {
  const own = reads.find((r) => r.link === workspaceLink);
  const vm = windowsVm ? vmSource(own) : undefined;
  const away = reads.filter((r) => r.failed?.unreachable);
  if (rows.length) {
    // A desktop that did not answer goes unsaid while the VM lists its copies; the state line says it otherwise.
    if (away.length && !rows.some((row) => row.copies.some((c) => c.place.vm))) return { title: `${names(away.map((r) => r.name))} did not answer`, fix: { kind: "retry" }, away: true };
    if (vm?.state === "signed-out") return { title: "OneDrive on the Windows VM is signed out", fix: { kind: "sign-in", link: workspaceLink } };
    // The VM's helper did not answer its last read: its rows are what was kept, and the state line says why.
    if (vm?.state === "error") return { title: "The Windows VM did not answer", line: vm.detail, fix: { kind: "retry" }, away: true };
    return null;
  }
  // The workspace's own host refused, and nothing else answered: its own words.
  if (own?.failed && !own.failed.unreachable && reads.every((r) => r.failed)) return { title: "Files did not load", line: own.failed.words, fix: { kind: "retry" } };
  // It may use no computer that has his files yet.
  const hostVm = vmSource(own);
  const canVm = !windowsVm && !!hostVm && hostVm.state !== "not-set-up";
  const allowed = reads.filter((r) => r.link !== workspaceLink);
  if (!allowed.length && !windowsVm && (notAllowed.length || canVm))
    return { title: "This workspace can't use your computers yet", line: `Allow ${names([...notAllowed, ...(canVm ? [VM] : [])])} to list your Teams files.`, fix: { kind: "allow", vm: canVm } };
  // A machine it may use is not answering.
  if (away.length) return { title: `${names(away.map((r) => r.name))} did not answer`, fix: { kind: "retry" }, away: true };
  // OneDrive in the VM needs his sign-in, or the VM is the only place and is not set up.
  if (vm?.state === "signed-out") return { title: "OneDrive on the Windows VM is signed out", fix: { kind: "sign-in", link: workspaceLink } };
  const folders = reads.filter((r) => r.desktop).flatMap((r) => (r.answer?.sources ?? []).filter((p) => p.kind === "folders").map((place) => ({ read: r, place })));
  if (vm?.state === "not-set-up" && !folders.length) return { title: "The Windows VM is not set up", fix: { kind: "settings" } };
  // A place answers, and no Teams library is synced there.
  for (const { read, place } of folders) {
    if (place.state === "ok" || place.state === "no-libraries") return { title: `No Teams files on ${read.name}`, line: "Sync a channel from Teams with OneDrive there." };
    if (place.state === "no-onedrive") return { title: `OneDrive is not signed in on ${read.name}`, line: "Sign in there, then sync a channel from Teams." };
  }
  if (vm && (vm.state === "ok" || vm.state === "no-libraries")) return { title: "No Teams files on the Windows VM", line: "Sync a channel from Teams with OneDrive there.", fix: { kind: "open-vm", link: workspaceLink } };
  const broken = [...folders.map((f) => ({ name: f.read.name, place: f.place })), ...(vm ? [{ name: VM, place: vm }] : [])].find((f) => f.place.state === "error");
  if (broken) return { title: `Teams files on ${broken.name} did not load`, line: broken.place.detail, fix: { kind: "retry" } };
  const refused = reads.find((r) => r.failed);
  if (refused) return { title: "Files did not load", line: refused.failed!.words, fix: { kind: "retry" } };
  return null;
}

/**
 * What one place says over its list when it is not simply there: its machine asleep with the list it kept, signed
 * out, still being read, out of reach or failed. `clock` words the time the kept list was read. null: nothing to say.
 */
export function placeNote(copy: PlaceCopy, clock: (at: number) => string): FilesNote | null {
  const { state, detail, at } = copy.place.state;
  const where = copy.place.vm ? "The Windows VM" : copy.host;
  switch (state) {
    case "ok":
      return null;
    case "asleep":
      return { title: `${where} is asleep`, line: at ? `This is the list from ${clock(at)}.` : undefined, fix: { kind: "wake", link: copy.link } };
    case "reading":
      return { title: `Reading ${copy.place.vm ? "the Windows VM" : copy.host}` };
    case "signed-out":
      return { title: `OneDrive on ${copy.place.vm ? "the Windows VM" : copy.host} is signed out`, fix: copy.place.vm ? { kind: "sign-in", link: copy.link } : undefined };
    case "not-set-up":
      return { title: "The Windows VM is not set up", fix: { kind: "settings" } };
    case "not-allowed":
      return { title: "This workspace can't use your computers yet", fix: { kind: "allow", vm: !!copy.place.vm } };
    case "unreachable":
      return { title: `${where} is out of reach`, fix: { kind: "retry" }, away: true };
    case "no-onedrive":
      return { title: `OneDrive is not signed in on ${where}` };
    case "no-libraries":
      return { title: `No Teams files on ${where}`, line: "Sync a channel from Teams with OneDrive there." };
    case "error":
      return { title: `${where} did not answer`, line: detail, fix: { kind: "retry" }, away: true };
  }
}

/** Whether a place's sidebar glyph is greyed: it is down, and says why only when opened. */
export const placeDown = (row: PlaceRow): boolean => !row.copies.some(usable);

// ── tabs and where a page stands ──────────────────────────────────────

/** The tab to show after the list changed: the one shown if it is still open, else the tab it was opened from, else its old neighbour, else the first. */
export function selectedAfter(prev: readonly FileTab[], next: readonly FileTab[], selected: string | null): string | null {
  if (!next.length) return null;
  if (selected && next.some((t) => t.id === selected)) return selected;
  const was = prev.find((t) => t.id === selected);
  if (was?.opener && next.some((t) => t.id === was.opener)) return was.opener;
  const at = prev.findIndex((t) => t.id === selected);
  if (at < 0) return next[0]!.id;
  const after = prev.slice(at + 1).find((t) => next.some((n) => n.id === t.id));
  const before = prev
    .slice(0, at)
    .reverse()
    .find((t) => next.some((n) => n.id === t.id));
  return (after ?? before ?? next[0]!).id;
}

/** A tab's Back and Forward: where it stood before, and where Back came from. */
export interface PageHistory {
  back: FilePage[];
  forward: FilePage[];
}
export const NO_HISTORY: PageHistory = { back: [], forward: [] };
const HISTORY_MOST = 50;
export const wentTo = (h: PageHistory, from: FilePage): PageHistory => ({ back: [...h.back, from].slice(-HISTORY_MOST), forward: [] });
export function wentBack(h: PageHistory, from: FilePage): { history: PageHistory; to: FilePage } | null {
  const to = h.back.at(-1);
  return to ? { history: { back: h.back.slice(0, -1), forward: [from, ...h.forward] }, to } : null;
}
export function wentForward(h: PageHistory, from: FilePage): { history: PageHistory; to: FilePage } | null {
  const to = h.forward[0];
  return to ? { history: { back: [...h.back, from], forward: h.forward.slice(1) }, to } : null;
}

/** The page the place starts on: the workspace's folder (Home takes its place in F4). */
export const startPage = (workspaceName: string): FilePage => ({ at: { at: "place", id: PLACE.folder }, name: workspaceName });

/** A page's key for what the window keeps of it (its sort, its rows' size). */
export const pageKey = (at: FolderRef): string => refKey(at);

/** What a window keeps of one page. */
export interface PageLook {
  sort?: FileSort;
  compact?: boolean;
  /** how the folder is drawn; the list when absent */
  shape?: PageShape;
  /** a grid tile's size */
  tile?: TileSize;
  /** the rows under headings: by kind, by when they changed, or (a lens, a search) by where each lives */
  group?: PageGroup;
  /** the selected file's preview and facts beside the list */
  details?: boolean;
}

/**
 * A folder's shapes (docs/DESIGN.md "The Files place"): the list, tiles, a column a folder, one large preview
 * over a strip of the folder, and the list with the selected file open at its right.
 */
export const PAGE_SHAPES = ["list", "grid", "columns", "gallery", "beside"] as const;
export type PageShape = (typeof PAGE_SHAPES)[number];
export const SHAPE_WORDS: Record<PageShape, string> = { list: "List", grid: "Grid", columns: "Columns", gallery: "Gallery", beside: "Beside" };

export const PAGE_GROUPS = ["kind", "date", "place"] as const;
export type PageGroup = (typeof PAGE_GROUPS)[number];
export const GROUP_WORDS: Record<PageGroup, string> = { kind: "Kind", date: "Date", place: "Place" };

const DAY_MS = 86_400_000;
/** The heading a file's change time falls under, from `now`: today, the last seven days, the last thirty, then its year. */
export function dateGroup(changed: number | undefined, now: number): string {
  if (!changed) return "No date";
  const today = new Date(now).setHours(0, 0, 0, 0);
  if (changed >= today) return "Today";
  if (changed >= today - 7 * DAY_MS) return "Past 7 days";
  if (changed >= today - 30 * DAY_MS) return "Past 30 days";
  return String(new Date(changed).getFullYear());
}

/** One heading and the rows under it. */
export interface EntryGroup {
  title: string;
  entries: FileEntry[];
}

/**
 * A folder's rows under headings. The rows keep the order they came in (the host's sort) inside each group, and
 * the groups stand in the order their first row came, but for kind, where folders lead and the rest follow by
 * the kind's name, so a sort by name does not scatter the headings.
 */
export function groupEntries(entries: readonly FileEntry[], by: PageGroup, now: number): EntryGroup[] {
  const title = (e: FileEntry): string => (by === "kind" ? (e.kind === "folder" ? "Folders" : KIND_GROUP_WORDS[e.kind]) : by === "date" ? dateGroup(e.changed, now) : e.where ? [e.where.name, ...e.where.trail].join(", ") : "Here");
  const groups = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const key = title(entry);
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }
  const all = [...groups].map(([name, list]) => ({ title: name, entries: list }));
  if (by === "kind") all.sort((a, b) => (a.title === "Folders" ? -1 : b.title === "Folders" ? 1 : a.title.localeCompare(b.title)));
  return all;
}

/** A kind's heading: its name for more than one. */
const KIND_GROUP_WORDS: Record<FileEntry["kind"], string> = {
  folder: "Folders",
  document: "Documents",
  sheet: "Sheets",
  deck: "Decks",
  pdf: "PDFs",
  picture: "Pictures",
  video: "Videos",
  audio: "Audio",
  text: "Text",
  archive: "Archives",
  other: "Other files",
};

/** Where each heading stands in the rows laid end to end: the index of a group's first row, and its words. */
export function groupHeads(groups: readonly EntryGroup[]): Map<number, string> {
  const heads = new Map<number, string>();
  let at = 0;
  for (const group of groups) {
    heads.set(at, group.title);
    at += group.entries.length;
  }
  return heads;
}
export const TILE_SIZES = [96, 144, 208] as const;
export type TileSize = (typeof TILE_SIZES)[number];
export const TILE_WORDS: Record<TileSize, string> = { 96: "Small tiles", 144: "Medium tiles", 208: "Large tiles" };
export const DEFAULT_TILE: TileSize = 144;

/** How many tiles of `tile` px fit a row `width` px wide, with `gap` between them; at least one. */
export const tilesAcross = (width: number, tile: number, gap: number): number => Math.max(1, Math.floor((width + gap) / (tile + gap)));

/**
 * Where an arrow key takes the selection in a grid `across` wide: left and right step one, up and down a row,
 * never past either end. From nothing, any arrow lands on the first tile.
 */
export function gridStep(at: number, count: number, across: number, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): number {
  if (count === 0) return -1;
  if (at < 0) return 0;
  const by = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : key === "ArrowUp" ? -across : across;
  const next = at + by;
  // Down from the last full row lands on the last tile; up from the first row stays.
  if (next >= count) return key === "ArrowDown" && Math.floor(at / across) < Math.floor((count - 1) / across) ? count - 1 : at;
  return next < 0 ? at : next;
}

/** One fact for a tile or a column's row: its one state in words, else when it changed. */
export function factOf(entry: Pick<FileEntry, "state" | "changed" | "kind">, when: (at: number) => string): string {
  const state = entry.state;
  if (state?.is === "cloud") return "In the cloud";
  if (state?.is === "suggestions") return state.count === 1 ? "1 suggestion" : `${state.count} suggestions`;
  if (state?.is === "present") return `${state.who} is in it`;
  if (state?.is === "writing") return "A thread is writing";
  return entry.changed ? when(entry.changed) : "";
}

// ── what is selected ──────────────────────────────────────────────────

/**
 * A page's selection (docs/DESIGN.md "The Files place"): a click selects one, ⌘ adds or takes one, Shift takes
 * the run from where the last plain pick stood, ⌘A takes all. `cursor` is the row the arrow keys stand on;
 * `anchor` is where a Shift run starts.
 */
export interface Picked {
  keys: ReadonlySet<string>;
  cursor: string | null;
  anchor: string | null;
}
export const NOTHING_PICKED: Picked = { keys: new Set(), cursor: null, anchor: null };

export type PickHow = "one" | "toggle" | "range";

/** The selection after a press on `key`, among the rows in the order they are drawn. */
export function pick(now: Picked, order: readonly string[], key: string, how: PickHow): Picked {
  if (how === "toggle") {
    const keys = new Set(now.keys);
    if (!keys.delete(key)) keys.add(key);
    return { keys, cursor: key, anchor: key };
  }
  if (how === "range" && now.anchor !== null) {
    const a = order.indexOf(now.anchor);
    const b = order.indexOf(key);
    if (a >= 0 && b >= 0) return { keys: new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1)), cursor: key, anchor: now.anchor };
  }
  return { keys: new Set([key]), cursor: key, anchor: key };
}

/** Everything in the folder. */
export const pickAll = (order: readonly string[]): Picked => (order.length ? { keys: new Set(order), cursor: order[order.length - 1]!, anchor: order[0]! } : NOTHING_PICKED);

/** A selection held to the rows that are still there (a row deleted, a folder listed again). */
export function pickedAmong(now: Picked, order: readonly string[]): Picked {
  if (!now.keys.size) return now;
  const here = new Set(order);
  const keys = new Set([...now.keys].filter((k) => here.has(k)));
  if (keys.size === now.keys.size) return now;
  return { keys, cursor: now.cursor !== null && here.has(now.cursor) ? now.cursor : null, anchor: now.anchor !== null && here.has(now.anchor) ? now.anchor : null };
}

// ── a file's and a folder's menu ──────────────────────────────────────

/** What a row's menu, the bulk bar and the keys can ask. */
export type EntryAct = "open" | "open-tab" | "open-side" | "reveal" | "keep" | "project-out" | "open-app" | "rename" | "move" | "copy" | "star" | "unstar" | "delete" | "restore" | "purge";

export interface ActRow {
  act: EntryAct;
  label: string;
  /** why it cannot be done here, in one sentence: the row is drawn off, with this as its reason */
  refused?: string;
  danger?: boolean;
  /** a rule is drawn above it */
  rule?: boolean;
}

/**
 * The verbs for what is selected, in menu order, each off with its one sentence where the place refuses it
 * (`refusal`, the same rule the host holds). The same rows serve one thing or many: a verb that only one thing
 * takes (Open, Rename) is left out for many. In Trash the verbs are Put back and Delete for good.
 */
export function actsFor(
  entries: readonly FileEntry[],
  place: FilePlace | null,
  o: { tabs: boolean; /** a file tab he was last in can take a file at its side */ side?: boolean; /** the page can show the folder a row lives in (a lens, a search's results) */ reveal?: boolean; /** the sector has projects a file can be added to */ projects?: boolean } = { tabs: true },
): ActRow[] {
  if (!entries.length) return [];
  const one = entries.length === 1 ? entries[0]! : null;
  // A mail's file is no file of his yet: it opens, and Keep copies it into the workspace's folder.
  if (place?.kind === "mail") return [...(one ? ([{ act: "open", label: "Open" }] satisfies ActRow[]) : []), { act: "keep", label: "Keep in the Workspace", rule: !!one }];
  if (place?.kind === "trash") {
    return [
      { act: "restore", label: "Put Back" },
      { act: "purge", label: "Delete for Good", danger: true, rule: true },
    ];
  }
  const no = (verb: FileVerb, entry?: FileEntry): string | undefined => (place ? (refusal(place, verb, entry ?? one) ?? undefined)?.text : "Its place is not listed now.");
  const each = (verb: FileVerb): string | undefined => entries.map((e) => no(verb, e)).find((text) => text !== undefined);
  const rows: ActRow[] = [];
  if (one) {
    rows.push({ act: "open", label: "Open" });
    if (one.folder && o.tabs) rows.push({ act: "open-tab", label: "Open in New Tab" });
    if (!one.folder && o.side) rows.push({ act: "open-side", label: "Open to the Side" });
    if (o.reveal && one.where) rows.push({ act: "reveal", label: "Show in Its Folder" });
    if (!one.folder && place && LIBRARY.includes(place.kind)) rows.push({ act: "open-app", label: appVerb(one) });
    rows.push({ act: "rename", label: "Rename", refused: no("rename"), rule: true });
  }
  rows.push({ act: "move", label: "Move to…", refused: each("move"), rule: !one });
  rows.push({ act: "copy", label: "Copy to…", refused: each("copy") });
  // His marks are kept where the workspace lives: a host a release behind keeps none.
  if (o.tabs) {
    const starred = entries.every((e) => e.starred);
    rows.push({ act: starred ? "unstar" : "star", label: starred ? "Remove Star" : "Star", rule: true });
  }
  // A file in a project can leave it; adding it to one is a list of the projects, which the page draws under this row's place.
  if (one && !one.folder && o.projects && one.project) rows.push({ act: "project-out", label: `Take Out of ${one.project.name}` });
  rows.push({ act: "delete", label: "Delete", refused: each("trash"), danger: true, rule: true });
  return rows;
}

/** What a delete said, for its one toast: "Deleted Budget.xlsx", "Deleted 3 things". */
export function doneWords(verb: "Deleted" | "Moved" | "Copied" | "Put back", names: readonly string[], to?: string): string {
  const what = names.length === 1 ? names[0]! : `${names.length} things`;
  return to ? `${verb} ${what} to ${to}` : `${verb} ${what}`;
}

/** What could not be done of a bulk act, file by file: the first sentence, and how many more. */
export function refusedWords(refused: readonly { name: string; text: string }[]): string | null {
  if (!refused.length) return null;
  const first = `${refused[0]!.name}: ${refused[0]!.text}`;
  return refused.length === 1 ? first : `${first} (and ${refused.length - 1} more)`;
}

/** A name while it is being typed in place: the part before its extension is what a rename starts with selected. */
export const stemEnd = (name: string): number => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
};

/** Where a lens's row lives, in words: the place and the folders down to it ("Dummy Esports › Events"). */
export const whereWords = (where: NonNullable<FileEntry["where"]>): string => [where.name, ...where.trail].join(" › ");
// ── the chat docked beside a file ─────────────────────────────────────

/**
 * The chat docked at the right of a file tab (docs/DESIGN.md "The Files place"): 360px to start, never narrower
 * (the chat's floor beside anything), never wider than 720px or than leaves the file 560px. Where the tab's body
 * cannot hold both, the chat lies over the whole body instead, its close control still at its head.
 */
export const DOCK = { width: 360, min: 360, max: 720, file: 560 } as const;
/** Under this much view the sidebar folds itself away while a dock is open, and comes back when it closes. */
export const DOCK_FOLD_AT = 900;

/** The widest the dock may be in a body of `body` px (unmeasured, 0: the bound alone). */
export const dockMost = (body = 0): number => (body > 0 ? Math.max(DOCK.min, Math.min(DOCK.max, body - DOCK.file)) : DOCK.max);

/** A dragged or kept width, held to the dock's bounds and to what the body leaves. */
export function clampDock(width: number, body = 0): number {
  return Math.round(Math.max(DOCK.min, Math.min(dockMost(body), Number.isFinite(width) ? width : DOCK.width)));
}

/** How the dock sits in a tab's body of `body` px: beside the file at its width, or over it where the file would get under 560px. */
export function dockShape(body: number, width: number): { over: true } | { over: false; width: number } {
  if (body > 0 && body - DOCK.min < DOCK.file) return { over: true };
  return { over: false, width: clampDock(width, body) };
}

/** Whether the sidebar folds itself away: under 640px of view always, under 900px while the shown tab's chat is docked. */
export const sidebarFolds = (view: number, docked: boolean, foldAt: number): boolean => view > 0 && (view < foldAt || (docked && view < DOCK_FOLD_AT));

// ── Home and search pages ─────────────────────────────────────────────

export const HOME_PAGE: FilePage = { at: { at: "place", id: PLACE.home }, name: "Home" };
export const isHomePage = (at: FolderRef): boolean => at.at === "place" && at.id === PLACE.home;

/** A page of search results: his words searched in every place (`search`), or a saved search's own page (`search:<id>`). */
export const SEARCH_ID = "search";
export const searchPage = (query: string): FilePage => ({ at: { at: "place", id: SEARCH_ID }, name: `Search: ${query}`, query });
export const savedSearchPage = (search: { id: string; name: string; query: string }): FilePage => ({ at: { at: "place", id: `${SEARCH_ID}:${search.id}` }, name: search.name, query: search.query });
export const isSearchPage = (at: FolderRef): boolean => at.at === "place" && (at.id === SEARCH_ID || at.id.startsWith(`${SEARCH_ID}:`));
/** The saved search a page stands on; null for a search he has not saved. */
export const savedIdOf = (at: FolderRef): string | null => (at.at === "place" && at.id.startsWith(`${SEARCH_ID}:`) ? at.id.slice(SEARCH_ID.length + 1) : null);
