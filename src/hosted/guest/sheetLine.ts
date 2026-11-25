import { createSheetSession, type Mutation, type SavedSession, type ServerFrame, type SessionEvent, type SheetSession } from "work-kit/sheet/collab";
import { afterRevoked, CLOSE_REVOKED } from "./ending";
import { OpenFailed, STARTING_FOR_MS, type Opened, type Session } from "./session";

/**
 * A hosted sheet's line to the service (docs/agents/work-sheets.md "Live editing"): the socket, kept up for as long
 * as the page is, and work-kit's session on it, which keeps this page's own unanswered edits apart from the sheet's
 * order. No React, so a test drives it with a socket and a clock of its own.
 *
 * The line never gives up on a page that has its sheet: a dropped line, a host that restarted and a host still
 * starting are tried again every second for the first half minute, then every five, while the page is in view.
 * Edits made meanwhile wait in the session and go when the sheet is back. Only a page that never got its sheet is
 * handed back as out of reach, after two minutes; only a link the service says is over ends the page.
 */

/** The retry rule the document's socket follows too: a second apart for half a minute, then five. */
export const RETRY = { fastMs: 1000, fastForMs: 30_000, slowMs: 5000 } as const;
/** How long the line may be down before the page says so: a restart's blink says nothing. */
export const OFFLINE_AFTER_MS = 1500;
/** A selection is said when it changed, this often at most (the service drops more than ten a second). */
export const SELECTION_EVERY_MS = 250;

/** Another person on the sheet and the cells they hold, as the service names them. */
export interface SheetPerson {
  id: string;
  name: string;
  hue: number;
  sheet: string;
  range: { startRow: number; endRow: number; startColumn: number; endColumn: number };
}

export interface LineStatus {
  /** the line has been down long enough to say so */
  offline: boolean;
  /** the grid is being put right from the sheet: it takes no edits meanwhile */
  syncing: boolean;
  /** as many edits wait as the page keeps: it takes no more until some go */
  full: boolean;
  /** more than zero while edits made here wait for the sheet's answer */
  unsent: number;
}

export type Selection = { sheet: string; range: SheetPerson["range"] } | null;

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(t: unknown): void;
}

export interface SheetLineOptions {
  session: Pick<Session, "token" | "refresh" | "socketUrl">;
  opened: Opened;
  /** A random id this page's batches are known by; the kept queue's own when there is one. */
  cid: string;
  saved?: SavedSession | null;
  lay(mutations: Mutation[]): void;
  /** Replace the grid with this workbook; `ready()` once it stands. */
  rebuild(snapshot: Record<string, unknown>): void;
  status(status: LineStatus): void;
  /** `returning`: said as the page came back from a dropped line, so the edits were made offline. */
  said(event: SessionEvent, returning: boolean): void;
  people(people: SheetPerson[]): void;
  /** The session's kept state moved. */
  changed?(saved: SavedSession): void;
  gone(): void;
  /** The owner changed the link's role: the page opens again as that role. */
  reopen(): void;
  /** The page never got its sheet. */
  down(): void;
  Socket?: typeof WebSocket;
  timers?: Timers;
  now?(): number;
  /** Whether the page is in view; and a way to hear it come back. */
  visible?(): boolean;
  onVisible?(fn: () => void): () => void;
}

export interface SheetLine {
  /** A mutation the grid made and holds, as it is sent. */
  local(mutation: Mutation): void;
  /** The grid `rebuild` asked for stands. */
  ready(): void;
  /** This page's selection, or none. */
  select(selection: Selection): void;
  /** Whether a socket is open and answered. */
  up(): boolean;
  stop(): void;
}

const sameSelection = (a: Selection, b: Selection): boolean => JSON.stringify(a) === JSON.stringify(b);

