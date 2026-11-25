import type { FileCrumb, FilePage, FileSearchFilter, FilesPlaces, FileTab } from "@shared/contract-work-files";
import { clampDock as clampDockIn, DOCK_SIZE, dockMost as dockMostIn, dockShape as dockShapeIn, sidebarFolds as sidebarFoldsIn } from "../dock/shapes";
import { canvasSourcePath, type CanvasSource } from "@shared/work/canvas";
import type { TeamsEntry, TeamsLibrariesAnswer, TeamsPlace } from "@shared/contract-work-office";
import { kindOfEntry, PLACE, refKey, refusal, type FileEntry, type FilePlace, type FileSort, type FileVerb, type FolderRef, type PlaceKind, type Refusal } from "@shared/work/files";
import { placesIn, type LibraryPlace } from "@shared/work/filePlaces";
import { passesFilter } from "@shared/work/fileSearch";

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
 * The tab a file's folder line goes back to: the tab it was opened from while that tab still shows the folder, else
 * any tab that shows it; null where none does (the line then opens one beside it), so the row never fills with copies.
 */
export function tabShowing<T extends { id: string; kind: string; page?: { at: FolderRef } }>(tabs: readonly T[], at: FolderRef, opener?: string): T | null {
  const shows = (t: T): boolean => t.kind === "page" && !!t.page && samePage(t.page.at, at);
  return tabs.find((t) => t.id === opener && shows(t)) ?? tabs.find(shows) ?? null;
}

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
 * as a copy he allowed); `app` in its own app where it lies: an old Office form or a sound in a library, which has
 * its app behind it and no viewer here, any file where no copy is allowed, and every file of a workspace whose host
 * is a release behind and keeps no tabs (opening a file never makes a thread he did not ask for). In a tab every
 * file opens (`seatOf`): what has no viewer of its own shows its facts.
 */
export type OpenWay = "tab" | "app";

export function openWay(entry: Pick<FileEntry, "name" | "kind"> & { ref?: FileEntry["ref"] }, copy: Pick<PlaceCopy, "link" | "place" | "wire">, workspace: { link: string; tabs: boolean; copy: boolean }): OpenWay {
  // A row a pillar lists in a folder that is no file there (a Microsoft form) is seated by that pillar in its tab: no
  // app on the folder's computer opens it, and asking one answered "A Teams file is named by its path on its host."
  if (entry.ref && entry.ref.at !== "file") return "tab";
  if (!workspace.tabs) return "app";
  const what = kindOfEntry(entry.name);
  const library = LIBRARY.includes(copy.place.kind);
  const here = copy.link === workspace.link && !copy.place.vm;
  const office = library && here && isOffice(entry.name);
  if (library && !office && (what.canvas === null || what.kind === "audio")) return "app";
  if (!here && !workspace.copy) return "app";
  return "tab";
}
/** Whether an open file can sit at another's side: one on a disk can; a LifeOS or Drive file opens in a tab of its own. */
export const sitsAtSide = (source: CanvasSource): boolean => canvasSourcePath(source) !== null;

const isOffice = (name: string): boolean => /\.(xlsx|xlsm|xlsb|xls|docx|docm|doc|rtf|odt|pptx|pptm|ppt|odp)$/i.test(name);

/**
 * Whether this window can open a place's file in its own app: only a library's file has one, and only where the
 * window links to that computer itself (one reached through another host, a PC only the box reaches, carries no
 * open) and that computer is a Mac or a Windows PC, or the Windows VM. A platform not known yet is not held against it.
 */
export function appOpens(copy: Pick<PlaceCopy, "place">, computer: { far: boolean; platform?: string }): boolean {
  if (!LIBRARY.includes(copy.place.kind) || computer.far) return false;
  return copy.place.vm === true || computer.platform === undefined || computer.platform === "darwin" || computer.platform === "win32";
}

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
  /** a stage under way (the Windows VM waking): a spinner leads the words, and there is nothing to press */
  busy?: true;
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

/**
 * What a folder in the Windows VM says while the VM sleeps, from the listing's own answer (truer than the place's,
 * which was read before): waking, with the list kept if there is one; asleep, with Wake it; or a wake he saw under way
 * that ended asleep. null: the folder is not asleep.
 */
