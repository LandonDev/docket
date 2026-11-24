import { useSyncExternalStore } from "react";

/**
 * The live Office guests of this window (docs/agents/work-office-live.md "The live tab"): Word, Excel or PowerPoint
 * for the web, each a `<webview>` on its tenant's session that main fenced at attach (src/main/officeLive.ts).
 *
 * The Files place draws only the tab on screen and is itself drawn only while it is the view, and a `<webview>` moved
 * in the DOM loads again, which costs Word 25 to 35 s. So the guests live here, outside React, in one layer on the
 * page's body: each is placed over its tab's body (`LiveBody` reports the rectangle) and hidden when that body is
 * not on screen, never moved. At most three stay loaded; the one shown least recently goes, and loads again when
 * shown, since its state is in the cloud.
 */

/** How far the file has come: the tab's bar fills by these steps (`STAGE_SHARE`). */
export type LiveStage = "start" | "file" | "editor" | "ready";
export const STAGE_SHARE: Record<LiveStage, number> = { start: 15, file: 45, editor: 80, ready: 100 };

export interface LiveState {
  stage: LiveStage;
  /** The site the guest is on when it is not the file's own (a sign-in), named in the tab's line. */
  site: string | null;
  /** Why the file did not load, in a sentence; the body says it with Retry. */
  failed: string | null;
}

export const MOST_LOADED = 3;
/** Past this the bar says nothing more: the page is shown as it is. */
export const READY_AFTER_MS = 90_000;

const START: LiveState = { stage: "start", site: null, failed: null };

/** Office's own editors, framed in the file's page: a frame from one of these means the file is up. */
const EDITOR_HOST = /(^|\.)(officeapps\.live\.com|cloud\.microsoft|officeapps-df\.live\.com)$/i;
/** The file's own sites: SharePoint and Office. Anything else is a sign-in passing through. */
const FILE_HOST = /(^|\.)(sharepoint\.com|office\.com|microsoft365\.com|officeapps\.live\.com|cloud\.microsoft|onedrive\.com)$/i;

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const ORDER: LiveStage[] = ["start", "file", "editor", "ready"];
const later = (a: LiveStage, b: LiveStage): LiveStage => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a);

/** The state after the guest's page moved (`did-navigate`, the top frame). */
export function navigated(state: LiveState, url: string): LiveState {
  const host = hostOf(url);
  if (!host || url === "about:blank") return state;
  if (FILE_HOST.test(host)) return { ...state, stage: later(state.stage, "file"), site: null };
  return { ...state, site: host };
}

/** A frame committed (`load-commit`): Office's editor in a frame of the file's page is the file up. */
export function committed(state: LiveState, url: string, top: boolean): LiveState {
  const host = hostOf(url);
  if (!host || !EDITOR_HOST.test(host)) return state;
  return top || state.site === null ? { ...state, stage: later(state.stage, "editor") } : state;
}

/** The guest stopped loading: the editor up, or a sign-in page shown, is as far as the bar goes. */
export function stopped(state: LiveState): LiveState {
  return state.stage === "editor" || state.site !== null ? { ...state, stage: "ready" } : state;
}

/** A top-frame load that failed. An abort (-3) is a page replaced by the next, not a failure. */
export function failedLoad(state: LiveState, code: number, description: string, top: boolean): LiveState {
  if (!top || code === -3) return state;
  return { ...state, failed: description ? `It did not load (${description}).` : "It did not load." };
}

/** The tab's rectangle on the page, in CSS pixels, as `getBoundingClientRect` gives it. */
export interface LiveRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Guest {
  el: HTMLElement & { getWebContentsId?(): number; loadURL?(url: string): Promise<void>; focus(): void };
  url: string;
  state: LiveState;
  guestId: number | null;
  shownAt: number;
  visible: boolean;
  full: boolean;
  /** The tab's body in the page: a key of TempCode's pressed in the guest is played there, inside the Files place. */
  anchor: HTMLElement | null;
  timer: ReturnType<typeof setTimeout> | null;
}

type Bridge = NonNullable<Window["tcLive"]>;

