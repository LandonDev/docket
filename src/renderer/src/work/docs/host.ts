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
  rename(title: string): Promise<void>;
  /** A pushed change to this document (named by the service's name for it). */
  onPush(doc: string, listener: (push: DocsPush) => void): () => void;
  /** The class the editor's provider makes its socket with: the relay over this link. */
  socket: new (url: string) => WebSocket;
}

/** The host that serves a LifeOS document, from the refusal of one that does not ("served elsewhere: env_box"). */
export function servedBy(err: unknown): string | null {
  const m = /served elsewhere: (\S+)/.exec(err instanceof Error ? err.message : String(err));
  return m ? m[1]! : null;
}

export function docHost(env: string, source: CanvasSource): DocHost {
  const link = () => registry.linkOf(env);
  const call = <T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> =>
    link().request<T>(method, { source, ...params }, timeoutMs ? { timeoutMs } : undefined);
  return {
    env,
    open: () => call("work.docs.open"),
    token: () => call("work.docs.token"),
    threads: () => call("work.docs.threads"),
    thread: (change) => call("work.docs.thread", { change }),
    mode: (mode) => call("work.docs.mode", { mode }),
    dismiss: async () => void (await call("work.docs.dismiss")),
    rename: async (title) => void (await call("work.docs.rename", { title })),
    onPush: (doc, listener) =>
      link().onPush((push) => {
        if (push.push === "work.docs" && push.doc === doc) listener(push);
      }),
    socket: relaySocket(env, source),
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
 * A WebSocket-shaped class whose socket lives on the host (work/docs/relay.ts): `connect` opens it
 * there, frames go up in order through `send`, and a long `recv` brings the host's frames down. The
 * provider sees an ordinary socket: open, message, close, error.
 */
export function relaySocket(env: string, source: CanvasSource): new (url: string) => WebSocket {
  const link = () => registry.linkOf(env);
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
    private sending = false;

    constructor(url: string) {
      super();
      this.url = url;
      void this.start();
    }

    private async start(): Promise<void> {
      try {
        const { socket } = await link().request<{ socket: string }>("work.docs.connect", { source });
        if (this.readyState !== READY.CONNECTING) return void link().request("work.docs.close", { socket }).catch(() => undefined);
        this.id = socket;
        this.readyState = READY.OPEN;
        this.dispatchEvent(new Event("open"));
        void this.flush();
        while (this.readyState === READY.OPEN) {
          const got = await link().request<{ frames: string[]; closed?: { code: number; reason: string } }>("work.docs.recv", { socket }, { timeoutMs: 45_000 });
          for (const frame of got.frames) {
            if (this.readyState !== READY.OPEN) return;
            this.dispatchEvent(new MessageEvent("message", { data: fromBase64(frame) }));
          }
          if (got.closed) return this.finish(got.closed.code, got.closed.reason);
        }
      } catch (err) {
        if (this.readyState === READY.CLOSED) return;
        this.dispatchEvent(new Event("error"));
        this.finish(1006, err instanceof Error ? err.message : String(err));
      }
    }

    private async flush(): Promise<void> {
      if (this.sending || !this.id) return;
      this.sending = true;
      try {
        while (this.outbox.length > 0 && this.readyState === READY.OPEN) {
          const frames = this.outbox.splice(0, 200);
          await link().request("work.docs.send", { socket: this.id, frames });
        }
      } catch (err) {
        this.dispatchEvent(new Event("error"));
        this.finish(1006, err instanceof Error ? err.message : String(err));
      } finally {
        this.sending = false;
      }
    }

    send(data: ArrayBufferLike | ArrayBufferView): void {
      if (this.readyState !== READY.OPEN) return;
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      this.outbox.push(toBase64(bytes));
      void this.flush();
    }

    close(code = 1000, reason = ""): void {
      if (this.readyState === READY.CLOSED) return;
      const id = this.id;
      if (id) void link().request("work.docs.close", { socket: id }).catch(() => undefined);
      this.finish(code, reason);
    }

    private finish(code: number, reason: string): void {
      if (this.readyState === READY.CLOSED) return;
      this.readyState = READY.CLOSED;
      // A plain event with a close's fields: what the provider reads, wherever CloseEvent is missing.
      this.dispatchEvent(Object.assign(new Event("close"), { code, reason, wasClean: code === 1000 }));
    }
  }
  return RelaySocket as unknown as new (url: string) => WebSocket;
}
