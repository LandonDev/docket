import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BusyLabel, Button } from "../../../components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../../../components/ui/empty";
import type { LiveTicketAsk } from "@shared/work/officeLive";
import { liveAskKey, liveAskUrl, liveLayer, type LiveLayer, type LiveRect } from "./layer";
import { APP_NAME, type LiveApp } from "./liveSwitch";

/**
 * How often a shown body checks its place in any case (perf M10: it was every 200 ms). What moves it says so first: a
 * size change of the body, of anything above it or beside anything above it (a rail or panel folding moves it without
 * resizing it), a scroll anywhere, the window's resize (`watchPlace`).
 */
export const PLACE_EVERY_MS = 1_000;

/** What parks or covers a seat on an element above it: a class (`.board-parked`, `.tab-parked`), `inert`, `hidden`, a style. */
const PARKS = ["class", "inert", "hidden", "style"];

/**
 * Whether the body is on screen for him: not inside a parked board or tab (content-visibility: hidden, which keeps the
 * body mounted with its old rectangle), not undrawn (display: none), and not inert under a view that lies over it (a
 * Work view over the thread's pane). A guest drawn for a seat he cannot see stays over the page he went to.
 */
export function seatShown(el: HTMLElement): boolean {
  if (el.closest("[inert]")) return false;
  return typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
}

/**
 * Calls `place` whenever what draws `el` may have moved it: a ResizeObserver on the body, each element above it and each
 * of their children (a sibling that folds), a change to what parks or covers an element above it (`PARKS`), a scroll
 * anywhere in the document (capture), the window's resize, and a slow check for what none of them sees. Answers its off.
 */
export function watchPlace(el: HTMLElement, place: () => void): () => void {
  const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
  if (watch) {
    watch.observe(el);
    for (let up = el.parentElement; up; up = up.parentElement) {
      watch.observe(up);
      for (const beside of up.children) if (beside !== el && !beside.contains(el)) watch.observe(beside);
    }
  }
  const parked = typeof MutationObserver === "undefined" ? null : new MutationObserver(place);
  for (let up = el.parentElement; up && parked; up = up.parentElement) parked.observe(up, { attributes: true, attributeFilter: PARKS });
  const view = el.ownerDocument.defaultView ?? window;
  view.addEventListener("resize", place);
  el.ownerDocument.addEventListener("scroll", place, { capture: true, passive: true });
  const timer = setInterval(place, PLACE_EVERY_MS);
  return () => {
    watch?.disconnect();
    parked?.disconnect();
    view.removeEventListener("resize", place);
    el.ownerDocument.removeEventListener("scroll", place, { capture: true });
    clearInterval(timer);
  };
}

const sameRect = (a: LiveRect | null, b: LiveRect): boolean => !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * A live file's body in its Files tab: the place its guest is laid over (layer.ts). It reports its rectangle while
 * it is on screen (`seatShown`) and not lain over (a chat over the tab, the file at the side over it), and hides the
 * guest when it leaves or is parked; the guest stays loaded and comes back in place when the body shows again. A file that did not load says why, with Retry; Edit here is the header's. `ask` is
 * the file's web address, or `{forms: {tenant, formId, page}}` for a Microsoft form (main makes its address).
 */
export function LiveBody({ itemId, ask, app, covered, full, layer = liveLayer }: { itemId: string; ask: LiveTicketAsk; app: LiveApp; covered: boolean; full: boolean; layer?: LiveLayer }) {
  const ref = useRef<HTMLDivElement>(null);
  // An ask made afresh each render is the same ask: the guest and its watchers follow its key alone.
  const want = liveAskKey(ask);
  const asked = useRef(ask);
  useEffect(() => {
    asked.current = ask;
  });
  const state = useSyncExternalStore(
    (fn) => layer.subscribe(itemId, fn),
    () => layer.state(itemId),
  );
  // His Retry keeps "did not open" in place, its Retry spinning, until the file comes up or fails again.
  const [kept, setKept] = useState<string | null>(null);
  if (kept !== null && (state.failed !== null || state.stage !== "start")) setKept(null);
  const failed = state.failed ?? kept;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (covered) {
      layer.hide(itemId);
      return;
    }
    let last: LiveRect | null = null;
    // Hidden once per stay out of sight: each hide starts the guest's unload clock again (HIDDEN_UNLOAD_MS).
    let away = false;
    const place = (): void => {
      if (!seatShown(el)) {
        if (!away) layer.hide(itemId);
        away = true;
        last = null;
        return;
      }
      away = false;
      const r = el.getBoundingClientRect();
      const rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      if (sameRect(last, rect)) return;
      last = rect;
      layer.show(itemId, asked.current, rect, full, el);
    };
    place();
    const off = watchPlace(el, place);
    return () => {
      off();
      layer.hide(itemId);
    };
  }, [itemId, want, covered, full, layer]);
  return (
    // A press on the body (where the guest is not drawn yet) gives the guest the caret once it is.
    <div ref={ref} data-office-live-body className="relative flex min-h-0 min-w-0 flex-1" onPointerDown={() => layer.focus(itemId)}>
      {!layer.can() ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Open in {APP_NAME[app]} on the Web</EmptyTitle>
            <EmptyDescription>This window cannot show it in the tab.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="secondary" size="sm" onClick={() => void window.open(liveAskUrl(ask), "_blank", "noopener")}>
              Open
            </Button>
          </EmptyContent>
        </Empty>
      ) : failed ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{APP_NAME[app]} for the web did not open</EmptyTitle>
            <EmptyDescription>{failed}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="secondary"
              size="sm"
              disabled={kept !== null}
              onClick={() => {
                setKept(state.failed);
                layer.retry(itemId);
              }}
            >
              <BusyLabel busy={kept !== null} label="Retry" />
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}
    </div>
  );
}