export class LiveLayer {
  private readonly guests = new Map<string, Guest>();
  private readonly states = new Map<string, LiveState>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private root: HTMLElement | null = null;
  private offKey: (() => void) | null = null;
  private clock = 0;

  constructor(
    private readonly bridge: () => Bridge | undefined = () => window.tcLive,
    private readonly doc: () => Document = () => document,
  ) {}

  state(key: string): LiveState {
    return this.states.get(key) ?? START;
  }

  subscribe(key: string, fn: () => void): () => void {
    const set = this.listeners.get(key) ?? new Set();
    set.add(fn);
    this.listeners.set(key, set);
    return () => void set.delete(fn);
  }

  /** Whether this window can draw a live file at all: a browser (/ui) has no guest tag. */
  can(): boolean {
    return !!this.bridge();
  }

  private set(key: string, next: LiveState): void {
    const was = this.states.get(key);
    if (was && was.stage === next.stage && was.site === next.site && was.failed === next.failed) return;
    this.states.set(key, next);
    const guest = this.guests.get(key);
    if (guest) {
      guest.state = next;
      this.paint(guest);
    }
    for (const fn of this.listeners.get(key) ?? []) fn();
  }

  /** The guest for `key` over `rect`, made on first show; the one shown least recently past three goes. */
  show(key: string, url: string, rect: LiveRect, full: boolean, anchor: HTMLElement | null = null): void {
    let guest = this.guests.get(key);
    if (guest && guest.url !== url) {
      this.drop(key);
      guest = undefined;
    }
    if (!guest) {
      const made = this.make(key, url);
      if (!made) return;
      guest = made;
    }
    guest.shownAt = ++this.clock;
    guest.anchor = anchor;
    guest.visible = rect.width > 0 && rect.height > 0;
    if (guest.full !== full) {
      guest.full = full;
      if (guest.guestId !== null) void this.bridge()?.fullWindow(guest.guestId, full);
    }
    this.place(guest, rect);
    this.evict();
  }

  /** Off screen (its tab is not shown, a chat lies over it): kept loaded, out of sight and out of reach. */
  hide(key: string): void {
    const guest = this.guests.get(key);
    if (!guest) return;
    guest.visible = false;
    this.paint(guest);
  }

  focus(key: string): void {
    this.guests.get(key)?.el.focus();
  }

  /** Loads the file again after a failure. */
  retry(key: string): void {
    const guest = this.guests.get(key);
    if (!guest) return;
    this.set(key, START);
    void guest.el.loadURL?.(guest.url).catch(() => undefined);
  }

  /** How many keys he typed in the file since it opened (main counts them on the guest). */
  async typed(key: string): Promise<number> {
    const guest = this.guests.get(key);
    if (!guest || guest.guestId === null) return 0;
    return (await this.bridge()?.typed(guest.guestId)) ?? 0;
  }

