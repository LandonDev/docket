import type { DocMode, DocOpen, DocReady, DocsPush, DocThreadOp, DocThreadRow, DocToken } from "@shared/contract-work-docs";
import type { CanvasSource } from "@shared/work";
import * as Y from "yjs";
import { registry } from "../../lib/connection";
import { PAUSE_MS } from "../canvas/calm";

/**
 * The host's side of a document, as the canvas and a project's page use it
 * (src/shared/contract-work-docs.ts; the host's work/docs). Every call names
 * the source, and goes to the host the thread or view lives on; a LifeOS
 * document another host serves is opened on that host's link instead
 * (`servedBy`).
 */

export interface DocHost {
  env: string;
  /** The item a mail's attachment is named by, alongside its source (`namedBy`); absent for every other document. */
  itemId?: string;
  /**
   * `ready`: the host makes the editor's socket (for the schema the editor knows) and its first token in the same answer
   * (`work.docs.open {ready}`), which `token` and the socket class then use once, so the open needs no `connect` and
   * no `token` of its own.
   */
  open(ready?: { schema: number }): Promise<DocOpen>;
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
  /** Wait for the service to apply this window’s edits before it reads the document for export. */
  sync(): Promise<void>;
  /** Where the updates the service has not said it applied are kept on this computer (canvas/drafts.ts); absent in a stand-in. */
  keepDrafts?(journal: { keep(frames: string[]): void; clear(): void } | null): void;
  /**
   * A kept draft's updates, sent again up the open socket as his edits are (the host's door judges them as any) and laid
   * on the editor's document: Yjs merges them, so nothing newer is written over. `later` with no socket open to take
   * them (or none that has heard what the service holds); `changed`, nothing sent, where they hang from text the
   * document no longer has (it was made again since: a Word file imported again, a whole-text write, a History restore),
   * which Yjs would park unseen.
   */
  replay?(frames: string[]): "sent" | "later" | "changed";
}

/** The host that serves a LifeOS document, from the refusal of one that does not ("served elsewhere: env_box"). */
export function servedBy(err: unknown): string | null {
  const words = err instanceof Error ? err.message : String(err);
  const m = /served elsewhere: (\S+)/.exec(words) ?? /this host does not serve LifeOS documents; (\S+) does,/.exec(words);
  return m ? m[1]! : null;
}

/**
 * What every call names: the source, and for a mail's or a chat's attachment the item that shows it, so the host finds
 * the document it read the file into by the item (work/docs/target.ts `attachmentPathOf`) and no path of its data
 * directory crosses the wire.
 */
export const namedBy = (source: CanvasSource, itemId?: string): { source: CanvasSource; itemId?: string } => (source.at === "mail" && itemId ? { source, itemId } : { source });

export function docHost(env: string, source: CanvasSource, itemId?: string): DocHost {
  const link = () => registry.linkOf(env);
  const named = namedBy(source, itemId);
  const call = <T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> =>
    link().request<T>(method, { ...named, ...params }, timeoutMs ? { timeoutMs } : undefined);
  const socket = relaySocket(env, source, itemId);
  /** The token the open came with, used by the first ask for one while it has a while to run. */
  let minted: DocToken | null = null;
  return {
    env,
    ...(named.itemId ? { itemId: named.itemId } : {}),
    open: async (ready) => {
      if (!ready) return call("work.docs.open");
      // (its frames pushed to this window, where the host can: perf M11)
      const { ready: made, ...open } = await call<DocOpen & { ready?: DocReady }>("work.docs.open", { ready: { ...ready, push: true } });
      if (made) {
        minted = made.token;
        handOver(socket, { socket: made.socket, schema: made.schema ?? 0, ...(made.push ? { push: true } : {}) });
      }
      return open;
    },
    token: () => {
      const got = minted;
      minted = null;
      return got && got.expiresAt - Date.now() > MINTED_LEFT_MS ? Promise.resolve(got) : call("work.docs.token");
    },
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
    flush: () => storedAll(socket).then(() => undefined),
    sync: () => settleAll(socket, false).then(() => undefined),
    keepDrafts: (journal) => {
      const relayed = relayedOf.get(socket);
      if (relayed) relayed.journal = journal;
    },
    replay: (frames) => {
      const live = [...(relayedOf.get(socket)?.open ?? [])].find((s) => s.ready());
      const served = live?.served();
      if (!live || !served) return "later";
      if (!draftFits(frames, served)) return "changed";
      live.inject(frames);
      return "sent";
    },
  };
}

