import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import type { ComputerSessionRow } from "@server/shared/contract-computer";
import { parseMacComputerKey } from "@server/shared/computer/macKey";
import { LOCAL_ENVIRONMENT_ID, registry } from "./connection/registry";
import { BOX_BROWSER_BUNDLE, computerSessionsStore, entriesOf, previewContext, startComputerSessions, type ComputerEntry, type PreviewContext } from "./computerSessions";
import { threadRoot } from "./devServers";
import { sessionStore, useSessionMetas } from "./tcserver/store";
import { hostName } from "./threadResources";

/**
 * Every computer being driven now, on every connected host
 * (docs/agents/computer-use.md "Computers"): one tile for each live session,
 * read from the store that already holds the hosts' rows and joined to its
 * thread's title. The Computers page draws them; the full view of one reads
 * the same tile, so its row says what the tile says.
 */

export interface ComputerTile {
  /** the host and the thread, as one key */
  id: string;
  entry: ComputerEntry;
  /** the thread's title, as the rail says it */
  title: string;
  /** what it is doing now, in the step's own words; null between calls */
  doing: string | null;
  /** where it runs, said once: the Mac a box thread drives, else the thread's host */
  where: string;
  /** he drives this page himself */
  driving: boolean;
  /** the session has a driver to take over from or hand back to: the Work browser's own page on its host */
  browser: boolean;
  /** the thread whose pane holds that browser: who drives is kept by it */
  pane: string;
  /** the machine that alone draws it, when this desktop may not; null when it draws here */
  shownOn: string | null;
  /** its name on its host, which outlives a session: `browser:<pane>`, `vm:windows`, `window:<thread>` */
  computer: string;
  /** nothing drives it now: the box's page after its last act, still there to watch and take over */
  idle: boolean;
  /** it shows its picture but takes none of his input now: the Windows VM with no window of its own */
  pictureOnly?: boolean;
}

export const tileId = (host: string, threadId: string): string => `${host}\n${threadId}`;

/** A row this Mac's own push carries for a session a box thread drives here: the box's push has it under the thread. */
const bridgedHere = (host: string, row: ComputerSessionRow): boolean => host === LOCAL_ENVIRONMENT_ID && parseMacComputerKey(row.threadId) !== null;

/**
 * The tiles, the one that acted last first. A session a box thread drives
 * on this Mac is one tile, the box's: this Mac's own row for it is the same
 * session under the bridge's key.
 */
export function computerTiles(
  byHost: Readonly<Record<string, readonly ComputerSessionRow[]>>,
  titleOf: (host: string, threadId: string) => string | null,
  nameOf: (host: string) => string,
  ctx: PreviewContext,
  paneOf: (threadId: string) => string = (id) => id,
): ComputerTile[] {
  const tiles: ComputerTile[] = [];
  for (const [host, rows] of Object.entries(byHost)) {
    const mine = rows.filter((row) => !bridgedHere(host, row));
    if (!mine.length) continue;
    for (const entry of entriesOf(mine, new Set(mine.map((r) => r.threadId)), host, ctx)) {
      const { row } = entry;
      const where = row.macName ?? nameOf(host);
      tiles.push({
        id: tileId(host, row.threadId),
        entry,
        title: titleOf(host, row.threadId) ?? row.apps[0]?.window ?? row.apps[0]?.name ?? "Untitled",
        doing: row.driver === "owner" ? null : (row.running?.words ?? null),
        where,
        driving: row.driver === "owner",
        browser: !row.macPeer && row.apps.some((a) => a.bundleId === BOX_BROWSER_BUNDLE),
        pane: paneOf(row.threadId),
        shownOn: entry.previewable ? null : where,
        computer: row.computer ?? `window:${row.threadId}`,
        idle: !!row.idle,
        ...(row.pictureOnly ? { pictureOnly: true } : {}),
      });
    }
  }
  return tiles.sort((a, b) => b.entry.row.lastCallAt - a.entry.row.lastCallAt || a.id.localeCompare(b.id));
}

