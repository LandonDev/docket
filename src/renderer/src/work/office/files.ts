import { teamsAppOf, teamsCanvasOf, teamsPlaceKey, type TeamsEntry, type TeamsLibrariesAnswer, type TeamsLibrary, type TeamsPlace } from "@shared/contract-work-office";

/**
 * The Files view's own rules (docs/agents/work-files.md "The Files view"), kept apart from the
 * screen so they are tested alone: how the libraries read as teams and channels, the crumbs over a
 * folder, a file's place in a search, and where a file opens.
 */

/** A library as the window holds it: with the link (`env`) it was read from, which for this machine is not the host's own id. */
export type ShownLibrary = TeamsLibrary & { env: string };

/** One copy of a place: the library it lies in on one machine, and the folder that is the place's top there. */
export interface PlaceCopy {
  library: ShownLibrary;
  folder: string;
}

/**
 * A row of the Files view: one place (a channel, a library, his own files, a folder he added), once however many
 * machines hold it (`teamsPlaceKey`), with its copies in the order they are read.
 */
export interface PlaceRow {
  key: string;
  label: string;
  /** the team or site it is under; "" for his own files and folders he added */
  team: string;
  copies: PlaceCopy[];
}
export interface PlaceGroup {
  name: string;
  rows: PlaceRow[];
}

