import type { DocMode, DocOpen, DocsPush, DocThreadOp, DocThreadRow, DocToken } from "@shared/contract-work-docs";
import type { CanvasSource } from "@shared/work";
import { registry } from "../../lib/connection";

/**
 * The host's side of a document, as the canvas and a project's page use it
 * (src/shared/contract-work-docs.ts; the host's work/docs). Every call names
 * the source, and goes to the host the thread or view lives on; a LifeOS
 * document another host serves is opened on that host's link instead
 * (`servedBy`).
 */

export interface DocHost {
  env: string;
  open(): Promise<DocOpen>;
  token(): Promise<DocToken>;
  threads(): Promise<{ rows: DocThreadRow[]; names: Record<string, string> }>;
  thread<T = unknown>(change: DocThreadOp): Promise<T>;
  mode(mode: DocMode): Promise<DocOpen>;
  dismiss(): Promise<void>;
  /**
   * The agent's write line's Undo, for the write the line shows (its `after`): `undone`, `changed` (the document moved
   * on, or the host holds another write's line), or `unknown` (a host a release behind that cannot undo it there).
   */
  undo(after: string): Promise<"undone" | "changed" | "unknown">;
  rename(title: string): Promise<void>;
  /** A pushed change to this document (named by the service's name for it). */
  onPush(doc: string, listener: (push: DocsPush) => void): () => void;
  /** The class the editor's provider makes its socket with: the relay over this link. */
  socket: new (url: string) => WebSocket;
  /**
   * Every frame the editor has sent goes up, and the host has its service store the document: the close of a tab
   * awaits it (canvas/flush.ts), so whatever judges the file after (a Word file's document he only looked at) reads it
   * as he left it. No socket open: nothing waits.
   */
  flush(): Promise<void>;
}

/** The host that serves a LifeOS document, from the refusal of one that does not ("served elsewhere: env_box"). */
export function servedBy(err: unknown): string | null {
  const words = err instanceof Error ? err.message : String(err);
  const m = /served elsewhere: (\S+)/.exec(words) ?? /this host does not serve LifeOS documents; (\S+) does,/.exec(words);
  return m ? m[1]! : null;
}

export function docHost(env: string, source: CanvasSource): DocHost {
  const link = () => registry.linkOf(env);
  const call = <T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> =>
    link().request<T>(method, { source, ...params }, timeoutMs ? { timeoutMs } : undefined);
  const socket = relaySocket(env, source);
  return {
    env,
    open: () => call("work.docs.open"),
    token: () => call("work.docs.token"),
    threads: () => call("work.docs.threads"),
    thread: (change) => call("work.docs.thread", { change }),
    mode: (mode) => call("work.docs.mode", { mode }),
    dismiss: async () => void (await call("work.docs.dismiss")),
    undo: async (after) => {
      const got = await call<{ undone?: boolean }>("work.docs.dismiss", { undo: true, after });
      return got.undone === undefined ? "unknown" : got.undone ? "undone" : "changed";
    },
    rename: async (title) => void (await call("work.docs.rename", { title })),
    onPush: (doc, listener) =>
      link().onPush((push) => {
        if (push.push === "work.docs" && push.doc === doc) listener(push);
      }),
    socket,
    flush: () => storedAll(socket),
  };
}

const READY = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(data: string): ArrayBuffer {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes.buffer;
}

/**
 * What a relayed frame is, read from its head as Hocuspocus writes it: the document's address (a lib0 varString),
 * the message type, and for a sync message its step. Null for bytes that are not one (a test's, a damaged frame).
 */
export function frameHead(bytes: Uint8Array): { type: number; step: number | null; value: number | null } | null {
  let at = 0;
  const varUint = (): number | null => {
    let n = 0;
    for (let shift = 0; at < bytes.length && shift < 35; shift += 7) {
      const b = bytes[at++]!;
      n += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return n;
    }
    return null;
  };
  const length = varUint();
  if (length === null || at + length > bytes.length) return null;
  at += length;
  const type = varUint();
  if (type === null) return null;
  const next = at < bytes.length ? varUint() : null;
  // Sync (0) and SyncReply (4) carry a step; SyncStatus (8) carries whether the update was applied.
  return { type, step: type === 0 || type === 4 ? next : null, value: type === 8 ? next : null };
}

/** How long a close's flush waits for a socket to send its state and hear it applied. */
export const relayTiming = { syncWaitMs: 6000 };

/** Said when the host refused an edit the window sent (a view the host holds read only). */
export const NOT_TAKEN = "The host did not take the last edits to this document";