export function vmSleepNote(copy: PlaceCopy, listing: { sleeping?: "asleep" | "waking"; unwoken?: boolean; asOf?: number }, clock: (at: number) => string): FilesNote | null {
  if (!copy.place.vm || !listing.sleeping) return null;
  const line = listing.asOf ? `This is the list from ${clock(listing.asOf)}.` : undefined;
  if (listing.sleeping === "waking") return { title: "Waking the Windows VM", ...(line ? { line } : {}), busy: true };
  return { title: listing.unwoken ? "The Windows VM did not wake" : "The Windows VM is asleep", ...(line ? { line } : {}), fix: { kind: "wake", link: copy.link } };
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
  const title = (e: FileEntry): string => (by === "kind" ? (e.kind === "folder" ? "Folders" : KIND_GROUP_WORDS[e.kind]) : by === "date" ? dateGroup(e.changed, now) : e.where ? whereWords(e.where) : "Here");
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
  form: "Microsoft forms",
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

const besideDays = new Map<string, Intl.DateTimeFormat>();
/**
 * When, on a Beside row's second line: the clock today, else the day alone ("Fri", "Nov 18"), since a row 280px wide
 * has no room for a clock time it does not need. `now` and `locale` for a test.
 */
export function dayWords(ts: number, now = Date.now(), locale?: string): string {
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0);
  const ago = Math.round((day(now) - day(ts)) / 86_400_000);
  if (ago === 0) return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(ts);
  const near = ago > 0 && ago < 7;
  const key = `${locale ?? ""}:${near}`;
  let fmt = besideDays.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, near ? { weekday: "short" } : { month: "short", day: "numeric" });
    besideDays.set(key, fmt);
  }
  return fmt.format(ts);
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
export type EntryAct = "open" | "quick-look" | "open-form" | "open-tab" | "open-side" | "reveal" | "keep" | "project-out" | "open-app" | "share" | "download" | "rename" | "move" | "copy" | "star" | "unstar" | "delete" | "restore" | "purge";

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
 * takes (Open, Rename) is left out for many. In Trash the verbs are Put back and Delete for good, each left out
 * where this window's key may not (`restore`, `purge` false).
 */
