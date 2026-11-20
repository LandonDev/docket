import { useEffect, useRef, useState } from "react";
import { SheetCanvas, type SheetHandle } from "work-kit/sheet";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { StatusMark } from "@renderer/components/ui/status";
import { OpenFailed, type Opened, type Session } from "./session";

/**
 * A sheet on the hosted page: the owner's grid (work-kit/sheet) on the live
 * sheet socket (docs/agents/work-sheets.md "Live editing"). An edit link's
 * cell edits go as ops from the revision the grid stands at; everyone's ops
 * come back, and a refused one reloads the workbook. A view link is the grid
 * read only. The service holds a guest to values, formats and rows. A refused
 * edit says so on one line over the grid ("Edit not saved" and why, in plain
 * words) while the sheet as it is reloads; so does an edit the line dropped
 * before the sheet answered it. While the line is down the grid stays as it
 * was, read only, under "Reconnecting"; an edit that slips in then is not
 * kept, and is said. The next edit the sheet takes clears the line.
 */

type Mutation = { id: string; params: Record<string, unknown> };
type Incoming = { t: "state"; rev: number; snapshot: string | Record<string, unknown> } | { t: "ops"; rev: number; by: string; mutations: Mutation[] } | { t: "ack"; id: number; rev: number } | { t: "refused"; id: number; reason: string };

const EDIT_WAIT = 150;

/**
 * Why an edit was not saved, in a guest's words: the service's own reasons are
 * protocol words. A reason with no plain form leaves the line its word alone
 * (null); `lost` is an edit whose answer never came because the line dropped.
 */
export function refusedWords(reason: string | "lost"): string | null {
  if (reason === "lost") return "The connection dropped before the sheet took it";
  if (/changed under that edit/i.test(reason)) return "Someone changed the sheet first. Type it again";
  if (/^a guest cannot/i.test(reason)) return "Guests can change values and formats only";
  if (/can view, not edit/i.test(reason)) return "This link can view the sheet, not edit it";
  return null;
}

