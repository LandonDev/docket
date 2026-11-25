/** work-kit's collab-server `CLOSE_REVOKED`, a server module the page does not load; SheetPage reads the same number. */
export const CLOSE_REVOKED = 4403;

/** A message past the host's frame cap (RFC 6455: "message too big"). */
export const CLOSE_TOO_BIG = 1009;
/** The service's `CLOSE_TOO_MUCH` and `CLOSE_FULL` (routes/budget.ts, a server module the page does not load): the link sent too much at once; the document is as large as a guest may make it. */
export const CLOSE_TOO_MUCH = 4429;
export const CLOSE_FULL = 4413;
/** How long a change may wait for the host's word before the page says its edits are not saved. */
export const QUIET_MS = 2000;

/** What the page is told of its document's socket. */
export interface SocketWatch {
  /** the host closed it as revoked (4403): the link was revoked, or took a new address or role */
  revoked(): void;
  /**
   * `true`: a change was sent and the host has said nothing for two seconds, so what is typed is not saved yet (a
   * line that dropped without a word: the browser hears of that only after half a minute). `false`: the host spoke.
   */
  quiet?(quiet: boolean): void;
  /** the host cut the socket for a message past its cap: sending it again would be cut again */
  tooBig?(): void;
  /** the host refused what this device's copy holds (items written under a name that is not this link's) */
  refusedCopy?(): void;
  /** the link sent more than its budget: what was typed is kept and goes when the host lets the link back, about a minute */
  tooMuch?(): void;
  /** the document is as large as a guest may make it: what was typed last is not on it and will not go */
  full?(): void;
}

/** A frame's kind in the collaboration wire: a document name (a length, then its bytes), then the kind. 0 is a change or a sync step. */
function frameKind(data: unknown): number | null {
  const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
  if (!bytes) return null;
  let at = 0;
  const varUint = (): number | null => {
    let n = 0;
    for (let shift = 0; at < bytes.length && shift < 35; shift += 7) {
      const b = bytes[at++]!;
      n |= (b & 0x7f) << shift;
      if (b < 0x80) return n >>> 0;
    }
    return null;
  };
  const name = varUint();
  if (name === null) return null;
  at += name;
  return varUint();
}

/**
 * The socket a guest's document opens through (the editor's `collab.socket`): the browser's own, with the page told
 * what the editor does not say (`SocketWatch`). The editor reads a revoked close as trouble with the connection, and a
 * reader whose text has loaded is shown no trouble at all, so without this the page went on showing a document its
 * link no longer opens; and it knows a dropped line only once the browser does. The sheet's page reads its own socket.
 */
export function watchedSocket(watch: SocketWatch, Base: typeof WebSocket = WebSocket, timers: { set(fn: () => void, ms: number): unknown; clear(t: unknown): void } = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) }): new (url: string) => WebSocket {
  // One page, one document: what is known of the line is the page's, whichever socket learned it.
  let quiet = false;
  const say = (next: boolean): void => {
    if (quiet === next) return;
    quiet = next;
    watch.quiet?.(next);
  };
  return class WatchedSocket extends Base {
    private waiting: unknown = null;
    constructor(url: string) {
      super(url);
      this.addEventListener("message", () => {
        timers.clear(this.waiting);
        this.waiting = null;
        say(false);
      });
      this.addEventListener("close", (e) => {
        timers.clear(this.waiting);
        this.waiting = null;
        const { code, reason } = e as CloseEvent;
        if (code === CLOSE_TOO_BIG) watch.tooBig?.();
        else if (code === CLOSE_TOO_MUCH) watch.tooMuch?.();
        else if (code === CLOSE_FULL) watch.full?.();
        else if (code === CLOSE_REVOKED && watch.refusedCopy && /another writer/.test(reason ?? "")) watch.refusedCopy();
        else if (code === CLOSE_REVOKED) watch.revoked();
      });
    }
    override send(data: Parameters<WebSocket["send"]>[0]): void {
      super.send(data);
      if (this.waiting === null && frameKind(data) === 0) this.waiting = timers.set(() => say(true), QUIET_MS);
    }
  };
}

/** `watchedSocket` told of a revoked close alone. */
export const endingSocket = (onRevoked: () => void, Base: typeof WebSocket = WebSocket): new (url: string) => WebSocket => watchedSocket({ revoked: onRevoked }, Base);

/**
 * What a page does once the host closed its socket as revoked (4403), asked again: the link gone (revoked, ended, a
 * new address) ends the page; a role the owner changed opens the page again as that role, since what it draws and
 * may send is the role's; else the socket comes back, on a fresh token.
 */
export async function afterRevoked(refresh: () => Promise<{ role: string }>, role: string, then: { gone(): void; reopen(): void; again(): void }): Promise<void> {
  let now: { role: string };
  try {
    now = await refresh();
  } catch (err) {
    if ((err as { why?: unknown } | null)?.why === "gone") return then.gone();
    return then.again();
  }
  if (now.role !== role) return then.reopen();
  then.again();
}