export function actsFor(
  entries: readonly FileEntry[],
  place: FilePlace | null,
  o: { tabs: boolean; /** a file tab he was last in can take a file at its side */ side?: boolean; /** the page can show the folder a row lives in (a lens, a search's results) */ reveal?: boolean; /** the sector has projects a file can be added to */ projects?: boolean; /** Put Back may be offered */ restore?: boolean; /** Delete for Good may be offered */ purge?: boolean; /** false: the place's computer cannot open the file in its app for this window (`appOpens`) */ app?: boolean; /** the place's computer is reached only through another host (`farWhy`): a refused verb says so */ far?: { computer: string; via: string }; /** Share… may be offered for a document or a sheet (its sheet says what to do where no link can be made) */ share?: boolean; /** Quick Look may be offered (a page's row, not a tab's ⋯) */ look?: boolean; /** the place's files may be downloaded to this window (`placeDownloads`) */ download?: boolean; /** a place others open: Share… is "Share in Teams" (or OneDrive), its file's own page, greyed with its sentence where the host knows none (decision 9) */ shareIn?: { home: string; refused?: string } } = { tabs: true },
): ActRow[] {
  if (!entries.length) return [];
  const one = entries.length === 1 ? entries[0]! : null;
  // A mail's file is no file of his yet: it opens, and Keep copies it into the workspace's folder.
  if (place?.kind === "mail") return [...(one ? ([{ act: "open", label: "Open" }] satisfies ActRow[]) : []), { act: "keep", label: "Save to Workspace", rule: !!one }];
  if (place?.kind === "trash") {
    const rows: ActRow[] = [];
    if (o.restore !== false) rows.push({ act: "restore", label: "Put Back" });
    if (o.purge !== false) rows.push({ act: "purge", label: "Delete for Good", danger: true, rule: rows.length > 0 });
    return rows;
  }
  const no = (verb: FileVerb, entry?: FileEntry): string | undefined => {
    const why = place ? (refusal(place, verb, entry ?? one) ?? undefined)?.text : "Its place is not listed now.";
    // The rule is the place's; on a computer reached through another host the true reason is that road, said in his words.
    return why && o.far ? farWhy(o.far) : why;
  };
  const each = (verb: FileVerb): string | undefined => entries.map((e) => no(verb, e)).find((text) => text !== undefined);
  // A Microsoft form listed in its folder is no file: it opens, and nothing else is done to it here.
  if (entries.some((e) => e.kind === "form")) return one ? [{ act: "open", label: "Open" }] : [];
  const rows: ActRow[] = [];
  // Download takes files alone, each read to this window by the route a tab's own file takes; a folder has none.
  const downloads = !!o.download && entries.every((e) => fileDownloads(e, place));
  if (one) {
    rows.push({ act: "open", label: "Open" });
    if (o.look) rows.push({ act: "quick-look", label: "Quick Look" });
    // A form's answers workbook opens the form too.
    if (one.answersTo) rows.push({ act: "open-form", label: "Open the Form" });
    if (one.folder && o.tabs) rows.push({ act: "open-tab", label: "Open in New Tab" });
    // Only a file on a disk can sit at a tab's side today: a LifeOS document or a Drive file opens in a tab of its own.
    if (!one.folder && o.side && one.ref?.at === "file") rows.push({ act: "open-side", label: "Open to the Side" });
    if (o.reveal && one.where) rows.push({ act: "reveal", label: "Show in Its Folder" });
    if (!one.folder && place && LIBRARY.includes(place.kind) && o.app !== false) rows.push({ act: "open-app", label: appVerb(one) });
    // A document's or a sheet's Share sheet: a link where one can be made, else the line that says how to share it.
    // In a place others open no guest link is made: the file is shared from its own page, a deck's too.
    const shares = o.shareIn ? !one.folder && (one.kind === "document" || one.kind === "sheet" || one.kind === "deck") : !!o.share && !one.folder && (one.kind === "document" || one.kind === "sheet");
    if (shares) rows.push(o.shareIn ? { act: "share", label: `Share in ${o.shareIn.home}`, rule: true, ...(o.shareIn.refused ? { refused: o.shareIn.refused } : {}) } : { act: "share", label: "Share…", rule: true });
    if (downloads) rows.push({ act: "download", label: "Download", rule: !shares });
    rows.push({ act: "rename", label: "Rename", refused: no("rename"), rule: !shares && !downloads });
  }
  if (!one && downloads) rows.push({ act: "download", label: "Download" });
  rows.push({ act: "move", label: "Move to…", refused: each("move"), rule: !one && !downloads });
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

/** The places whose files a window may be given: a disk's folders and libraries, never a lens, LifeOS, Drive or a mail. */
const READS_BYTES: readonly PlaceKind[] = ["folder", ...LIBRARY];

/**
 * Whether a page's files may be downloaded to this window, by the route a tab's own file takes (`work.files.read`;
 * docs/agents/work-files.md "Download"): the host gives a file in a place others open, or in the VM, to the window of
 * the computer that holds it alone (files/handle.ts `bytesFence`), and nothing to a computer reached through another
 * host. A press that could only be refused is not offered.
 */
export function placeDownloads(place: FilePlace, o: { /** the place's host is this window's own computer */ here: boolean; far?: unknown }): boolean {
  if (!READS_BYTES.includes(place.kind) || o.far || place.root.at !== "file") return false;
  return o.here || (!place.shared && !place.vm);
}

/** A row Download takes, in a place `placeDownloads` lets: a file on its disk, not a form, nor one the VM keeps in the cloud (reading it would fetch it). */
const fileDownloads = (entry: FileEntry, place: FilePlace | null): boolean =>
  !entry.folder && entry.ref?.at === "file" && entry.kind !== "form" && !(place?.vm && (entry.local === false || entry.state?.is === "cloud"));

/** How readily a tab gives up width past what fits: one rule for Files' row and the canvas tab row (canvas/tabShrink.ts). */
export { tabEnds, tabMin, tabShrink } from "../canvas/tabShrink";

/** Why a verb is greyed for a file on a computer this window reaches only through another host: where it can be done. */
export const farWhy = (far: { computer: string; via: string }): string => `${far.computer} is reached through ${far.via}. Change its files on ${far.computer} itself.`;

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

/** The ending of TempCode's own formats, which no one but TempCode reads: the kind's glyph says what the file is. */
const OWN_ENDING = /\.tc(doc|sheet)$/i;
/** A file's name as he reads it: ".tcsheet" and ".tcdoc" are never shown as words. */
export const shownName = (name: string): string => name.replace(OWN_ENDING, "");
/** The ending a rename keeps without showing it: ".tcsheet" or ".tcdoc", else none. */
export const hiddenEnding = (name: string): string => OWN_ENDING.exec(name)?.[0] ?? "";

/** A name while it is being typed in place: the part before its extension is what a rename starts with selected. */
export const stemEnd = (name: string): number => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
};

