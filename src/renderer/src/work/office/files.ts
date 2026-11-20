import { teamsAppOf, teamsCanvasOf, type TeamsEntry, type TeamsLibrary } from "@shared/contract-work-office";

/**
 * The Files view's own rules (docs/agents/work-files.md "The Files view"), kept apart from the
 * screen so they are tested alone: how the libraries read as teams and channels, the crumbs over a
 * folder, a file's place in a search, and where a file opens.
 */

/** A library as the window holds it: with the link (`env`) it was read from, which for this machine is not the host's own id. */
export type ShownLibrary = TeamsLibrary & { env: string };

export interface LibraryRow {
  key: string;
  label: string;
  library: ShownLibrary;
  /** the folder the row opens */
  folder: string;
}
export interface LibraryGroup {
  name: string;
  rows: LibraryRow[];
}

const join = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, "")}${dir.includes("\\") && !dir.includes("/") ? "\\" : "/"}${name}`;

/** Teams by name, each with its channels (a team's Documents' top folders), then its other libraries; his own OneDrive and folders he added last. */
export function libraryGroups(libraries: readonly ShownLibrary[]): LibraryGroup[] {
  const groups = new Map<string, LibraryRow[]>();
  const add = (name: string, row: LibraryRow) => groups.set(name, [...(groups.get(name) ?? []), row]);
  for (const library of libraries) {
    if (library.kind === "mine" || library.kind === "folder") {
      add("", { key: library.id, label: library.kind === "mine" ? "My files" : library.library ? `${library.team} ${library.library}` : library.team, library, folder: library.path });
      continue;
    }
    if (library.kind === "channels" && library.channels.length)
      for (const channel of library.channels) add(library.team, { key: `${library.id}/${channel}`, label: channel, library, folder: join(library.path, channel) });
    // A team's Documents is named so; a library OneDrive named only as one word (its newer layout) keeps that name.
    else add(library.team, { key: library.id, label: library.library ?? (library.kind === "channels" ? "Documents" : library.team), library, folder: library.path });
  }
  return [...groups]
    .map(([name, rows]) => ({ name, rows }))
    .sort((a, b) => (a.name === "" ? 1 : b.name === "" ? -1 : a.name.localeCompare(b.name)));
}

/** A group's heading is drawn unless its one row already says it (a library known by one name). */
export const showsHeading = (group: LibraryGroup): boolean => group.name !== "" && group.rows.some((row) => row.label !== group.name);

/** The parts of a folder's path inside its library. */
const partsOf = (library: Pick<TeamsLibrary, "path">, path: string): string[] => path.slice(library.path.length).split(/[\\/]/).filter(Boolean);

/** The crumbs over a folder: the team (its top), then each folder down to this one. */
export function crumbsOf(library: ShownLibrary, folder: string): { label: string; folder: string }[] {
  const top = { label: library.kind === "mine" ? "My files" : library.library && library.kind !== "channels" ? `${library.team} ${library.library}` : library.team, folder: library.path };
  let at = library.path;
  return [top, ...partsOf(library, folder).map((part) => ({ label: part, folder: (at = join(at, part)) }))];
}

/** Where a search hit lies: its team and the folders above it. */
export function placeOf(library: ShownLibrary, path: string): string {
  const parts = partsOf(library, path).slice(0, -1);
  return [crumbsOf(library, library.path)[0]!.label, ...parts].join("/");
}

/** How a file opens from the view: in a thread's canvas on the file's own host, from a copy he allowed, or in its app where it lies. */
export function openWay(entry: Pick<TeamsEntry, "name" | "path" | "kind">, library: ShownLibrary, workspaceEnv: string, copyAllowed: boolean): "canvas" | "copy" | "app" {
  if (!teamsCanvasOf(entry, library.host)) return "app";
  if (library.env === workspaceEnv) return "canvas";
  return copyAllowed ? "copy" : "app";
}

const APP = { excel: "Excel", word: "Word", powerpoint: "PowerPoint" } as const;
/** "Open in Excel", or "Open in the app" for a file no Office app owns. */
export function appVerb(entry: Pick<TeamsEntry, "name" | "kind">): string {
  const app = teamsAppOf(entry.kind, entry.name);
  return app ? `Open in ${APP[app]}` : "Open in the app";
}