/**
 * An update frame the window sent (Sync or SyncReply carrying SyncStep2 or an Update), as a plain Update frame of the
 * same document: what a socket sends again, and what the editor's provider takes in as the service's. Null for any other.
 */
export function asUpdate(bytes: Uint8Array): Uint8Array | null {
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
  const name = bytes.subarray(0, at);
  const type = varUint();
  const step = varUint();
  if ((type !== 0 && type !== 4) || (step !== 1 && step !== 2) || at >= bytes.length) return null;
  const out = new Uint8Array(name.length + 2 + (bytes.length - at));
  out.set(name, 0);
  out[name.length] = 0;
  out[name.length + 1] = 2;
  out.set(bytes.subarray(at), name.length + 2);
  return out;
}

/** A Sync or SyncReply frame's step and the bytes it carries (a state vector for step 0, an update for 1 and 2); null for any other. */
export function syncPayload(bytes: Uint8Array): { step: number; payload: Uint8Array } | null {
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
  const name = varUint();
  if (name === null) return null;
  at += name;
  const type = varUint();
  const step = varUint();
  const length = varUint();
  if ((type !== 0 && type !== 4) || step === null || step > 2 || length === null || at + length > bytes.length) return null;
  return { step, payload: bytes.subarray(at, at + length) };
}

/**
 * Whether a kept draft's updates (Update frames, base64) take on the document the service holds (`served`, its state
 * vector): each struct they add follows on from what it has of that writer, and each one they hang from (an origin, a
 * parent) is there or in the draft. A document made again since lacks them, and Yjs would hold the draft unseen.
 */
export function draftFits(frames: readonly string[], served: ReadonlyMap<number, number>): boolean {
  try {
    const updates = frames.map((frame) => syncPayload(new Uint8Array(fromBase64(frame)))?.payload);
    if (!updates.length || updates.some((u) => !u)) return false;
    const merged = Y.mergeUpdates(updates as Uint8Array[]);
    const { from, to } = Y.parseUpdateMeta(merged);
    for (const [client, clock] of from) if ((served.get(client) ?? 0) < clock) return false;
    const there = (id: Y.ID | null | string | undefined): boolean =>
      !id || typeof id === "string" || id.clock < (served.get(id.client) ?? 0) || (id.clock >= (from.get(id.client) ?? Infinity) && id.clock < (to.get(id.client) ?? 0));
    return Y.decodeUpdate(merged).structs.every((struct) => !(struct instanceof Y.Item) || (there(struct.origin) && there(struct.rightOrigin) && there(struct.parent as Y.ID | string | null)));
  } catch {
    return false;
  }
}

/** The words a kept draft typed, in the order they were typed: what Copy Edits puts on the clipboard. */
export function draftWords(frames: readonly string[]): string {
  try {
    const updates = frames.map((frame) => syncPayload(new Uint8Array(fromBase64(frame)))?.payload).filter((u): u is Uint8Array => !!u);
    return Y.decodeUpdate(Y.mergeUpdates(updates))
      .structs.map((struct) => (struct instanceof Y.Item && struct.content instanceof Y.ContentString ? struct.content.str : ""))
      .join("");
  } catch {
    return "";
  }
}

const READY = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;
/** A token the open came with is used only while it has at least this long to run. */
const MINTED_LEFT_MS = 10_000;

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
/** `storePauseMs`: how long after his last edit the window asks the service to store the document (its own store waits as long). */
export const relayTiming = { syncWaitMs: 6000, storePauseMs: PAUSE_MS.document as number };

/** Said when the host refused an edit the window sent (a view the host holds read only). */
export const NOT_TAKEN = "The host did not take the last edits to this document";

/** The sockets each relayed class has open, and the last frames one lost (a failed send, a close with frames unsent). */
/**
 * What a document's save line reads (DocumentCanvas `useDocSaved`), as this window's sockets know it: `edited`, when
 * his last edit not yet in a store went up; `asked`, when a store of it was asked and not answered; `storedAt`, the
 * service's own time for the last store it confirmed (work.docs.send `stored`); `failed`, a store it refused, in its
 * words, until one lands.
 */
