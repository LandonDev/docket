import type { WebSocket } from 'ws'

/**
 * Who is on each live sheet (docs/agents/work-sheets.md "Live editing"): the sockets of a sheet's room, and where
 * each person on it has their cells selected. A sheet is not a Yjs document, so its presence is the route's own: a
 * client says its selection, and everyone else on the sheet is told it under the name and the hue the service
 * gives, never the client's (the link's name for a guest, the owner's for him). His desktop grid is not on a
 * socket: main says its selection through an internal route and hears the room's through the service's wire.
 */

const MAX_BUFFERED = 16 * 1024 * 1024

/** The sockets on each sheet, by the host's key for it; ops land through the host whoever wrote them. */
export const rooms = new Map<string, Set<WebSocket>>()
/** Whether a socket may still hear the sheet: asked before anything is sent to it, so a link revoked a moment ago hears nothing more while its socket waits for the next second's check. */
export const hears = new WeakMap<WebSocket, () => boolean>()

/** One frame to every socket of a sheet's room that may still hear it, but `except`; `own` gives one socket its own form. */
export function broadcast(key: string, msg: string, o: { except?: WebSocket; own?: { ws: WebSocket; msg: string } } = {}): void {
  const room = rooms.get(key)
  if (!room) return
  for (const ws of room) {
    if (ws === o.except) continue
    // A client that does not read is let go rather than held in the service's memory.
    if (ws.bufferedAmount > MAX_BUFFERED) ws.terminate()
    else if (hears.get(ws)?.() === false) ws.close(4403, 'the link was revoked')
    else ws.send(ws === o.own?.ws ? o.own.msg : msg)
  }
}

export interface Box {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

/** One person's selection on a sheet, as everyone else is told it. */
export interface SheetPerson {
  /** this presence's own id: a socket's, or `desktop:<item>` for his desktop grid */
  id: string
  name: string
  /** 1 to 8: the presence hue (`--presence-N`), the same for one person's every window */
  hue: number
  /** the tab's id */
  sheet: string
  range: Box
}

type Held = SheetPerson & { principal: string; at: number }
const people = new Map<string, Map<string, Held>>()
const listeners = new Set<(key: string, people: SheetPerson[]) => void>()

/** Hears who is on a sheet each time it changes (the service tells main, for his desktop grid). Returns its off. */
export function onPresence(fn: (key: string, people: SheetPerson[]) => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

const personOf = ({ principal: _p, at: _a, ...person }: Held): SheetPerson => person
export const peopleOn = (key: string): SheetPerson[] => [...(people.get(key)?.values() ?? [])].map(personOf)
const told = (key: string): void => listeners.forEach((fn) => fn(key, peopleOn(key)))

const int = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 2_000_000
/** A selection as a client may say it: a tab's id and a box on the grid. Null for anything else. */
export function selectionOf(sheet: unknown, range: unknown): { sheet: string; range: Box } | null {
  const r = range as Partial<Box> | null
  if (typeof sheet !== 'string' || !sheet || sheet.length > 200 || !r || typeof r !== 'object') return null
  if (!int(r.startRow) || !int(r.endRow) || !int(r.startColumn) || !int(r.endColumn) || r.endRow < r.startRow || r.endColumn < r.startColumn) return null
  return { sheet, range: { startRow: r.startRow, endRow: r.endRow, startColumn: r.startColumn, endColumn: r.endColumn } }
}

/**
 * The hue a principal wears on a sheet: the one its other window wears, else the lowest of the eight nobody on the
 * sheet wears, else (more than eight people) one by count. Nobody's hue changes when someone else comes or goes.
 */
function hueFor(room: ReadonlyMap<string, Held>, principal: string): number {
  for (const p of room.values()) if (p.principal === principal) return p.hue
  const worn = new Set([...room.values()].map((p) => p.hue))
  for (let hue = 1; hue <= 8; hue++) if (!worn.has(hue)) return hue
  return (room.size % 8) + 1
}

/** A person's selection said: kept, and told to every other socket of the sheet under the service's name and hue. */
export function setPresence(key: string, id: string, who: { principal: string; name: string }, at: { sheet: string; range: Box }, except?: WebSocket, now = Date.now()): SheetPerson {
  let room = people.get(key)
  if (!room) people.set(key, (room = new Map()))
  const held: Held = { id, name: who.name.slice(0, 80), hue: room.get(id)?.hue ?? hueFor(room, who.principal), sheet: at.sheet, range: at.range, principal: who.principal, at: now }
  room.set(id, held)
  const person = personOf(held)
  broadcast(key, JSON.stringify({ t: 'presence', ...person }), { ...(except ? { except } : {}) })
  told(key)
  return person
}

/** A presence gone (its socket closed, his canvas closed or cleared its selection): everyone else is told. */
export function dropPresence(key: string, id: string, except?: WebSocket): boolean {
  const room = people.get(key)
  if (!room?.delete(id)) return false
  if (!room.size) people.delete(key)
  broadcast(key, JSON.stringify({ t: 'left', id }), { ...(except ? { except } : {}) })
  told(key)
  return true
}

/** How long a presence main said (his desktop grid's) stands with no word: a window that went without saying so is let go. */
export const DESKTOP_PRESENCE_MS = 30 * 60_000

/** Presences nobody has refreshed in `DESKTOP_PRESENCE_MS` that no socket holds (ids of main's own). */
export function sweepPresence(now = Date.now()): void {
  for (const [key, room] of [...people]) for (const p of [...room.values()]) if (p.id.startsWith('desktop:') && now - p.at > DESKTOP_PRESENCE_MS) dropPresence(key, p.id)
}

/** A test's reset. */
export function clearRooms(): void {
  rooms.clear()
  people.clear()
}