/** The sockets each relayed class has open, and the last frames one lost (a failed send, a close with frames unsent). */
type Relayed = {
  open: Set<{ stored(): Promise<void> }>;
  lost: Error | null;
  /** The last socket was dropped (by the host, a failure), not closed by its own side: the provider makes another. */
  dropped: boolean;
  /** Told when the provider's next socket is made. */
  arrived: Set<() => void>;
};
const relayedOf = new WeakMap<object, Relayed>();

/** Said when the window has no connection to tell the host what it typed: the flush fails, never passes. */
export const NOT_SENT = "The document is not connected, so its last edits have not reached the host";

/**
 * Each open socket of the class sends what waits and has the host store the document. It fails when a send or the
 * store fails, when a socket is not connected, and when frames were lost since the last store it confirmed: what the
 * editor holds then is in this window alone, and the close is told so.
 */
export async function storedAll(socket: new (url: string) => WebSocket): Promise<void> {
  const relayed = relayedOf.get(socket);
  if (!relayed) return;
  const lost = relayed.lost;
  // Between the provider's sockets, what he typed waits in the window: the next socket is waited for, and its state.
  if (!relayed.open.size && (relayed.dropped || lost)) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        relayed.arrived.delete(done);
        resolve();
      };
      const timer = setTimeout(done, relayTiming.syncWaitMs);
      relayed.arrived.add(done);
    });
    if (!relayed.open.size) throw lost ?? new Error(NOT_SENT);
  }
  await Promise.all([...relayed.open].map((s) => s.stored()));
  if (lost && relayed.lost === lost) relayed.lost = null;
  relayed.dropped = false;
}

/**
 * A WebSocket-shaped class whose socket lives on the host (work/docs/relay.ts): `connect` opens it
 * there, frames go up in order through `send`, and a long `recv` brings the host's frames down. The
 * provider sees an ordinary socket: open, message, close, error. A close sends what still waits
 * first, then closes the host's socket behind it: the last words typed are never dropped.
 */