/** The extension a typed name ends in: a dot and up to eight letters or digits, one a letter, after it; "v1.2", "11.25" or "Dr. Lee" are words, not one. */
export const typedEnding = (name: string): string => {
  const end = /.\.([A-Za-z0-9]{1,8})$/.exec(name);
  return end && /[A-Za-z]/.test(end[1]) ? `.${end[1]}` : "";
};

/** A folder its host says is gone ("That folder is not there any more."), as against one that did not load: Retry cannot bring it back. */
export const folderGone = (error: string | null | undefined): boolean => !!error && / is not there any more\b/.test(error);

/** A read the place refused (he may not read it there): Retry would only be refused again. */
export const readRefused = (error: string | null | undefined): boolean => !!error && /\bmay not\b|\bnot allowed\b|\bpermission denied\b|\bdoes not let\b/i.test(error);

/** Home's three lists with each file once, in the first it belongs to: what waits on him, then his stars, then what he opened last. */
export function homeLists<T extends Pick<FileEntry, "key"> & Partial<Pick<FileEntry, "name" | "ref" | "where">>>(home: { waiting: readonly T[]; starred: readonly T[]; recent: readonly T[] }): { waiting: T[]; starred: T[]; recent: T[] } {
  const seen = new Set<string>();
  // One file goes by more than one key (a library's file starred by its library and opened by a computer's path): it is
  // one row by any of its key, where it lies, or its place and folders by name.
  const names = (e: T): string[] => [e.key, ...(e.ref ? [`ref:${refKey(e.ref)}`] : []), ...(e.where && e.name ? [`where:${[e.where.name, ...e.where.trail, e.name].join("\u0000")}`] : [])];
  const once = (list: readonly T[]): T[] =>
    list.filter((e) => {
      const its = names(e);
      if (its.some((n) => seen.has(n))) return false;
      its.forEach((n) => seen.add(n));
      return true;
    });
  return { waiting: once(home.waiting), starred: once(home.starred), recent: once(home.recent) };
}