export function openSheetLine(o: SheetLineOptions): SheetLine {
  const Socket = o.Socket ?? WebSocket;
  const timers: Timers = o.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };
  const now = o.now ?? Date.now;
  const visible = o.visible ?? (() => typeof document === "undefined" || !document.hidden);
  const onVisible =
    o.onVisible ??
    ((fn) => {
      if (typeof document === "undefined") return () => {};
      const on = (): void => void (!document.hidden && fn());
      document.addEventListener("visibilitychange", on);
      return () => document.removeEventListener("visibilitychange", on);
    });

  let stopped = false;
  let ws: WebSocket | null = null;
  /** The socket is open and its state came. */
  let answered = false;
  let token = "";
  /** Since when the line has been down; null while it is up. The page starts down. */
  let downSince: number | null = now();
  /** A sheet has come at least once: from then on the page keeps trying for good. */
  let had = false;
  let offline = false;
  let retry: unknown = null;
  let saying: unknown = null;
  /** True from a socket's open until its state is handled: what the session says then is about edits made while away. */
  let returning = false;
  let last: LineStatus | null = null;
  const people = new Map<string, SheetPerson>();

  let selection: Selection = null;
  let saidSelection: Selection = null;
  let selecting: unknown = null;
  let saidAt = 0;

  const sess: SheetSession = createSheetSession({
    cid: o.cid,
    ...(o.saved ? { saved: o.saved } : {}),
    timers,
    send: (frame) => {
      if (!ws || ws.readyState !== Socket.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    },
    lay: o.lay,
    rebuild: (snapshot) => o.rebuild(snapshot as Record<string, unknown>),
    resync: (hello) => {
      if (ws && ws.readyState === Socket.OPEN) ws.send(JSON.stringify({ t: "hello", token, ...hello }));
    },
    said: (event) => o.said(event, returning),
    changed: () => {
      o.changed?.(sess.saved());
      tell();
    },
  });

  function tell(): void {
    const s = sess.status();
    const next: LineStatus = { offline, syncing: s.syncing, full: s.full, unsent: s.unsent + (s.inflight ? 1 : 0) };
    if (last && last.offline === next.offline && last.syncing === next.syncing && last.full === next.full && last.unsent === next.unsent) return;
    last = next;
    o.status(next);
  }

  function sayPeople(): void {
    o.people([...people.values()]);
  }

  function sendSelection(): void {
    selecting = null;
    if (!ws || ws.readyState !== Socket.OPEN || !answered || sameSelection(selection, saidSelection)) return;
    saidSelection = selection;
    saidAt = now();
    ws.send(JSON.stringify(selection ? { t: "presence", sheet: selection.sheet, range: selection.range } : { t: "presence", range: null }));
  }

  function wentDown(): void {
    answered = false;
    downSince ??= now();
    if (people.size) {
      people.clear();
      sayPeople();
    }
    saidSelection = null;
    if (!offline && saying === null && had) {
      saying = timers.set(() => {
        saying = null;
        if (answered || stopped) return;
        offline = true;
        tell();
      }, OFFLINE_AFTER_MS);
    }
  }

  /** Again: at once, or by the rule; held while the page is out of view. */
  function again(at: "now" | "paced", expired = false): void {
    if (stopped || retry !== null) return;
    const since = downSince ?? now();
    if (!had && now() - since >= STARTING_FOR_MS) return o.down();
    const go = (): void => {
      retry = null;
      if (stopped) return;
      if (!visible()) {
        const off = onVisible(() => {
          off();
          again("now", expired);
        });
        return;
      }
      void connect(expired);
    };
    retry = timers.set(go, at === "now" ? 0 : now() - since < RETRY.fastForMs ? RETRY.fastMs : RETRY.slowMs);
  }

  async function connect(expired: boolean): Promise<void> {
    try {
      // After the service said the token ran out, a new one is asked for whatever this browser's clock thinks.
      token = expired ? (await o.session.refresh()).token : (await o.session.token()).token;
    } catch (err) {
      if (stopped) return;
      // Only a link the service says is over ends the page; a host that is starting, or out of reach, is tried again.
      if (err instanceof OpenFailed && err.why === "gone") return o.gone();
      wentDown();
      return again("paced");
    }
    if (stopped) return;
    const socket = new Socket(o.session.socketUrl(o.opened));
    ws = socket;
    socket.onopen = () => {
      returning = had;
      socket.send(JSON.stringify({ t: "hello", token, ...sess.up() }));
    };
    socket.onmessage = (e) => {
      if (ws !== socket) return;
      const msg = JSON.parse(String(e.data)) as ServerFrame | ({ t: "presence" } & SheetPerson) | { t: "left"; id: string };
      if (msg.t === "presence") {
        const { t: _t, ...person } = msg;
        people.set(person.id, person);
        return sayPeople();
      }
      if (msg.t === "left") {
        if (people.delete(msg.id)) sayPeople();
        return;
      }
      if (msg.t === "state") {
        answered = true;
        had = true;
        downSince = null;
        offline = false;
        if (saying !== null) timers.clear(saying);
        saying = null;
        sess.receive({ ...msg, ...(typeof msg.snapshot === "string" ? { snapshot: JSON.parse(msg.snapshot) as unknown } : {}) });
        returning = false;
        tell();
        sendSelection();
        return;
      }
      sess.receive(msg);
      tell();
    };
    socket.onclose = (e) => {
      if (ws !== socket) return;
      ws = null;
      sess.down();
      if (stopped) return;
      wentDown();
      tell();
      // Asked again: a link gone ends the page, a role he changed opens it again as that role, else back on a fresh token.
      if (e.code === CLOSE_REVOKED) return void afterRevoked(() => o.session.refresh(), o.opened.role, { gone: o.gone, reopen: o.reopen, again: () => again("now", true) });
      // 4401: the token ran out. Anything else: the line dropped, or the host is restarting.
      again(e.code === 4401 ? "now" : "paced", e.code === 4401);
    };
  }

  void connect(false);

  return {
    local(mutation) {
      sess.local(mutation);
      tell();
    },
    ready() {
      sess.ready();
      tell();
    },
    select(next) {
      selection = next;
      if (selecting !== null || sameSelection(selection, saidSelection)) return;
      selecting = timers.set(sendSelection, Math.max(0, SELECTION_EVERY_MS - (now() - saidAt)));
    },
    up: () => answered,
    stop() {
      stopped = true;
      sess.stop();
      for (const t of [retry, saying, selecting]) if (t !== null) timers.clear(t);
      retry = saying = selecting = null;
      const socket = ws;
      ws = null;
      socket?.close(1000);
    },
  };
}