export function relaySocket(env: string, source: CanvasSource): new (url: string) => WebSocket {
  const link = () => registry.linkOf(env);
  const relayed: Relayed = { open: new Set(), lost: null, dropped: false, arrived: new Set() };
  const open = relayed.open;
  class RelaySocket extends EventTarget {
    static readonly CONNECTING = READY.CONNECTING;
    static readonly OPEN = READY.OPEN;
    static readonly CLOSING = READY.CLOSING;
    static readonly CLOSED = READY.CLOSED;
    readonly url: string;
    binaryType: BinaryType = "arraybuffer";
    readyState: number = READY.CONNECTING;
    private id: string | null = null;
    private outbox: string[] = [];
    private sending: Promise<void> | null = null;
    /** Closed by its own side: what waits still goes up before the host's socket closes. */
    private closing = false;
    /** A send the host did not take: the frames it carried are lost to this socket. */
    private failed: Error | null = null;
    /**
     * The service answers every update a socket sends with a SyncStatus once it has applied it (Hocuspocus's
     * MessageReceiver): `unacked` counts the updates still waiting for theirs. `stateSent`: this socket has sent its
     * SyncStep2, the window's own state the host lacked, which a new socket owes before anything it holds is there.
     */
    private unacked = 0;
    private stateSent = false;
    /** How many updates this socket has sent: one sent while a store is made may not be in it. */
    private sentCount = 0;
    private waiters = new Set<() => void>();
    private settle(): void {
      for (const done of this.waiters) done();
    }

    constructor(url: string) {
      super();
      this.url = url;
      open.add(this);
      for (const told of relayed.arrived) told();
      void this.start();
    }

    private async start(): Promise<void> {
      try {
        // The provider says the schema it knows in its socket's address; the relay carries it to the host's own socket.
        const schema = Number(new URL(this.url, "ws://relay").searchParams.get("schema")) || 0;
        const { socket } = await link().request<{ socket: string }>("work.docs.connect", { source, ...(schema > 0 ? { schema } : {}) });
        if (this.readyState !== READY.CONNECTING) return void link().request("work.docs.close", { socket }).catch(() => undefined);
        this.id = socket;
        this.readyState = READY.OPEN;
        this.dispatchEvent(new Event("open"));
        this.settle();
        void this.flush();
        while (this.readyState === READY.OPEN) {
          const got = await link().request<{ frames: string[]; closed?: { code: number; reason: string } }>("work.docs.recv", { socket }, { timeoutMs: 45_000 });
          for (const frame of got.frames) {
            if (this.readyState !== READY.OPEN) return;
            const data = fromBase64(frame);
            this.heard(new Uint8Array(data));
            this.dispatchEvent(new MessageEvent("message", { data }));
          }
          if (got.closed) return this.finish(got.closed.code, got.closed.reason);
        }
      } catch (err) {
        if (this.readyState === READY.CLOSED) return;
        this.dispatchEvent(new Event("error"));
        this.finish(1006, err instanceof Error ? err.message : String(err));
      }
    }

    /** Sends what waits, in order; one send at a time, and what is added meanwhile goes in the same run. */
    private flush(): Promise<void> {
      if (!this.id) return Promise.resolve();
      this.sending ??= this.drain().finally(() => {
        this.sending = null;
        this.settle();
        if (this.outbox.length > 0 && (this.readyState === READY.OPEN || this.closing)) void this.flush();
      });
      return this.sending;
    }

    private async drain(): Promise<void> {
      try {
        while (this.outbox.length > 0 && (this.readyState === READY.OPEN || this.closing)) {
          const frames = this.outbox.splice(0, 200);
          await link().request("work.docs.send", { socket: this.id, frames });
        }
      } catch (err) {
        this.failed = err instanceof Error ? err : new Error(String(err));
        relayed.lost = this.failed;
        if (this.readyState === READY.CLOSED) return;
        this.dispatchEvent(new Event("error"));
        this.finish(1006, this.failed.message);
      }
    }

    /** A frame from the host: a SyncStatus says one update this socket sent is applied there, or was refused. */
    private heard(bytes: Uint8Array): void {
      const head = frameHead(bytes);
      if (head?.type !== 8) return;
      if (head.value === 1) this.unacked = Math.max(0, this.unacked - 1);
      else relayed.lost = this.failed = new Error(NOT_TAKEN);
      this.settle();
    }

    /** Every update this socket sent is applied by the service, its own state among them: nothing it holds waits. */
    private applied(): boolean {
      return this.readyState === READY.OPEN && this.stateSent && this.unacked === 0 && this.outbox.length === 0 && !this.sending;
    }

    /**
     * What waits goes up, and the service applies it, then the host stores the document and answers. A socket still
     * connecting, or one that has not yet sent its own state, is waited for; one that does not get there in time, or
     * closes, fails the flush: what the window holds has then not reached the host.
     */
    async stored(): Promise<void> {
      const deadline = Date.now() + relayTiming.syncWaitMs;
      for (;;) {
        await this.flush();
        if (this.failed) throw this.failed;
        if (this.readyState === READY.CLOSED || this.readyState === READY.CLOSING) throw new Error(NOT_SENT);
        if (this.applied()) {
          const at = this.sentCount;
          await link().request("work.docs.send", { socket: this.id, frames: [], stored: true });
          // An update sent while the host stored may not be in what it stored: it is applied and stored in its turn.
          if (this.sentCount === at) return;
          if (Date.now() > deadline) throw new Error(NOT_SENT);
          continue;
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(NOT_SENT);
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            this.waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, left);
          this.waiters.add(done);
        });
      }
    }

    send(data: ArrayBufferLike | ArrayBufferView): void {
      if (this.readyState !== READY.OPEN) return;
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      // An update or the socket's own state (sync steps 2 and 3) is answered with a SyncStatus once applied.
      const head = frameHead(bytes);
      if ((head?.type === 0 || head?.type === 4) && (head.step === 1 || head.step === 2)) {
        this.unacked++;
        this.sentCount++;
        if (head.step === 1) this.stateSent = true;
      }
      this.outbox.push(toBase64(bytes));
      void this.flush();
    }

    close(code = 1000, reason = ""): void {
      if (this.readyState === READY.CLOSED) return;
      const id = this.id;
      if (id) {
        // Frames still waiting behind a send in flight go up first: the host's socket closes behind them.
        this.closing = true;
        void this.flush()
          .then(() => link().request("work.docs.close", { socket: id }))
          .catch(() => undefined);
      }
      this.finish(code, reason);
    }

    private finish(code: number, reason: string): void {
      if (this.readyState === READY.CLOSED) return;
      this.readyState = READY.CLOSED;
      open.delete(this);
      // Closed by the host or a failure with frames still waiting, or sent and never heard applied: they may not have
      // reached it from this socket. The provider's next socket sends the window's state again.
      if ((this.outbox.length > 0 || this.unacked > 0) && !this.closing) relayed.lost ??= new Error(NOT_SENT);
      // Not closed by its own side: the provider makes another socket, and what he types meanwhile waits for it.
      if (!this.closing) relayed.dropped = true;
      this.settle();
      // A plain event with a close's fields: what the provider reads, wherever CloseEvent is missing.
      this.dispatchEvent(Object.assign(new Event("close"), { code, reason, wasClean: code === 1000 }));
    }
  }
  relayedOf.set(RelaySocket, relayed);
  return RelaySocket as unknown as new (url: string) => WebSocket;
}
