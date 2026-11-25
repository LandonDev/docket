import { modeOf } from "./session";

/**
 * The phone's native frame around the owner's hosted page (docs/agents/work-guests.md "The phone's frame"). The phone
 * opens `/w/open#t=<ticket>&chrome=none`: the page then draws no line of its own (the app's bar is the only heading)
 * and no format row or find bar (the app draws its own), and, where the app's web view listens (`tcFrame`), it
 * answers a small, closed set of messages. A guest's link ignores the word, and a page without it is as it always was.
 *
 * Page → app: `window.webkit.messageHandlers.tcFrame.postMessage(message)`.
 * App → page: `window.tcFrame.receive(message)`, a plain object; anything outside the set below is dropped unread.
 * No React and no editor here, so a test drives it all.
 */

export type Chrome = "full" | "none";

/** Whether the page draws its own line: `none` only for the owner's page, and only when the address asks. */
export function frameOf(pathname: string, hash: string): Chrome {
  if (modeOf(pathname, hash).kind !== "owner") return "full";
  return new URLSearchParams(hash.replace(/^#/, "")).get("chrome") === "none" ? "none" : "full";
}

/** What the owner's address keeps once the ticket has gone from it: the frame's word alone, so a reload of the tab keeps it. */
export const keptHash = (chrome: Chrome): string => (chrome === "none" ? "#chrome=none" : "");

export const LISTS = ["bullet", "number", "check"] as const;
export type ListKind = (typeof LISTS)[number];
/** A list as the editor names its line type. */
export const LIST_TYPE = { bullet: "bulletListItem", number: "numberedListItem", check: "checkListItem" } as const satisfies Record<ListKind, string>;
export const listKindOf = (type: string | null | undefined): ListKind | null => (LISTS.find((kind) => LIST_TYPE[kind] === type) ?? null);

/** What the app may ask of the page. */
export type FrameIn =
  | { kind: "format"; what: "bold" | "italic" }
  | { kind: "format"; what: "style"; style: string }
  | { kind: "format"; what: "list"; list: ListKind }
  | { kind: "find"; what: "search"; query: string }
  | { kind: "find"; what: "next" | "previous" | "clear" }
  | { kind: "undo" }
  | { kind: "redo" };

/** What the app's bar shows of the text: where the caret is, and what Undo and Redo can do. */
export interface FrameState {
  /** the editor holds the focus: the keyboard is up */
  editing: boolean;
  style: string | null;
  /** the styles the page will take in `format/style`, in the menu's order */
  styles: string[];
  bold: boolean;
  italic: boolean;
  list: ListKind | null;
  undo: boolean;
  redo: boolean;
}

export interface FrameOffers {
  format: boolean;
  find: boolean;
  undo: boolean;
}

export type FrameOut = { kind: "drawn"; v: 1; offers: FrameOffers } | ({ kind: "state" } & FrameState) | { kind: "found"; query: string; count: number; at: number };

/** The longest style name and query the page takes. */
export const STYLE_MAX = 80;
export const QUERY_MAX = 500;

const record = (raw: unknown): Record<string, unknown> | null => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null);
const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.length <= max ? value : null);

/** A message from the app, read; null for anything outside the set. */
export function parseIn(raw: unknown): FrameIn | null {
  const m = record(raw);
  if (!m) return null;
  switch (m.kind) {
    case "undo":
    case "redo":
      return { kind: m.kind };
    case "format":
      if (m.what === "bold" || m.what === "italic") return { kind: "format", what: m.what };
      if (m.what === "style") {
        const style = text(m.style, STYLE_MAX);
        return style ? { kind: "format", what: "style", style } : null;
      }
      if (m.what === "list") return (LISTS as readonly unknown[]).includes(m.list) ? { kind: "format", what: "list", list: m.list as ListKind } : null;
      return null;
    case "find":
      if (m.what === "next" || m.what === "previous" || m.what === "clear") return { kind: "find", what: m.what };
      if (m.what === "search") {
        const query = text(m.query, QUERY_MAX);
        return query === null ? null : { kind: "find", what: "search", query };
      }
      return null;
    default:
      return null;
  }
}

