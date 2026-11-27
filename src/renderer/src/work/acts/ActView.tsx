import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { Chunk } from "../../lib/lazyChunk";
import { ACT_VIEWS, type ActViewProps } from "./registry";
import { GenericActView } from "./GenericActView";
import { Bones } from "../../components/bones";
import { ActFields, Words } from "./ActParts";
import { BusyLabel, Button } from "../../components/ui/button";

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
  const View = chunk ? chunk.surface("View", <ActWaiting kind={chunk.name} />, (retry) => <ActFailed kind={chunk.name} retry={retry} />) : GenericActView;
  return (
    <div ref={box} className="contents">
      <View {...props} />
    </div>
  );
}

/**
 * A kind's view that failed: one quiet line in the generic view's own words, with Retry, and no bones under it (a
 * view half drawn reads as still loading). It draws no `act-payload`, so Send stays off until the thing is on screen.
 */
function ActFailed({ kind, retry, busy = false }: { kind: string; retry: () => void; busy?: boolean }) {
  return (
    <p role="alert" data-act-failed className="flex items-baseline gap-2 text-[13px] leading-5 text-muted-foreground">
      Its details could not be read.
      <Button
        variant="ghost"
        size="xs"
        disabled={busy}
        onClick={() => {
          setRetrying(kind, true);
          retry();
        }}
      >
        <BusyLabel busy={busy} label="Retry" />
      </Button>
    </p>
  );
}

/** The kinds whose view his Retry is loading again: their wait keeps the failed line, its Retry spinning, never bones. */
const retrying = new Set<string>();
const heard = new Set<() => void>();
const ending = new Map<string, ReturnType<typeof setTimeout>>();
function setRetrying(kind: string, on: boolean): void {
  if (retrying.has(kind) === on) return;
  if (on) retrying.add(kind);
  else retrying.delete(kind);
  for (const fn of heard) fn();
}

/** A kind's view on its way: its bones, or after his Retry the failed line with that Retry spinning until the view or a new failure takes its place. */
function ActWaiting({ kind }: { kind: string }) {
  const on = useSyncExternalStore(
    (fn) => (heard.add(fn), () => void heard.delete(fn)),
    () => retrying.has(kind),
  );
  // The wait ends when the view or the boundary's failure replaces it: his press has its answer then. The end is a
  // beat late, so a remount at once (StrictMode's) is not taken for it.
  useEffect(() => {
    clearTimeout(ending.get(kind));
    ending.delete(kind);
    return () => void ending.set(kind, setTimeout(() => (ending.delete(kind), setRetrying(kind, false)), 0));
  }, [kind]);
  return on ? <ActFailed kind={kind} retry={() => undefined} busy /> : <ActSkeleton />;
}

/** A held act of a typical kind, as its fields and words are drawn: lengths alone, no one's payload. */
const SAMPLE_FIELDS = [
  { label: "To", value: "Maya Chen" },
  { label: "Subject", value: "Spring LAN run of show" },
  { label: "When", value: "Friday at 9:00 AM" },
];
const SAMPLE_BODY = "Here is the run of show for Friday, with the doors at nine and the first match at ten. The seat plan is attached, and the crew list follows once it is set.";

/**
 * While a kind's view loads: bones in the payload's shape, drawn by the parts the kind views are drawn with
 * (ActParts.tsx) from a sample, so nothing moves when they land. Fields on the 72px label column, the hairline, the
 * words. It draws no `act-payload`, so Send waits.
 */
export function ActSkeleton() {
  return (
    <Bones label="Loading">
      <div className="flex min-w-0 flex-col gap-4">
        <ActFields fields={SAMPLE_FIELDS} />
        <Words className="border-t border-border pt-4">{SAMPLE_BODY}</Words>
      </div>
    </Bones>
  );
}