/** Every computer being driven now, live. */
export function useComputers(): ComputerTile[] {
  useEffect(startComputerSessions, []);
  const byHost = useStore(computerSessionsStore, (s) => s.byHost);
  const metas = useSessionMetas();
  // only the titles of threads that drive something matter: the same string while none of them changed
  const titles = useMemo(() => {
    const driven = new Set(Object.values(byHost).flatMap((rows) => rows.map((r) => r.threadId)));
    return new Map(metas.filter((m) => driven.has(m.id)).map((m) => [tileId(m.environmentId ?? LOCAL_ENVIRONMENT_ID, m.id), m.title ?? null] as const));
  }, [byHost, metas]);
  const key = [...titles].map(([id, title]) => `${id}\n${title ?? ""}`).join("\0");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the titles' content
  return useMemo(
    () => computerTiles(byHost, (host, thread) => titles.get(tileId(host, thread)) ?? null, hostName, previewContext(), (id) => threadRoot(id, (t) => sessionStore.metaOf(t)?.parentId)),
    [byHost, key],
  );
}

/**
 * The tile a view opened on `threadId` shows now: that thread's, else the
 * browser page of its pane. Take over moves a page's row from the thread
 * that drove it to the pane's own thread, and a full view opened before it
 * is still looking at that page.
 */
export function findComputer(tiles: readonly ComputerTile[], host: string, threadId: string, pane: string): ComputerTile | null {
  return tiles.find((t) => t.id === tileId(host, threadId)) ?? tiles.find((t) => t.browser && t.entry.host === host && t.pane === pane) ?? null;
}

/** One tile by its host and thread, or null once nothing drives it. */
export function useComputer(host: string, threadId: string): ComputerTile | null {
  const tiles = useComputers();
  return findComputer(tiles, host, threadId, threadRoot(threadId, (t) => sessionStore.metaOf(t)?.parentId));
}

/**
 * What a tile is to React: its thread, except the one browser page of a
 * pane, which is the pane's. Take over stops the session of the thread that
 * drove the page and the host lists the page under the pane's own thread
 * from then on; it is the same page, so it stays the same tile, and its
 * picture the same element.
 */
export function tileKey(tile: ComputerTile, all: readonly ComputerTile[]): string {
  if (!tile.browser) return tile.id;
  const alone = all.every((t) => t === tile || !t.browser || t.entry.host !== tile.entry.host || t.pane !== tile.pane);
  return alone ? `${tile.entry.host}\n${tile.pane}\nbrowser` : tile.id;
}

/** He can take over this computer from its picture: the box's browser's page and the Windows VM while it has its window. A Mac's or a PC's own window takes no input. */
export const canTakeOver = (tile: Pick<ComputerTile, "browser" | "computer" | "pictureOnly">): boolean => !tile.pictureOnly && (tile.browser || tile.computer.startsWith("vm:"));

/** The name the host knows a tile's computer by for its wheel (computer/drive.ts): a browser tile's pane's page. */
export const driveName = (tile: ComputerTile): string => (tile.computer.startsWith("window:") ? `browser:${tile.pane}` : tile.computer);

/**
 * Take over a tile's computer: one call, and the host does the rest in order
 * (computer/drive.ts). He holds the wheel first, which refuses the agent every
 * further act and keeps the page listed; then every session that drove it is
 * stopped for its turn, wherever it runs.
 */
export async function takeOver(tile: ComputerTile): Promise<void> {
  const link = registry.link(tile.entry.host);
  if (!link) throw new Error("the host is not connected");
  await link.request("computer.drive", { computer: driveName(tile), driver: "owner" });
}

export async function handBack(tile: ComputerTile): Promise<void> {
  const link = registry.link(tile.entry.host);
  if (!link) throw new Error("the host is not connected");
  await link.request("computer.drive", { computer: driveName(tile), driver: "agent" });
}

/** The rail row's mark: waiting while a session's card needs him, working while anything is driven (an idle page is not), else none. It carries no count. */
export function computersMark(byHost: Readonly<Record<string, readonly ComputerSessionRow[]>>): "waiting" | "working" | null {
  let any = false;
  for (const [host, rows] of Object.entries(byHost)) {
    for (const row of rows) {
      if (bridgedHere(host, row) || row.idle) continue;
      if (row.asking) return "waiting";
      any = true;
    }
  }
  return any ? "working" : null;
}

export function useComputersMark(): "waiting" | "working" | null {
  useEffect(startComputerSessions, []);
  return useStore(computerSessionsStore, (s) => computersMark(s.byHost));
}
