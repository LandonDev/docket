import { parsePdfCite, type PdfCite } from "@shared/pdfCite";

/**
 * A citation in the thread (`[p. 6, clause 7.2](#pdf:<item>:6:118,300,882,341)`,
 * docs/agents/work-pdf.md): a click opens the item beside the thread if it
 * is not the shown tab, then scrolls its page into view and marks the box.
 * The thread's own pane names the thread (`data-session-drop`); the canvas
 * store opens the item. The PDF body takes the citation when it is up.
 */

type Listener = (cite: PdfCite) => void;
const waiting = new Map<string, PdfCite>();
const bodies = new Map<string, Listener>();

/** A body that is up takes its citations at once; one that mounts later takes the last one waiting for it. */
export function onCite(itemId: string, listener: Listener): () => void {
  bodies.set(itemId, listener);
  const cite = waiting.get(itemId);
  if (cite) {
    waiting.delete(itemId);
    listener(cite);
  }
  return () => {
    if (bodies.get(itemId) === listener) bodies.delete(itemId);
  };
}

export function deliverCite(cite: PdfCite): void {
  const body = bodies.get(cite.itemId);
  if (body) body(cite);
  else waiting.set(cite.itemId, cite);
}

export interface CiteHost {
  environmentOf(sessionId: string): string | undefined;
  /** Shows the item beside its thread, opening it again if it was closed. */
  show(environmentId: string, sessionId: string, itemId: string): Promise<unknown>;
}

/** What a click on the transcript does: a citation link is ours, and the browser's default (a jump to `#…`) never runs. */
export function citeClick(event: Pick<MouseEvent, "target" | "button" | "defaultPrevented" | "preventDefault">, host: CiteHost): boolean {
  if (event.button !== 0) return false;
  const target = event.target as Element | null;
  const link = target?.closest?.("a[href]");
  const cite = parsePdfCite(link?.getAttribute("href"));
  if (!link || !cite) return false;
  event.preventDefault();
  const sessionId = link.closest("[data-session-drop]")?.getAttribute("data-session-drop");
  const environmentId = sessionId ? host.environmentOf(sessionId) : undefined;
  deliverCite(cite);
  if (sessionId && environmentId) void host.show(environmentId, sessionId, cite.itemId).catch(() => undefined);
  return true;
}

let installed = false;
/** Listens for citation clicks in the whole window, in the capture phase, once. */
export function installCiteClicks(host: () => Promise<CiteHost>): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  let ready: CiteHost | null = null;
  void host().then((h) => (ready = h));
  document.addEventListener(
    "click",
    (event) => {
      if (ready) citeClick(event, ready);
      else if (parsePdfCite((event.target as Element | null)?.closest?.("a[href]")?.getAttribute("href"))) event.preventDefault();
    },
    true,
  );
}

/** For tests. */
export function resetCites(): void {
  waiting.clear();
  bodies.clear();
}
