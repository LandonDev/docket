import { useEffect, useRef, useState } from "react";
import { SheetCanvas, type SheetHandle } from "work-kit/sheet";
import { Skeleton } from "@renderer/components/ui/skeleton";
import type { Opened, Session } from "./session";

/**
 * A sheet on the hosted page: the owner's grid (work-kit/sheet) on the live
 * sheet socket (docs/agents/work-sheets.md "Live editing"). An edit link's
 * cell edits go as ops from the revision the grid stands at; everyone's ops
 * come back, and a refused one reloads the workbook. A view link is the grid
 * read only. The service holds a guest to values, formats and rows.
 */

type Mutation = { id: string; params: Record<string, unknown> };
type Incoming = { t: "state"; rev: number; snapshot: Record<string, unknown> } | { t: "ops"; rev: number; by: string; mutations: Mutation[] } | { t: "ack"; id: number; rev: number } | { t: "refused"; id: number; reason: string };

const EDIT_WAIT = 150;

export function SheetPage({ session, opened, onGone, onDown }: { session: Session; opened: Opened; onGone(): void; onDown(): void }) {
  const [book, setBook] = useState<{ snapshot: Record<string, unknown>; key: number } | null>(null);
  const handle = useRef<SheetHandle | null>(null);
  const live = useRef<{ ws: WebSocket | null; rev: number; pending: Mutation[]; sent: string[]; timer: ReturnType<typeof setTimeout> | null; n: number }>({ ws: null, rev: -1, pending: [], sent: [], timer: null, n: 0 });

  useEffect(() => {
    let stopped = false;
    let tries = 0;
    const l = live.current;
    const connect = async (): Promise<void> => {
      let token: string;
      try {
        token = (await session.token()).token;
      } catch {
        return stopped ? undefined : onGone();
      }
      if (stopped) return;
      const ws = new WebSocket(session.socketUrl(opened));
      l.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ t: "hello", token }));
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as Incoming;
        tries = 0;
        if (msg.t === "state") {
          // A reconnect that finds the sheet where the grid stands keeps the grid as it is.
          if (msg.rev !== l.rev || !handle.current) setBook({ snapshot: msg.snapshot, key: msg.rev * 1000 + ++l.n });
          l.rev = msg.rev;
        } else if (msg.t === "ops") {
          // Our own ops come back too. A guest's principal is its link's alone; the owner has other windows, so his are known by what was sent.
          const at = msg.by === opened.me ? l.sent.indexOf(JSON.stringify(msg.mutations)) : -1;
          if (at >= 0) l.sent.splice(at, 1);
          if (at < 0 && !(msg.by === opened.me && opened.me.startsWith("guest:"))) handle.current?.apply(msg.mutations as never);
          l.rev = Math.max(l.rev, msg.rev);
        } else if (msg.t === "ack") l.rev = Math.max(l.rev, msg.rev);
        else if (msg.t === "refused") {
          // The grid has an edit the sheet did not take: the sheet as it is replaces it.
          l.rev = -1;
          ws.close(1000);
        }
      };
      ws.onclose = (e) => {
        if (l.ws === ws) l.ws = null;
        if (stopped) return;
        if (e.code === 4403) return onGone();
        if (++tries > 5) return onDown();
        // 4401: the token ran out; anything else: the line dropped. Either way, again with a fresh token.
        setTimeout(() => void connect(), e.code === 4401 ? 0 : Math.min(8000, 500 * 2 ** tries));
      };
    };
    void connect();
    return () => {
      stopped = true;
      l.ws?.close(1000);
    };
  }, [session, opened, onGone, onDown]);

  const flush = (): void => {
    const l = live.current;
    l.timer = null;
    if (!l.ws || l.ws.readyState !== WebSocket.OPEN || !l.pending.length) return;
    const mutations = l.pending.splice(0, 500);
    l.sent = [...l.sent.slice(-20), JSON.stringify(mutations)];
    l.ws.send(JSON.stringify({ t: "ops", id: ++l.n, baseRev: l.rev, mutations }));
    if (l.pending.length) l.timer = setTimeout(flush, EDIT_WAIT);
  };

  if (!book) return <SheetBones />;
  return (
    <SheetCanvas
      key={book.key}
      snapshot={book.snapshot as never}
      readOnly={opened.role !== "edit"}
      onReady={(h) => {
        handle.current = h;
        if (!h || opened.role !== "edit") return;
        h.onMutation((m) => {
          const l = live.current;
          l.pending.push(m as unknown as Mutation);
          l.timer ??= setTimeout(flush, EDIT_WAIT);
        });
      }}
      className="min-h-0 flex-1"
    />
  );
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