export function SheetPage({ session, opened, onGone, onDown }: { session: Session; opened: Opened; onGone(): void; onDown(): void }) {
  const [book, setBook] = useState<{ snapshot: Record<string, unknown>; key: number } | null>(null);
  // Set: an edit the sheet does not have, and why in his words (null: the word alone).
  const [refused, setRefused] = useState<{ why: string | null } | null>(null);
  // The socket is down: the grid stays as it was, read only, under one line, until a fresh state comes.
  const [offline, setOffline] = useState(false);
  const handle = useRef<SheetHandle | null>(null);
  const live = useRef<{ ws: WebSocket | null; rev: number; pending: Mutation[]; sent: string[]; unit: string; inflight: boolean; timer: ReturnType<typeof setTimeout> | null; n: number }>({ ws: null, rev: -1, pending: [], sent: [], unit: "", inflight: false, timer: null, n: 0 });

  useEffect(() => {
    let stopped = false;
    let tries = 0;
    const l = live.current;
    // Again, with backoff: after five tries in a row, the page cannot be reached (the unavailable screen, with Retry).
    const again = (delay?: number): void => {
      if (++tries > 5) return onDown();
      setTimeout(() => void connect(), delay ?? Math.min(8000, 500 * 2 ** tries));
    };
    const connect = async (): Promise<void> => {
      let token: string;
      try {
        token = (await session.token()).token;
      } catch (err) {
        if (stopped) return;
        // Only a link the service says is over (expired, revoked) ends the page; a token refresh that failed in passing
        // (the network, the service, too many tries) keeps the grid under Reconnecting and tries again.
        if (err instanceof OpenFailed && err.why === "gone") return onGone();
        setOffline(true);
        return again();
      }
      if (stopped) return;
      const ws = new WebSocket(session.socketUrl(opened));
      l.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ t: "hello", token }));
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as Incoming;
        tries = 0;
        if (msg.t === "state") {
          setOffline(false);
          // A reconnect that finds the sheet where the grid stands keeps the grid as it is.
          const snapshot = typeof msg.snapshot === "string" ? (JSON.parse(msg.snapshot) as Record<string, unknown>) : msg.snapshot;
          l.unit = typeof snapshot.id === "string" ? snapshot.id : "";
          if (msg.rev !== l.rev || !handle.current) setBook({ snapshot, key: msg.rev * 1000 + ++l.n });
          l.rev = msg.rev;
        } else if (msg.t === "ops") {
          // Our own ops come back too. A guest's principal is its link's alone; the owner has other windows, so his are known by what was sent.
          const at = msg.by === opened.me ? l.sent.indexOf(JSON.stringify(msg.mutations)) : -1;
          if (at >= 0) l.sent.splice(at, 1);
          if (at < 0 && !(msg.by === opened.me && opened.me.startsWith("guest:"))) handle.current?.apply(msg.mutations as never);
          l.rev = Math.max(l.rev, msg.rev);
        } else if (msg.t === "ack") {
          setRefused(null);
          l.rev = Math.max(l.rev, msg.rev);
          l.inflight = false;
          flush();
        } else if (msg.t === "refused") {
          // The grid has an edit the sheet did not take: the sheet as it is replaces it, and the line says why the typed value went.
          setRefused({ why: refusedWords(msg.reason ?? "") });
          // That answer settles the batch: the close below is the reload, not a lost edit.
          l.inflight = false;
          l.pending = [];
          l.rev = -1;
          ws.close(1000);
        }
      };
      ws.onclose = (e) => {
        if (l.ws === ws) l.ws = null;
        // An edit sent and not yet answered, or still waiting to go, is not on the sheet: say so, and take the sheet's own copy back.
        if (l.inflight || l.pending.length) {
          setRefused({ why: refusedWords("lost") });
          l.pending = [];
          if (l.timer) clearTimeout(l.timer);
          l.timer = null;
          l.rev = -1;
        }
        l.inflight = false;
        if (stopped) return;
        setOffline(true);
        if (e.code === 4403) return onGone();
        // 4401: the token ran out; anything else: the line dropped. Either way, again with a fresh token.
        again(e.code === 4401 ? 0 : undefined);
      };
    };
    void connect();
    return () => {
      stopped = true;
      l.ws?.close(1000);
    };
  }, [session, opened, onGone, onDown]);

  // One batch in flight at a time, each from the revision the last one was acknowledged at.
  function flush(): void {
    const l = live.current;
    l.timer = null;
    if (l.inflight || !l.ws || l.ws.readyState !== WebSocket.OPEN || !l.pending.length) return;
    l.inflight = true;
    const mutations = l.pending.splice(0, 500);
    l.sent = [...l.sent.slice(-20), JSON.stringify(mutations)];
    l.ws.send(JSON.stringify({ t: "ops", id: ++l.n, baseRev: l.rev, mutations }));
  }

  if (!book) return <SheetBones />;
  return (
    <>
      {offline ? (
        <div role="status" data-sheet-offline="" className="flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[13px] leading-5">
          <StatusMark state="working" word="Reconnecting" detail="Read only until the sheet is back" className="min-w-0 flex-1" />
        </div>
      ) : null}
      {refused ? (
        <div role="alert" data-sheet-refused="" className="flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[13px] leading-5">
          <StatusMark state="failed" word="Edit not saved" detail={refused.why ?? undefined} className="min-w-0 flex-1" />
        </div>
      ) : null}
      <SheetCanvas
        key={book.key}
        snapshot={book.snapshot as never}
        readOnly={opened.role !== "edit" || offline}
        onReady={(h) => {
          handle.current = h;
          if (!h || opened.role !== "edit") return;
          h.onMutation((m) => {
            const l = live.current;
            // The sheet's own mutations only: the grid's cell editor runs a document of its own, and its steps are not the sheet's.
            const p = (m as unknown as Mutation).params as { unitId?: unknown };
            if (!m.id.startsWith("sheet.mutation.") || p?.unitId !== l.unit) return;
            // An edit made while the line is down cannot reach the sheet: it is not kept, it is said, and the sheet's copy comes back on reconnect.
            if (!l.ws || l.ws.readyState !== WebSocket.OPEN) {
              setRefused({ why: refusedWords("lost") });
              l.rev = -1;
              return;
            }
            l.pending.push(plainCells(m as unknown as Mutation));
            l.timer ??= setTimeout(flush, EDIT_WAIT);
          });
        }}
        className="min-h-0 flex-1"
      />
    </>
  );
}

/**
 * A typed cell as the service takes a guest's: a value, a formula, a style, a type. The grid's
 * editor hands back rich text (`p`) for what was typed; its words become the value, a number
 * when they read as one.
 */
export function plainCells(m: Mutation): Mutation {
  if (m.id !== "sheet.mutation.set-range-values") return m;
  const cells = (m.params.cellValue ?? {}) as Record<string, Record<string, Record<string, unknown> | null>>;
  const out: typeof cells = {};
  for (const [r, cols] of Object.entries(cells)) {
    out[r] = {};
    for (const [c, cell] of Object.entries(cols ?? {})) {
      if (!cell || !("p" in cell) || cell.v != null || cell.f != null) {
        out[r]![c] = cell;
        continue;
      }
      const { p, ...rest } = cell as { p?: { body?: { dataStream?: string } } };
      const words = (p?.body?.dataStream ?? "").replace(/\r?\n$/, "").replace(/\r/g, "");
      const n = words.trim() !== "" && Number.isFinite(Number(words)) ? Number(words) : null;
      out[r]![c] = { ...rest, v: n ?? words, ...(n !== null ? { t: 2 } : { t: 1 }) };
    }
  }
  return { ...m, params: { ...m.params, cellValue: out } };
}

function SheetBones() {
  return (
    <div className="flex flex-col gap-2 p-4" aria-busy="true">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-7" style={{ width: `${88 - (i % 3) * 14}%` }} />
      ))}
    </div>
  );
}
