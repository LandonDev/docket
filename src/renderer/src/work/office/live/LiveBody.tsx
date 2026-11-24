import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "../../../components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../../../components/ui/empty";
import { liveLayer, type LiveLayer, type LiveRect } from "./layer";
import { APP_NAME, type LiveApp } from "./liveSwitch";

/** How often a shown body checks its place: a rail or panel folding moves it without resizing it. */
const PLACE_EVERY_MS = 200;

const sameRect = (a: LiveRect | null, b: LiveRect): boolean => !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * A live file's body in its Files tab: the place its guest is laid over (layer.ts). It reports its rectangle while
 * it is on screen and not lain over (a chat over the tab, the file at the side over it), and hides the guest when it
 * leaves; the guest stays loaded. A file that did not load says why, with Retry; Edit here is the header's.
 */
export function LiveBody({ itemId, url, app, covered, full, layer = liveLayer }: { itemId: string; url: string; app: LiveApp; covered: boolean; full: boolean; layer?: LiveLayer }) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(
    (fn) => layer.subscribe(itemId, fn),
    () => layer.state(itemId),
  );
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (covered) {
      layer.hide(itemId);
      return;
    }
    let last: LiveRect | null = null;
    const place = (): void => {
      const r = el.getBoundingClientRect();
      const rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      if (sameRect(last, rect)) return;
      last = rect;
      layer.show(itemId, url, rect, full, el);
    };
    place();
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    watch?.observe(el);
    window.addEventListener("resize", place);
    const timer = setInterval(place, PLACE_EVERY_MS);
    return () => {
      watch?.disconnect();
      window.removeEventListener("resize", place);
      clearInterval(timer);
      layer.hide(itemId);
    };
  }, [itemId, url, covered, full, layer]);
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
            <Button variant="secondary" size="sm" onClick={() => void window.open(url, "_blank", "noopener")}>
              Open
            </Button>
          </EmptyContent>
        </Empty>
      ) : state.failed ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{APP_NAME[app]} for the web did not open</EmptyTitle>
            <EmptyDescription>{state.failed}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="secondary" size="sm" onClick={() => layer.retry(itemId)}>
              Retry
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}
    </div>
  );
}