const join = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, "")}${dir.includes("\\") && !dir.includes("/") ? "\\" : "/"}${name}`;

/** The places one library holds: a team's channels (a team's Documents' top folders), else the library as one place. */
function placesOf(library: ShownLibrary): (Omit<PlaceRow, "copies"> & { folder: string })[] {
  if (library.kind === "mine") return [{ key: "mine", label: "My files", team: "", folder: library.path }];
  if (library.kind === "folder") return [{ key: `folder:${library.id}`, label: library.library ? `${library.team} ${library.library}` : library.team, team: "", folder: library.path }];
  if (library.kind === "channels" && library.channels.length)
    return library.channels.map((channel) => ({ key: teamsPlaceKey(library.team, channel), label: channel, team: library.team, folder: join(library.path, channel) }));
  // A team's Documents is named so; a library OneDrive named only as one word (its newer layout on a Mac) keeps that name.
  return [{ key: teamsPlaceKey(library.team, library.library ?? ""), label: library.library ?? (library.kind === "channels" ? "Documents" : library.team), team: library.team, folder: library.path }];
}

/**
 * The rows, grouped by team, his own files and folders he added last. A place two machines hold is one row: its copy on
 * the workspace's own host first while its place answers (a VM library there needs no Mac), then a desktop's, then the
 * rest. A merged row takes its name and team from a copy that names them apart (a team's library under Windows:
 * "RecWell", "Team RecWell"), so a Mac's one-word folders read as that team's.
 */
export function placeGroups(libraries: readonly ShownLibrary[], workspaceEnv: string, placeOk: (library: ShownLibrary) => boolean = () => true): PlaceGroup[] {
  const rank = (l: ShownLibrary): number => (l.env === workspaceEnv ? (placeOk(l) ? 0 : 2) : 1);
  const byKey = new Map<string, { named: Omit<PlaceRow, "copies">[]; copies: (PlaceCopy & { order: number })[] }>();
  let order = 0;
  for (const library of libraries)
    for (const place of placesOf(library)) {
      const row = byKey.get(place.key) ?? { named: [], copies: [] };
      if (library.kind === "channels") row.named.unshift(place);
      else row.named.push(place);
      row.copies.push({ library, folder: place.folder, order: order++ });
      byKey.set(place.key, row);
    }
  const groups = new Map<string, PlaceRow[]>();
  for (const [key, { named, copies }] of byKey) {
    const { label, team } = named[0]!;
    const sorted = copies.sort((a, b) => rank(a.library) - rank(b.library) || a.order - b.order).map(({ library, folder }) => ({ library, folder }));
    groups.set(team, [...(groups.get(team) ?? []), { key, label, team, copies: sorted }]);
  }
  return [...groups]
    .map(([name, rows]) => ({ name, rows }))
    .sort((a, b) => (a.name === "" ? 1 : b.name === "" ? -1 : a.name.localeCompare(b.name)));
}

/** A group's heading is drawn unless its one row already says it (a library known by one name). */
export const showsHeading = (group: PlaceGroup): boolean => group.name !== "" && group.rows.some((row) => row.label !== group.name);

/** The parts of a path below a folder: the same folder in another copy of the place has the same parts, whichever separator it uses. */
export const partsOf = (top: string, path: string): string[] => path.slice(top.length).split(/[\\/]/).filter(Boolean);
/** A folder named by its parts below a copy's top, joined with that copy's own separator. */
export const pathIn = (top: string, parts: readonly string[]): string => parts.reduce(join, top);

/** The crumbs over a folder: the place (its top), then each folder down to this one. */
export function crumbsOf(row: Pick<PlaceRow, "label">, parts: readonly string[]): { label: string; parts: string[] }[] {
  return [{ label: row.label, parts: [] }, ...parts.map((part, i) => ({ label: part, parts: parts.slice(0, i + 1) }))];
}

/** Where a search hit lies: its team, its place and the folders above it. */
export function placeOf(row: Pick<PlaceRow, "label" | "team">, parts: readonly string[]): string {
  return [...(row.team && row.team !== row.label ? [row.team] : []), row.label, ...parts.slice(0, -1)].join("/");
}

/** The row and copy a file lies in, and its parts below that place's top; null for a file in no row (a library's own top). */
export function rowOf(rows: readonly PlaceRow[], libraryId: string, path: string): { row: PlaceRow; copy: PlaceCopy; parts: string[] } | null {
  for (const row of rows)
    for (const copy of row.copies)
      if (copy.library.id === libraryId && (path === copy.folder || path.startsWith(copy.folder.replace(/[\\/]+$/, "") + (copy.folder.includes("\\") && !copy.folder.includes("/") ? "\\" : "/"))))
        return { row, copy, parts: partsOf(copy.folder, path) };
  return null;
}

/** A failure that says the machine could not be reached, not a refusal about the file: the next copy is asked. */
export function unreachable(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  const words = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return name === "ConnectionLostError" || name === "TimeoutError" || /^(not connected|connection closed)$|timed out|not reachable|unreachable|could not wake|did not wake|not answering|is offline|is asleep/i.test(words);
}

/** How a file opens from the view: in a thread's canvas on the file's own host, from a copy he allowed, or in its app where it lies. */
export function openWay(entry: Pick<TeamsEntry, "name" | "path" | "kind">, library: ShownLibrary, workspaceEnv: string, copyAllowed: boolean): "canvas" | "copy" | "app" {
  if (!teamsCanvasOf(entry, library.host)) return "app";
  // A file in the Windows VM is never a canvas's on its own host: a copy brings it out, else it opens in its app there.
  if (library.env === workspaceEnv && !library.vm) return "canvas";
  return copyAllowed ? "copy" : "app";
}

const APP = { excel: "Excel", word: "Word", powerpoint: "PowerPoint" } as const;
/** "Open in Excel", or "Open in the app" for a file no Office app owns. */
export function appVerb(entry: Pick<TeamsEntry, "name" | "kind">): string {
  const app = teamsAppOf(entry.kind, entry.name);
  return app ? `Open in ${APP[app]}` : "Open in the app";
}

/** How long a host has to answer the list before the view says it did not: a host answers from what it keeps, never waiting on its VM. */
export const HOST_DEADLINE_MS = 4_000;
/** How long a host has to answer a search: the VM walks its disk for up to 15 s. Each host's hits show as they come. */
export const SEARCH_DEADLINE_MS = 20_000;
/** While the VM's first read is under way, the host is asked again this often, in case its push is missed. */
export const READING_AGAIN_MS = 5_000;

/** `p`, or past `ms` a failure that reads as a machine out of reach (`unreachable`); `p` itself keeps running. */
export function byDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`No answer in ${Math.round(ms / 1000)} s`), { name: "TimeoutError" })), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

/** Whether a host's answer says its VM is being read for the first time: what it holds is still to come. */
export const vmReading = (answer: TeamsLibrariesAnswer | undefined): boolean => !!answer?.places?.some((p) => p.kind === "vm" && p.state === "reading");

/** One host's answer to `filesLibraries`, or why it gave none. */
export interface HostRead {
  env: string;
  name: string;
  /** a Mac or a PC: its own OneDrive folders count */
  desktop: boolean;
  answer?: TeamsLibrariesAnswer;
  failed?: { words: string; unreachable: boolean };
}

/** What the view says when Teams files are missing: the one most useful thing, and its one press. */
export interface FilesNote {
  title: string;
  line?: string;
  /** a machine did not answer: the view says it on its state line */
  away?: true;
  fix?: { kind: "allow"; vm: boolean } | { kind: "retry" } | { kind: "sign-in"; env: string } | { kind: "open-vm"; env: string } | { kind: "settings" };
}

export interface NoteInput {
  workspaceEnv: string;
  /** the workspace's own host first, then each desktop it may use */
  reads: readonly HostRead[];
  windowsVm: boolean;
  /** his desktops this workspace may not use yet, by name */
  notAllowed: readonly string[];
  /** the rows listed, and whether any copy of them lies in the VM */
  listed: readonly PlaceRow[];
}

const names = (list: readonly string[]): string => (list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);
const vmPlace = (read: HostRead | undefined): TeamsPlace | undefined => read?.answer?.places?.find((p) => p.kind === "vm");
const VM = "the Windows VM";

/**
 * Why nothing (or less than he expects) is listed, in the order the causes are checked (docs/agents/work-files.md
 * "When nothing is listed"). With libraries listed it names only a place that needs him; null: nothing to say.
 */
export function filesNote({ workspaceEnv, reads, windowsVm, notAllowed, listed }: NoteInput): FilesNote | null {
  const own = reads.find((r) => r.env === workspaceEnv);
  const vm = windowsVm ? vmPlace(own) : undefined;
  const away = reads.filter((r) => r.failed?.unreachable);
  if (listed.length) {
    // A desktop that did not answer goes unsaid while the VM lists its copies; the state line says it otherwise.
    if (away.length && !listed.some((row) => row.copies.some((c) => c.library.vm))) return { title: `${names(away.map((r) => r.name))} did not answer`, fix: { kind: "retry" }, away: true };
    if (vm?.state === "signed-out") return { title: "OneDrive on the Windows VM is signed out", fix: { kind: "sign-in", env: workspaceEnv } };
    // The VM's helper did not answer its last read: its rows are what was kept, and the state line says why.
    if (vm?.state === "error") return { title: "The Windows VM did not answer", line: vm.detail, fix: { kind: "retry" }, away: true };
    return null;
  }
  // e: the workspace's own host refused, and nothing else answered: its own words.
  if (own?.failed && !own.failed.unreachable && reads.every((r) => r.failed)) return { title: "Files did not load", line: own.failed.words, fix: { kind: "retry" } };
  // a: it may use no computer that has his files yet.
  const hostVm = vmPlace(own);
  const canVm = !windowsVm && !!hostVm && hostVm.state !== "not-set-up";
  const allowed = reads.filter((r) => r.env !== workspaceEnv);
  if (!allowed.length && !windowsVm && (notAllowed.length || canVm))
    return { title: "This workspace can't use your computers yet", line: `Allow ${names([...notAllowed, ...(canVm ? [VM] : [])])} to list your Teams files.`, fix: { kind: "allow", vm: canVm } };
  // b: a machine it may use is not answering.
  if (away.length) return { title: `${names(away.map((r) => r.name))} did not answer`, fix: { kind: "retry" }, away: true };
  // c: OneDrive in the VM needs his sign-in, or the VM is the only place and is not set up.
  if (vm?.state === "signed-out") return { title: "OneDrive on the Windows VM is signed out", fix: { kind: "sign-in", env: workspaceEnv } };
  const folders = reads.filter((r) => r.desktop).flatMap((r) => (r.answer?.places ?? []).filter((p) => p.kind === "folders").map((place) => ({ read: r, place })));
  if (vm?.state === "not-set-up" && !folders.length) return { title: "The Windows VM is not set up", fix: { kind: "settings" } };
  // d: a place answers, and no Teams library is synced there.
  for (const { read, place } of folders) {
    if (place.state === "ok" || place.state === "no-libraries") return { title: `No Teams files on ${read.name}`, line: "Sync a channel from Teams with OneDrive there." };
    if (place.state === "no-onedrive") return { title: `OneDrive is not signed in on ${read.name}`, line: "Sign in there, then sync a channel from Teams." };
  }
  if (vm && (vm.state === "ok" || vm.state === "no-libraries"))
    return { title: "No Teams files on the Windows VM", line: "Sync a channel from Teams with OneDrive there.", fix: { kind: "open-vm", env: workspaceEnv } };
  const broken = [...folders.map((f) => ({ name: f.read.name, place: f.place })), ...(vm ? [{ name: VM, place: vm }] : [])].find((f) => f.place.state === "error");
  if (broken) return { title: `Teams files on ${broken.name} did not load`, line: broken.place.detail, fix: { kind: "retry" } };
  const refused = reads.find((r) => r.failed);
  if (refused) return { title: "Files did not load", line: refused.failed!.words, fix: { kind: "retry" } };
  return { title: "No Teams files" };
}
