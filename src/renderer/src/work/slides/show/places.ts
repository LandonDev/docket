/**
 * Where a show is drawn (docs/agents/work-slides.md "The show"). Each
 * surface, the slideshow and the presenter's view, gets a document of its
 * own that this page fills through a portal: in the desktop app a window
 * main lets through under the frame name it made for this show (src/main/present.ts),
 * in a browser a frame over the page, which takes the page's own full
 * screen. Either way the show is one state in this page, so its windows
 * cannot fall out of step, and it reaches the deck's host as this page does.
 */

import type { ShowSurface } from "@shared/slidesShow";

export type Surface = ShowSurface;

export interface ShowPlace {
  surface: Surface;
  /** the window whose pixels and observers the surface uses */
  win: Window;
  /** where the surface mounts */
  body: HTMLElement;
  /** Calls back once when the place goes other than by `close`: he closed its window, or left full screen. */
  onGone(listener: () => void): () => void;
  close(): void;
}

/**
 * The page's look on another document, kept in step: its stylesheets, and
 * the root's classes and inline style. The slideshow is `dark` whatever the
 * app wears (the light theme's class is left off), so its bar and its end
 * line read the same over every deck.
 */
export function mirrorLook(from: Document, to: Document, theme: "app" | "dark"): () => void {
  const copied = new Set<Node>();
  const styles = (): void => {
    for (const node of from.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      if (copied.has(node)) continue;
      copied.add(node);
      to.head.appendChild(node.cloneNode(true));
    }
  };
  const root = (): void => {
    to.documentElement.className = [...from.documentElement.classList].filter((name) => theme === "app" || name !== "theme-light").join(" ");
    const style = from.documentElement.getAttribute("style");
    if (style === null) to.documentElement.removeAttribute("style");
    else to.documentElement.setAttribute("style", style);
    to.body.className = from.body.className;
  };
  styles();
  root();
  held(to);
  to.documentElement.style.height = "100%";
  to.body.style.margin = "0";
  to.body.style.height = "100%";
  to.body.style.overflow = "hidden";
  const Observer = from.defaultView?.MutationObserver;
  if (!Observer) return () => undefined;
  // A lazy chunk adds its styles later, and a change of theme rewrites the root's class.
  const heads = new Observer(styles);
  heads.observe(from.head, { childList: true });
  const roots = new Observer(root);
  roots.observe(from.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  roots.observe(from.body, { attributes: true, attributeFilter: ["class"] });
  return () => {
    heads.disconnect();
    roots.disconnect();
  };
}

/** How long a document waits for its stylesheets before it shows what it has. */
const STYLES_WAIT_MS = 1500;

/**
 * Keeps a document unseen until the stylesheets it was just given have loaded: a slideshow must never open on a
 * frame of bare, unstyled words in front of the room.
 */
function held(doc: Document): void {
  const waiting = [...doc.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter((link) => !link.sheet);
  if (waiting.length === 0) return;
  doc.body.style.visibility = "hidden";
  let left = waiting.length;
  const show = (): void => {
    left = 0;
    doc.body.style.visibility = "";
  };
  const one = (): void => void (--left === 0 && show());
  for (const link of waiting) {
    link.addEventListener("load", one, { once: true });
    link.addEventListener("error", one, { once: true });
  }
  setTimeout(() => left > 0 && show(), STYLES_WAIT_MS);
}

const themeOf = (surface: Surface): "app" | "dark" => (surface === "audience" ? "dark" : "app");

function gone(): { fire(): void; on(listener: () => void): () => void; closed: { value: boolean } } {
  const listeners = new Set<() => void>();
  const closed = { value: false };
  return {
    closed,
    fire: () => {
      if (closed.value) return;
      closed.value = true;
      for (const fn of [...listeners]) fn();
    },
    on: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
  };
}

/** A window of the desktop app, opened under the frame name main gave this show; null when the window did not open. */
export function openWindowPlace(surface: Surface, frame: string, title: string, page: Window = window): ShowPlace | null {
  const win = page.open("about:blank", frame);
  if (!win) return null;
  win.document.title = title;
  const unmirror = mirrorLook(page.document, win.document, themeOf(surface));
  const left = gone();
  win.addEventListener("pagehide", left.fire);
  return {
    surface,
    win,
    body: win.document.body,
    onGone: left.on,
    close() {
      left.closed.value = true;
      win.removeEventListener("pagehide", left.fire);
      unmirror();
      win.close();
    },
  };
}

/**
 * A frame over the page, for a browser (no child windows there). The
 * slideshow takes the page's own full screen, asked for in the press that
 * started the show; leaving full screen ends it.
 */
export function openFramePlace(surface: Surface, fullScreen: boolean, page: Window = window): ShowPlace {
  const doc = page.document;
  const frame = doc.createElement("iframe");
  frame.setAttribute("allowfullscreen", "");
  frame.setAttribute("aria-label", surface === "audience" ? "Slideshow" : "Presenter view");
  frame.dataset.showFrame = surface;
  frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:calc(var(--layer-tooltip) + 1)";
  doc.body.appendChild(frame);
  const win = frame.contentWindow!;
  const unmirror = mirrorLook(doc, win.document, themeOf(surface));
  const left = gone();
  // Leaving full screen ends the show, once full screen was entered: the listener is there from the start (so
  // `close` always takes it away) and counts only after the browser said yes.
  let entered = false;
  const onFull = (): void => {
    if (entered && doc.fullscreenElement !== frame) left.fire();
  };
  if (fullScreen && frame.requestFullscreen) {
    doc.addEventListener("fullscreenchange", onFull);
    // Refused (no press behind it, or the browser's rule): the show stays, filling the page.
    void frame.requestFullscreen().then(
      () => void (entered = true),
      () => undefined,
    );
  }
  return {
    surface,
    win,
    body: win.document.body,
    onGone: left.on,
    close() {
      left.closed.value = true;
      doc.removeEventListener("fullscreenchange", onFull);
      unmirror();
      if (doc.fullscreenElement === frame) void doc.exitFullscreen?.().catch(() => undefined);
      frame.remove();
    },
  };
}