export function sameState(a: FrameState, b: FrameState): boolean {
  return (
    a.editing === b.editing &&
    a.style === b.style &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.list === b.list &&
    a.undo === b.undo &&
    a.redo === b.redo &&
    a.styles.length === b.styles.length &&
    a.styles.every((s, i) => s === b.styles[i])
  );
}

/** The app's ear: WebKit's message handler. */
export interface FrameHandler {
  postMessage(message: unknown): void;
}

type Host = { webkit?: { messageHandlers?: { tcFrame?: FrameHandler } }; tcFrame?: { receive(raw: unknown): void } };

/** The app's handler, when this page is in its web view; null in a browser. */
export const nativeHandler = (win: unknown): FrameHandler | null => (win as Host).webkit?.messageHandlers?.tcFrame ?? null;

/**
 * The page's side of the bridge. `drawn` goes once; a state goes at most once a frame, and only when it changed;
 * `found` answers each find. `listen` takes the app's messages until its cleanup runs.
 */
export class Frame {
  private said = false;
  private last: FrameState | null = null;
  private waiting: FrameState | null = null;
  private frame: number | null = null;

  constructor(
    private readonly handler: FrameHandler,
    private readonly schedule: (run: () => void) => number = (run) => requestAnimationFrame(run),
    private readonly unschedule: (id: number) => void = (id) => cancelAnimationFrame(id),
  ) {}

  private post(message: FrameOut): void {
    try {
      this.handler.postMessage(message);
    } catch {
      // The app's view went away under the page: there is no one to tell.
    }
  }

  drawn(offers: FrameOffers): void {
    if (this.said) return;
    this.said = true;
    this.post({ kind: "drawn", v: 1, offers });
  }

  state(next: FrameState): void {
    this.waiting = next;
    if (this.frame !== null) return;
    let ran = false;
    const id = this.schedule(() => {
      ran = true;
      this.frame = null;
      const now = this.waiting;
      this.waiting = null;
      if (!now || (this.last && sameState(this.last, now))) return;
      this.last = now;
      this.post({ kind: "state", ...now, styles: [...now.styles] });
    });
    // A schedule that ran at once leaves nothing waiting.
    if (!ran) this.frame = id;
  }

  found(query: string, count: number, at: number): void {
    this.post({ kind: "found", query, count, at });
  }

  /** Takes the app's messages (`window.tcFrame.receive`) until the cleanup runs. */
  listen(win: unknown, receive: (message: FrameIn) => void): () => void {
    const host = win as Host;
    const ear = {
      receive(raw: unknown) {
        const message = parseIn(raw);
        if (message) receive(message);
      },
    };
    host.tcFrame = ear;
    return () => {
      if (host.tcFrame === ear) delete host.tcFrame;
      if (this.frame !== null) this.unschedule(this.frame);
      this.frame = null;
    };
  }
}

/** The bridge for this page: only with no chrome of its own and the app's ear in the window. */
export function frameFor(chrome: Chrome, win: unknown): Frame | null {
  if (chrome !== "none") return null;
  const handler = nativeHandler(win);
  return handler ? new Frame(handler) : null;
}

/** The match a step lands on, coming round at either end; 0-based, -1 with none. */
export function stepTo(count: number, current: number, by: 1 | -1): number {
  if (count === 0) return -1;
  const from = current < 0 ? (by > 0 ? -1 : 0) : current;
  return (((from + by) % count) + count) % count;
}

/** The first match at or after `at`, else the first of all: where a search lands. */
export function nearestFrom(starts: readonly number[], at: number): number {
  if (starts.length === 0) return -1;
  const i = starts.findIndex((from) => from >= at);
  return i < 0 ? 0 : i;
}
