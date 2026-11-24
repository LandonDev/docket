import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { Chunk } from "../../lib/lazyChunk";
import { ACT_VIEWS, type ActViewProps } from "./registry";
import { GenericActView } from "./GenericActView";
import { Skeleton } from "../../components/ui/skeleton";

type ViewChunk = Chunk<{ View: (props: ActViewProps) => ReactNode }>;

/**
 * A held act's payload: its kind's own view when its pillar gave one, else the
 * generic one. `onReady` says whether the payload is on screen: every act view
 * draws `data-slot="act-payload"`, so it is true once the view has committed,
 * false while its chunk loads, after it throws (the chunk's boundary shows
 * "Couldn't load" in its place) and again true once that boundary's Retry
 * draws it. Send waits on it (outbox/OutboxView.tsx).
 */
export function ActView({ onReady, ...props }: ActViewProps & { onReady?: (ready: boolean) => void }) {
  const chunk = ACT_VIEWS[props.item.kind]?.chunk as ViewChunk | null | undefined;
  const box = useRef<HTMLDivElement>(null);
  const report = useRef(onReady);
  report.current = onReady;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !report.current) return;
    let was: boolean | null = null;
    const check = (): void => {
      const now = el.querySelector('[data-slot="act-payload"]') !== null;
      if (now !== was) report.current?.((was = now));
    };
    check();
    const watch = new MutationObserver(check);
    watch.observe(el, { childList: true, subtree: true });
    return () => {
      watch.disconnect();
      report.current?.(false);
    };
  }, []);
  // `surface` is cached per name in the chunk, its fallback with it: a fallback that holds no item's payload.
  const View = chunk ? chunk.surface("View", <ActSkeleton />) : GenericActView;
  return (
    <div ref={box} className="contents">
      <View {...props} />
    </div>
  );
}

/**
 * While a kind's view loads: bones in the payload's shape (GenericActView, MailAct), each on the 20px or 22px line
 * of the words that take its place, so nothing moves when they land. Three header rows on the 72px label column,
 * the hairline, three lines of body.
 */
export function ActSkeleton() {
  return (
    <div role="status" aria-label="Loading" aria-busy className="flex min-w-0 flex-col gap-4">
      <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        {[40, 64, 52].map((width) => (
          <div key={width} className="contents">
            <span className="flex h-5 items-center">
              <Skeleton className="h-3 w-12" />
            </span>
            <span className="flex h-5 items-center">
              <Skeleton className="h-3" style={{ width: `${width}%` }} />
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-col border-t border-border pt-4">
        {[88, 72, 80].map((width) => (
          <span key={width} className="flex h-[22px] items-center">
            <Skeleton className="h-3.5" style={{ width: `${width}%` }} />
          </span>
        ))}
      </div>
    </div>
  );
}