const andList = (names: readonly string[]): string => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * What a search left out, as one note over its results: places whose machine sleeps, desktops whose folders were
 * not searched (none of the window's links reaches them, or theirs is down), or a search that stopped before it
 * looked everywhere. Retry only where asking again could help. Null when it read every place. Places searched by name
 * alone are said beside a place left out, or alone only when nothing was found (`hits` false): over hits they change
 * nothing he sees, and would sit over nearly every search.
 */
export function searchGap(found: { incomplete?: boolean; asleep?: readonly string[]; unsearched?: readonly string[]; byName?: readonly string[] }, hits = false): FilesNote | null {
  const asleep = found.asleep ?? [];
  const desks = found.unsearched ?? [];
  // A place with no content index here (a library on this disk or in the VM) was searched by its files' names alone.
  const named = found.byName ?? [];
  // A place, or a kind of file ("TempCode documents and sheets"): the list follows the words, so either reads.
  const byName = named.length ? `Searched by name only: ${andList(named)}` : null;
  if (asleep.length) {
    const its = asleep.length === 1 ? "Its" : "Their";
    return { title: `${andList(asleep)} ${asleep.length === 1 ? "is" : "are"} asleep`, line: desks.length ? `${its} files and folders on ${andList(desks)} were not searched.` : found.incomplete ? "Not every place was searched." : `${its} files were not searched.`, fix: { kind: "retry" } };
  }
  if (desks.length) return { title: `Folders on ${andList(desks)} were not searched`, ...(byName ? { line: `${byName}.` } : {}), ...(found.incomplete ? { fix: { kind: "retry" as const } } : {}) };
  if (found.incomplete) return { title: "Not every place was searched", ...(byName ? { line: `${byName}.` } : {}), fix: { kind: "retry" } };
  return byName && !hits ? { title: byName } : null;
}

// ── a desktop's own search ────────────────────────────────────────────

/**
 * Whether his desktops' own search can join a search of every place under this filter: their rows say a file's
 * kind, change time and that others can open it, never who changed it, a project or a review, and the place
 * choices are the workspace host's alone.
 */
export const desksJoin = (filter: FileSearchFilter): boolean => !filter.places?.length && !filter.project && !filter.who && !filter.review;

/** The copy of a library on `link` that a path of that desktop lies in, as the sidebar lists it now. */
export function deskPlace(sidebar: Sidebar, link: string, path: string): PlaceCopy | null {
  const mine = sidebar.rows.flatMap((row) => row.copies).find((c) => c.link === link && c.place.root.at === "file");
  if (mine?.place.root.at !== "file") return null;
  return placeOfRef(sidebar, { at: "file", host: mine.place.root.host, path })?.row?.copies.find((c) => c.link === link) ?? null;
}

/**
 * What a desktop's own search found (`work.office.filesSearch`), as Files rows: each keyed as its library keys it
 * (so a file the host found too is one row), saying where it lies, held to the filter. A hit in no place listed now
 * cannot open, and is left out.
 */
export function deskRows(found: readonly TeamsEntry[], placeOf: (path: string) => PlaceCopy | null, filter: FileSearchFilter): FileEntry[] {
  return found.flatMap((hit) => {
    const copy = placeOf(hit.path);
    if (copy?.place.root.at !== "file") return [];
    const host = copy.place.root.host;
    const entry = entryFromOld(hit, copy.place, host);
    const parent = { at: "file" as const, host, path: hit.path.replace(/[\\/]+[^\\/]*$/, "") };
    const where = { place: copy.place.id, name: copy.place.name, trail: trailFromOld(copy.place, parent).slice(1).map((c) => c.name) };
    return passesFilter(entry, copy.place.id, filter, null) ? [{ ...entry, where }] : [];
  });
}

export const newestFirst = (a: FileEntry, b: FileEntry): number => (b.changed ?? 0) - (a.changed ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** A search's rows with more joined: one row a file whichever side found it (the first said wins), in the search's own order, newest change first. */
export function mergeFound(rows: readonly FileEntry[], more: readonly FileEntry[]): FileEntry[] {
  const keys = new Set(rows.map((e) => e.key));
  return [...rows, ...more.filter((e) => !keys.has(e.key))].sort(newestFirst);
}

/**
 * Rows that came in a later part of a search, joined so that nothing already shown moves: each row shown keeps its
 * place (as the newer answer says it, the same object while it says the same), and the new ones follow it, in their
 * own order.
 */
export function mergeBelow(shown: readonly FileEntry[], fresh: readonly FileEntry[]): FileEntry[] {
  const now = new Map(fresh.map((e) => [e.key, e]));
  const kept = shown.map((e) => {
    const next = now.get(e.key);
    return next && JSON.stringify(next) !== JSON.stringify(e) ? next : e;
  });
  const have = new Set(shown.map((e) => e.key));
  return [...kept, ...fresh.filter((e) => !have.has(e.key))];
}

/** What a search still waits on, said over its rows: the places by name, with the stage's spinner and nothing to press. */
export function searchingNote(places: readonly string[]): FilesNote | null {
  return places.length ? { title: `Searching ${andList([...new Set(places)])}`, busy: true } : null;
}

/** Where a lens's row lives, in words: the place and the folders down to it ("Dummy Esports › Events"). */
export const whereWords = (where: NonNullable<FileEntry["where"]>): string => [where.name, ...where.trail].join(" › ");
/** Where `whereWords` keeps its end when cut: the folder the file lies in, from its "›", stays; the place and the folders above it give way first. */
export const whereKeep = (where: NonNullable<FileEntry["where"]>): number | null => (where.trail.length ? whereWords(where).length - where.trail[where.trail.length - 1]!.length - 2 : null);
// ── the chat docked beside a file ─────────────────────────────────────

/**
 * The chat docked at the right of a file tab (docs/DESIGN.md "The Files place"): the shared dock's sizes
 * (work/dock/shapes.ts), never leaving the file under 440px. Where the tab's body cannot hold both, the chat lies
 * over the whole body instead, its close control still at its head. 440, not the 560 it began as: a 1280px window
 * with the rail and the workspace's column open leaves a tab 820px, and at 560 Ask covered the very file he was
 * asking about; at 440 the file stays in view beside a 360px chat there.
 */
export const DOCK = { ...DOCK_SIZE, file: 440 } as const;
/** The sidebar's width beside the tabs (FilesView's `data-files-sidebar`). */
export const SIDEBAR_WIDTH = 200;
/** Whether the sidebar folds itself away in a view `view` px wide: under `foldAt` always, and while the shown tab's chat
 *  is docked wherever the open sidebar would put the chat over the file (decision 12: Files folds its own sidebar first). */
export const sidebarFolds = (view: number, docked: boolean, foldAt: number): boolean => sidebarFoldsIn(view, docked, foldAt, SIDEBAR_WIDTH, DOCK.file);

/** The widest the dock may be in a body of `body` px (unmeasured, 0: the bound alone). */
export const dockMost = (body = 0): number => dockMostIn(body, DOCK.file);

/** A dragged or kept width, held to the dock's bounds and to what the body leaves. */
export const clampDock = (width: number, body = 0): number => clampDockIn(width, body, DOCK.file);

/** How the dock sits in a tab's body of `body` px: beside the file at its width, or over it where the file would get under 440px. */
export const dockShape = (body: number, width: number): { over: true } | { over: false; width: number } => dockShapeIn(body, width, DOCK.file);

// ── Home and search pages ─────────────────────────────────────────────

export const HOME_PAGE: FilePage = { at: { at: "place", id: PLACE.home }, name: "Home" };
export const isHomePage = (at: FolderRef): boolean => at.at === "place" && at.id === PLACE.home;

/** A page of search results: his words searched in every place (`search`), or a saved search's own page (`search:<id>`). */
export const SEARCH_ID = "search";
export const searchPage = (query: string): FilePage => ({ at: { at: "place", id: SEARCH_ID }, name: `Results for “${query}”`, query });
export const savedSearchPage = (search: { id: string; name: string; query: string }): FilePage => ({ at: { at: "place", id: `${SEARCH_ID}:${search.id}` }, name: search.name, query: search.query });
export const isSearchPage = (at: FolderRef): boolean => at.at === "place" && (at.id === SEARCH_ID || at.id.startsWith(`${SEARCH_ID}:`));
/** The saved search a page stands on; null for a search he has not saved. */
export const savedIdOf = (at: FolderRef): string | null => (at.at === "place" && at.id.startsWith(`${SEARCH_ID}:`) ? at.id.slice(SEARCH_ID.length + 1) : null);

/**
 * Move to… and Copy to…'s refusal in this window: the grammar's (`refusal`), then a folder on another computer than
 * the things are on. The things' own host carries them on its own disk, so it cannot put them on another computer's
 * yet (docs/agents/work-files.md "Moves and copies"): that folder is no target, and nothing is sent.
 */
export function carryRefusal(from: FilePlace, verb: "move" | "copy", entry: FileEntry | null | undefined, to: FilePlace): Refusal | null {
  return refusal(from, verb, entry, to) ?? (from.env !== to.env ? { text: `${verb === "move" ? "Move" : "Copy"} between computers is not available yet.` } : null);
}

/** A form's answers workbook, as its row says it: "Answers to Spring sign-up". */
export const answersWords = (answersTo: NonNullable<FileEntry["answersTo"]>): string => `Answers to ${answersTo.title}`;

/** The form a workbook's row names, as a row of its own to open. */
export const formEntryOf = (answersTo: NonNullable<FileEntry["answersTo"]>): FileEntry => ({ key: refKey(answersTo.ref), ref: answersTo.ref, folder: null, name: answersTo.title, kind: "form" });