  /**
   * Leaves the file: the guest unloads, unless Word holds it while still saving. Then it asks again for up to
   * `waitMs`; past that `ask` decides ("Close anyway?"). Answers whether the guest is gone.
   */
  async leave(key: string, ask: () => Promise<boolean>, waitMs = 10_000, stepMs = 2_000): Promise<boolean> {
    const guest = this.guests.get(key);
    const bridge = this.bridge();
    if (!guest || !bridge || guest.guestId === null) {
      this.drop(key);
      return true;
    }
    const until = Date.now() + waitMs;
    let answer = await bridge.unload(guest.guestId, false);
    while (answer === "holding" && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, stepMs));
      answer = await bridge.unload(guest.guestId, false);
    }
    if (answer === "holding") {
      if (!(await ask())) return false;
      await bridge.unload(guest.guestId, true);
    }
    this.drop(key);
    return true;
  }

  /** Gone without asking (its tab closed elsewhere, the window going). */
  drop(key: string): void {
    const guest = this.guests.get(key);
    if (!guest) return;
    if (guest.timer) clearTimeout(guest.timer);
    guest.el.remove();
    this.guests.delete(key);
    this.states.delete(key);
    for (const fn of this.listeners.get(key) ?? []) fn();
  }

  private make(key: string, url: string): Guest | null {
    const bridge = this.bridge();
    if (!bridge) return null;
    const doc = this.doc();
    if (!this.root) {
      // No position or z-index of its own: each guest stacks in the page's root context, under every popover,
      // dialog and toast, and under a chat that lies over the tab (which hides it anyway).
      this.root = doc.createElement("div");
      this.root.setAttribute("data-office-live-layer", "");
      doc.body.appendChild(this.root);
    }
    if (!this.offKey) this.offKey = bridge.onKey((init) => this.replay(init));
    const el = doc.createElement("webview") as Guest["el"];
    const guest: Guest = { el, url, state: START, guestId: null, shownAt: 0, visible: false, full: false, anchor: null, timer: null };
    this.guests.set(key, guest);
    this.states.set(key, START);
    el.setAttribute("data-office-live", key);
    el.style.position = "fixed";
    el.style.display = "inline-flex";
    el.style.border = "0";
    const on = (name: string, fn: (event: Event & Record<string, unknown>) => void): void => el.addEventListener(name, fn as EventListener);
    on("dom-ready", () => {
      if (guest.guestId !== null) return;
      guest.guestId = el.getWebContentsId?.() ?? null;
      if (guest.guestId !== null && guest.full) void bridge.fullWindow(guest.guestId, true);
    });
    on("did-navigate", (e) => this.set(key, navigated(this.state(key), String(e.url))));
    on("load-commit", (e) => this.set(key, committed(this.state(key), String(e.url), e.isMainFrame === true)));
    on("did-stop-loading", () => this.set(key, stopped(this.state(key))));
    on("did-fail-load", (e) => this.set(key, failedLoad(this.state(key), Number(e.errorCode), String(e.errorDescription ?? ""), e.isMainFrame === true)));
    // Past a minute and a half the bar stops: whatever the guest shows is what there is.
    guest.timer = setTimeout(() => this.set(key, { ...this.state(key), stage: "ready" }), READY_AFTER_MS);
    // The ticket first: main attaches no guest its page did not ask for, for this exact address and session.
    void bridge.ticket(url).then((ticket) => {
      if (this.guests.get(key) !== guest) return;
      if (!ticket.ok) return this.set(key, { ...this.state(key), failed: ticket.error });
      el.setAttribute("partition", ticket.partition);
      el.setAttribute("src", ticket.src);
      this.root!.appendChild(el);
      this.paint(guest);
    });
    return guest;
  }

  private place(guest: Guest, rect: LiveRect): void {
    const style = guest.el.style;
    style.left = `${rect.x}px`;
    style.top = `${rect.y}px`;
    style.width = `${Math.max(0, rect.width)}px`;
    style.height = `${Math.max(0, rect.height)}px`;
    this.paint(guest);
  }

  private paint(guest: Guest): void {
    const shown = guest.visible && !guest.state.failed;
    const style = guest.el.style;
    style.visibility = shown ? "visible" : "hidden";
    style.pointerEvents = shown ? "auto" : "none";
    // Over the tab that fills the window (Full Window lies on the dialog layer), else just over the page.
    style.zIndex = guest.full ? "var(--layer-dialog)" : "1";
    if (!shown && this.doc().activeElement === guest.el) guest.el.blur();
  }

  private evict(): void {
    const loaded = [...this.guests.entries()].sort((a, b) => b[1].shownAt - a[1].shownAt);
    for (const [key, guest] of loaded.slice(MOST_LOADED)) if (!guest.visible) this.drop(key);
  }

  /** A key of TempCode's pressed in a guest (main's `forwardedKey`): the page hears it as its own. */
  private replay(init: KeyboardEventInit): void {
    const doc = this.doc();
    const focused = [...this.guests.values()].find((g) => g.el === doc.activeElement);
    const target = focused?.anchor?.isConnected ? focused.anchor : doc.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true, composed: true }));
  }
}

export const liveLayer = new LiveLayer();

/** A guest's state, for the tab's header line and bar (React). */
export function useLiveState(key: string | null, layer: LiveLayer = liveLayer): LiveState | null {
  return useSyncExternalStore(
    (fn) => (key ? layer.subscribe(key, fn) : () => undefined),
    () => (key ? layer.state(key) : null),
  );
}