export interface DocSaves {
  edited: number | null;
  asked: number | null;
  storedAt: number | null;
  failed: string | null;
}
export const NO_SAVES: DocSaves = { edited: null, asked: null, storedAt: null, failed: null };


type Relayed = {
  open: Set<{ settled(store: boolean): Promise<number | null>; ready(): boolean; served(): ReadonlyMap<number, number> | null; inject(frames: string[]): void }>;
  /** where the updates not yet applied there are kept on this computer, and those updates (`asUpdate` frames, base64) */
  journal?: { keep(frames: string[]): void; clear(): void } | null;
  pending: string[];
  lost: Error | null;
  /** The last socket was dropped (by the host, a failure), not closed by its own side: the provider makes another. */
  dropped: boolean;
  /** Told when the provider's next socket is made. */
  arrived: Set<() => void>;
  /** A socket the host made with the open (`work.docs.open {ready}`), for the class's next socket of that schema, once. */
  premade: { socket: string; schema: number; push?: true } | null;
  saves: DocSaves;
  told: Set<(saves: DocSaves) => void>;
  /** his updates sent up any socket of the class: a store answers for the edits counted before it was asked */
  edits: number;
  /** of those, how many a store the service confirmed holds */
  covered: number;
  storeTimer: ReturnType<typeof setTimeout> | null;
  /** Retry on a refused store: asks again now */
  retry?: () => void;
};
const relayedOf = new WeakMap<object, Relayed>();

/**
 * Hands the class a socket the host made with the open: its next socket for that schema takes it instead of asking
 * `work.docs.connect`. One it does not take (another schema) is closed on the host. Unused, the host closes it when idle.
 */
export function handOver(socket: new (url: string) => WebSocket, made: { socket: string; schema: number; push?: true }): void {
  const relayed = relayedOf.get(socket);
  if (relayed) relayed.premade = made;
}

/** Said when the window has no connection to tell the host what it typed: the flush fails, never passes. */
export const NOT_SENT = "The document is not connected, so its last edits have not reached the host";

/**
 * Each open socket of the class sends what waits and has the host store the document. It fails when a send or the
 * store fails, when a socket is not connected, and when frames were lost since the last store it confirmed: what the
 * editor holds then is in this window alone, and the close is told so.
 */
export function storedAll(socket: new (url: string) => WebSocket): Promise<number | null> {
  const relayed = relayedOf.get(socket);
  return settleAll(socket, true).then((at) => {
    if (relayed && at !== null) said(relayed, { storedAt: at, failed: null, ...(relayed.covered >= relayed.edits ? { edited: null } : {}) });
    return at;
  });
}

/** The save facts as they now stand, told to whoever listens. */
function said(relayed: Relayed, patch: Partial<DocSaves>): void {
  relayed.saves = { ...relayed.saves, ...patch };
  for (const tell of relayed.told) tell(relayed.saves);
}

/** The class's save facts, and every change of them; a class this module did not make has none. */
export function savesOf(socket: new (url: string) => WebSocket): { now(): DocSaves; listen(tell: (saves: DocSaves) => void): () => void; retry(): void } {
  const relayed = relayedOf.get(socket);
  return {
    now: () => relayed?.saves ?? NO_SAVES,
    retry: () => relayed?.retry?.(),
    listen: (tell) => {
      relayed?.told.add(tell);
      return () => void relayed?.told.delete(tell);
    },
  };
}

/** Answers the newest time the service stored the document at for these sockets; null when none was asked to store. */
async function settleAll(socket: new (url: string) => WebSocket, store: boolean): Promise<number | null> {
  const relayed = relayedOf.get(socket);
  if (!relayed) return null;
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
  const stored = await Promise.all([...relayed.open].map((s) => s.settled(store)));
  if (lost && relayed.lost === lost) relayed.lost = null;
  relayed.dropped = false;
  const times = stored.filter((at): at is number => at !== null);
  return times.length ? Math.max(...times) : null;
}

