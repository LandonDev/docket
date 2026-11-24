import type { TeamsEntry } from "@shared/contract-work-office";
import { fileChipOf, kindOfEntry, refKey, type FileEntry } from "@shared/work/files";
import { fileKey, type SearchAnswer, type SearchHit } from "@shared/work/search";
import { LOCAL_ENVIRONMENT_ID, registry } from "../../lib/connection";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { hostIdOfLink, linkIdOfHost, workspaceSettings } from "../shell/actions";
import type { AskedHost } from "./hosts";

/**
 * His other computers' folders in "All files for …" (docs/agents/work-search.md "Files on his computers"). A
 * job's host searches its own disk and the places it keeps; a Teams library synced on his Mac is the Mac's to
 * search, and the host cannot (searching a far computer through the host is a reach nobody has ruled on). So the
 * window asks each desktop the job may use that it holds a link to itself, with the search Files uses there
 * (`work.office.filesSearch`: names, never a file's words), and names the ones it has no link to in one quiet
 * line. No new reach: the window already lists those folders by the same link.
 *
 * Only when files are asked alone: the desktop's search walks its folders, which is no work for every key he types.
 */

export const DESK = "desk:";
const SOURCE = "desktop.file";
/** The walk's own cap on the desktop is 15 s. */
const WALK_MS = 20_000;

export interface Desktops {
  /** desktops the window may ask itself, each for the first job in scope that may use it */
  linked: { link: string; host: string; name: string; workspaceId: string }[];
  /** desktops a job may use that this window has no link to, by name where it is known */
  far: string[];
}
export const NO_DESKTOPS: Desktops = { linked: [], far: [] };

export interface DesktopDeps {
  settings(workspace: Pick<WorkspaceMeta, "id" | "environmentId">): Promise<{ mayUseDesktop: string[] }>;
  /** this machine's own host id */
  local(): Promise<string | null>;
  linkOf(hostId: string, local: string | null): string | null;
  connected(link: string): boolean;
  nameOf(link: string): string | undefined;
}

const live: DesktopDeps = {
  settings: workspaceSettings,
  local: async () => registry.statusOf(LOCAL_ENVIRONMENT_ID).lastHello?.environmentId ?? null,
  linkOf: linkIdOfHost,
  connected: (link) => registry.link(link)?.connected === true,
  nameOf: (link) => registry.environment(link)?.name,
};

/** The desktops the jobs in scope may use, sorted into the ones this window can ask and the ones it cannot. */
export async function desktopsFor(workspaces: readonly Pick<WorkspaceMeta, "id" | "environmentId">[], deps: Partial<DesktopDeps> = {}): Promise<Desktops> {
  const d = { ...live, ...deps };
  const local = await d.local();
  const linked = new Map<string, Desktops["linked"][number]>();
  const far = new Set<string>();
  await Promise.all(
    workspaces.map(async (workspace) => {
      const settings = await d.settings(workspace).catch(() => null);
      for (const host of settings?.mayUseDesktop ?? []) {
        const link = d.linkOf(host, local);
        // The job's own host searches itself.
        if (link === workspace.environmentId) continue;
        if (link && d.connected(link)) {
          if (!linked.has(link)) linked.set(link, { link, host: hostIdOfLink(link, local), name: d.nameOf(link) ?? "This computer", workspaceId: workspace.id });
        } else far.add((link && d.nameOf(link)) || d.nameOf(host) || "another computer");
      }
    }),
  );
  return { linked: [...linked.values()], far: [...far] };
}

/** A desktop as one more host of the search. */
export const deskHosts = (desktops: Desktops): AskedHost[] => desktops.linked.map((desk) => ({ id: `${DESK}${desk.link}`, name: desk.name, home: false, workspaceId: desk.workspaceId }));

/** What the list's foot says of the desktops nobody searched. */
export function unsearchedLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const list = names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Folders on ${list} were not searched.`;
}

const parentOf = (path: string): string => path.replace(/[\\/]+[^\\/]*$/, "").split(/[\\/]/).pop() ?? "";

/** A file the desktop found, as a row: where it lies is the computer and the folder it is in. */
export function deskHit(entry: TeamsEntry, desk: { host: string; name: string; workspaceId: string }): SearchHit {
  const ref = { at: "file" as const, host: desk.host, path: entry.path };
  const key = refKey(ref);
  const row: FileEntry = { key, ref, folder: null, name: entry.name, kind: kindOfEntry(entry.name).kind, shared: true };
  const chip = fileChipOf(row);
  return {
    key: fileKey(key),
    kind: "file",
    title: entry.name,
    detail: [desk.name, parentOf(entry.path)].filter(Boolean).join(" › "),
    at: entry.modified,
    workspaceId: desk.workspaceId,
    open: { to: "file", ref, name: entry.name },
    ...(chip ? { chip } : {}),
    ...(entry.local ? {} : { cloud: true as const }),
  };
}

type Ask = (link: string, method: string, params: Record<string, unknown>, o: { timeoutMs: number }) => Promise<{ entries: TeamsEntry[]; more?: boolean }>;
const wire: Ask = (link, method, params, o) => registry.linkOf(link).request(method, params, o);

/**
 * One ask of a desktop, in the shape a host answers. As he types it answers nothing at once, and offers its one
 * source only when files are asked alone; that source is the desktop's own walk.
 */
export async function askDesktop(desktops: Desktops, hostId: string, params: Record<string, unknown>, ask: Ask = wire): Promise<SearchAnswer> {
  const desk = desktops.linked.find((d) => `${DESK}${d.link}` === hostId);
  const text = String(params.text ?? "").trim();
  if (!desk || !text || params.kind !== "file") return { groups: [], pending: [], quiet: [], searched: 0 };
  if (!params.sources) return { groups: [], pending: [{ source: SOURCE, kind: "file" }], quiet: [], searched: 0 };
  const found = await ask(desk.link, "work.office.filesSearch", { query: text }, { timeoutMs: WALK_MS });
  const hits = found.entries.filter((e) => e.kind !== "folder").map((e) => deskHit(e, desk));
  return { groups: [{ source: SOURCE, kind: "file", label: "Files", hits, more: found.more === true }], pending: [], quiet: [], searched: 1 };
}