/**
 * A WebSocket-shaped class whose socket lives on the host (work/docs/relay.ts): `connect` opens it
 * there, frames go up in order through `send`, and a long `recv` brings the host's frames down. The
 * provider sees an ordinary socket: open, message, close, error. A close sends what still waits
 * first, then closes the host's socket behind it: the last words typed are never dropped.
 */
export function relaySocket(env: string, source: CanvasSource, itemId?: string): new (url: string) => WebSocket {
  const link = () => registry.linkOf(env);
  const relayed: Relayed = { open: new Set(), lost: null, dropped: false, arrived: new Set(), premade: null, pending: [], saves: NO_SAVES, told: new Set(), edits: 0, covered: 0, storeTimer: null };
  const open = relayed.open;
  /**
   * A pause in his edits asks the service to store what he typed, so the save line names a store it confirmed. With no
   * socket ready (offline, between sockets) it asks again after another pause: the line says nothing new meanwhile.
   */
  const storeLater = (wait = relayTiming.storePauseMs): void => {
    if (relayed.storeTimer) clearTimeout(relayed.storeTimer);
    relayed.storeTimer = setTimeout(() => {
      relayed.storeTimer = null;
      // No socket at all: the provider's next one asks again as it opens (its constructor).
      if (!open.size) return;
      // A store already out holds every edit sent before it answers (`settled` asks again for any sent meanwhile).
      if (relayed.saves.asked !== null) return;
      // Nothing of his since the last store it confirmed: there is nothing to ask for.
      if (relayed.covered >= relayed.edits) return;
      if (![...open].some((s) => s.ready())) return storeLater();
      said(relayed, { asked: Date.now() });
      settleAll(RelaySocket as unknown as new (url: string) => WebSocket, true).then(
        (at) => {
          // Edits sent after the store was asked are not in it: they keep the line waiting, and go in the next.
          const all = relayed.covered >= relayed.edits;
          said(relayed, { asked: null, failed: null, ...(at !== null ? { storedAt: at } : {}), ...(all ? { edited: null } : {}) });
          if (!all) storeLater();
        },
        (err: unknown) => {
          // Not connected: the editor's own line says offline; the store is asked again once a socket is back.
          if (err instanceof Error && err.message === NOT_SENT) {
            said(relayed, { asked: null });
            return storeLater();
          }
          said(relayed, { asked: null, failed: err instanceof Error ? err.message : String(err) });
        },
      );
    }, wait);
  };
  relayed.retry = () => storeLater(0);
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
    /** What the service holds, as this socket heard it: its SyncStep1's state vector, grown by each update it sent down. */
    private holds: Map<number, number> | null = null;
    /** How many updates this socket has sent: one sent while a store is made may not be in it. */
    private sentCount = 0;
    private waiters = new Set<() => void>();
    private settle(): void {
      for (const done of this.waiters) done();
      // Everything sent is applied there: nothing of his waits on this computer any more.
      if (relayed.pending.length > 0 && this.applied()) {
        relayed.pending = [];
        relayed.journal?.clear();
      }
    }

    /** Open, with its own state sent: a draft's updates may go up it. */
    ready(): boolean {
      return this.readyState === READY.OPEN && this.stateSent;
    }

    /** What the service holds, once it has said (its SyncStep1); null before. */
    served(): ReadonlyMap<number, number> | null {
      return this.holds;
    }

    /** A kept draft's updates: each sent up as his edits are, and handed to the provider as the service's, so the editor shows it. */
    inject(frames: string[]): void {
      for (const frame of frames) {
        const data = fromBase64(frame);
        this.send(new Uint8Array(data));
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }

    constructor(url: string) {
      super();
      this.url = url;
      open.add(this);
      for (const told of relayed.arrived) told();
      if (relayed.saves.edited !== null && !relayed.storeTimer) storeLater();
      void this.start();
    }

    private async start(): Promise<void> {
      try {
        // The provider says the schema it knows in its socket's address; the relay carries it to the host's own socket.
        const schema = Number(new URL(this.url, "ws://relay").searchParams.get("schema")) || 0;
        // The socket the host made with the open is this one's, when it was made for the same schema; else it is closed.
        const premade = relayed.premade;
        relayed.premade = null;
        if (premade && premade.schema !== schema) void link().request("work.docs.close", { socket: premade.socket }).catch(() => undefined);
        // (awaited even when made: the provider listens to the socket only once its constructor has returned)
        // Its frames are asked to come as pushes (`work.docs.frames`); a host a release behind answers no `push`, and they come by `recv`.
        const { socket, push } =
          premade && premade.schema === schema ? await Promise.resolve(premade) : await link().request<{ socket: string; push?: true }>("work.docs.connect", { ...namedBy(source, itemId), ...(schema > 0 ? { schema } : {}), push: true });
        if (this.readyState !== READY.CONNECTING) return void link().request("work.docs.close", { socket }).catch(() => undefined);
        this.id = socket;
        if (push) this.listen(socket);
        this.readyState = READY.OPEN;
        this.dispatchEvent(new Event("open"));
        this.settle();
        void this.flush();
        if (push) return;
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

    /** Lets go of the pushes and the link's close, once this socket is done. */
    private unlisten: (() => void) | null = null;
    /**
     * The host's frames as pushes to this window, numbered from 1: each is taken in order, one seen already is dropped,
     * and a gap (a push lost) closes the socket, as the link closing does, so the provider makes another and syncs
     * again. Nothing is taken twice or out of order.
     */
    private listen(socket: string): void {
      let next = 1;
      const offPush = link().onPush((push) => {
        if (push.push !== "work.docs.frames" || push.socket !== socket || this.readyState !== READY.OPEN) return;
        if (push.seq < next) return;
        if (push.seq > next) {
          void link().request("work.docs.close", { socket }).catch(() => undefined);
          this.dispatchEvent(new Event("error"));
          return this.finish(1006, "Frames from the host were lost");
        }
        next++;
        for (const frame of push.frames) {
          if (this.readyState !== READY.OPEN) return;
          const data = fromBase64(frame);
          this.heard(new Uint8Array(data));
          this.dispatchEvent(new MessageEvent("message", { data }));
        }
        if (push.closed) this.finish(push.closed.code, push.closed.reason);
      });
      const offClose = link().onClose(() => {
        if (this.readyState === READY.CLOSED) return;
        this.dispatchEvent(new Event("error"));
        this.finish(1006, "The connection to the host closed");
      });
      this.unlisten = () => {
        offPush();
        offClose();
      };
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
      const sync = head?.type === 0 || head?.type === 4 ? syncPayload(bytes) : null;
      try {
        if (sync?.step === 0) this.holds = Y.decodeStateVector(sync.payload);
        else if (sync && this.holds) for (const [client, clock] of Y.parseUpdateMeta(sync.payload).to) this.holds.set(client, Math.max(clock, this.holds.get(client) ?? 0));
      } catch {
        // A frame Yjs cannot read says nothing of what the service holds.
      }
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
     * What waits goes up, and the service applies it. A closing tab also asks the host to store the document. A socket still
     * connecting, or one that has not yet sent its own state, is waited for; one that does not get there in time, or
     * closes, fails the flush: what the window holds has then not reached the host.
     */
    async settled(store: boolean): Promise<number | null> {
      const deadline = Date.now() + relayTiming.syncWaitMs;
      for (;;) {
        await this.flush();
        if (this.failed) throw this.failed;
        if (this.readyState === READY.CLOSED || this.readyState === READY.CLOSING) throw new Error(NOT_SENT);
        if (this.applied()) {
          if (!store) return null;
          const at = this.sentCount;
          const counted = relayed.edits;
          const got = await link().request<{ stored?: number }>("work.docs.send", { socket: this.id, frames: [], stored: true });
          // An update sent while the host stored may not be in what it stored: it is applied and stored in its turn.
          // A host a release behind names no time: its answer is the receipt, so the line says the time it came.
          if (this.sentCount === at) {
            relayed.covered = Math.max(relayed.covered, counted);
            return typeof got?.stored === "number" ? got.stored : Date.now();
          }
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
        // An update is his edit (a socket's own state is not): the line waits for a store that holds it.
        if (head.step === 2) {
          relayed.edits++;
          said(relayed, { edited: Date.now() });
          storeLater();
        }
        // His edit, kept on this computer until the service says it applied it.
        const update = asUpdate(bytes);
        if (update && relayed.journal) {
          relayed.pending.push(toBase64(update));
          relayed.journal.keep(relayed.pending);
        }
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
      this.unlisten?.();
      this.unlisten = null;
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
