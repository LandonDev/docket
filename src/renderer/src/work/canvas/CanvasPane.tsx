import { useEffect, useState } from "react";
import type { CanvasItem, CanvasKind } from "@shared/work";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import type { Chunk } from "../../lib/lazyChunk";
import type { Feeds } from "./frame";
import { KindBar } from "./KindBar";
import type { CanvasBodyProps, CanvasKindDef, CanvasKindModule, CanvasSelection, CanvasShell, StatusLine } from "./kind";
import { CANVAS } from "./registry";
import { SelectionBar } from "./SelectionBar";
import { useKeptState } from "./store";

/** The kind's module once its chunk has landed, else null: its optional parts (`Bar`, `TabEnd`) are read from it. */
export function useKindModule(chunk: Chunk<CanvasKindModule>): CanvasKindModule | null {
  const [, landed] = useState(0);
  const module = chunk.loaded();
  useEffect(() => {
    if (module) return;
    let live = true;
    chunk.load().then(
      () => live && landed((n) => n + 1),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [chunk, module]);
  return module;
}

/** A loading item, in a document's shape: a title, its line, two short sections. */
function ItemSkeleton() {
  return (
    <div data-canvas-skeleton aria-busy="true" aria-label="Loading" className="mx-auto flex w-full max-w-[672px] flex-col gap-3 px-8 py-6">
      <Skeleton className="h-5 w-[46%]" />
      <Skeleton className="h-3 w-[28%]" />
      <Skeleton className="mt-3 h-4 w-[22%]" />
      <Skeleton className="h-3.5 w-[86%]" />
      <Skeleton className="h-3.5 w-[78%]" />
      <Skeleton className="h-3.5 w-[64%]" />
      <Skeleton className="mt-3 h-4 w-[20%]" />
      <Skeleton className="h-3.5 w-[92%]" />
      <Skeleton className="h-3.5 w-[70%]" />
    </div>
  );
}

/** One line of state across the item: a source that did not answer, or one that needs the person. Never a second banner. */
function StateLine({ line }: { line: StatusLine }) {
  const [running, setRunning] = useState(false);
  const action = line.action;
  return (
    <div data-canvas-state={line.tone} role="status" className="flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1 text-[13px] leading-5">
      <StatusMark state={line.tone === "failed" ? "failed" : "waiting"} word={line.word} detail={line.detail} className="min-w-0 flex-1" />
      {action ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={running}
          onClick={() => {
            setRunning(true);
            void Promise.resolve(action.run()).finally(() => setRunning(false));
          }}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The shown item under the tab row: the kind's bar, the one state line, the
 * kind's body and the bar over a selection. The body is the kind's lazy
 * chunk; while it loads the pane holds a skeleton in a document's shape.
 * Keyed by the item, so another tab starts from the state its kind kept.
 */
export function CanvasPane({
  item,
  environmentId,
  feeds,
  shell,
  onAsk,
  kinds = CANVAS,
}: {
  item: CanvasItem;
  environmentId: string;
  feeds: Feeds;
  shell: CanvasShell;
  onAsk(selection: CanvasSelection): void;
  kinds?: Record<CanvasKind, CanvasKindDef>;
}) {
  const def = kinds[item.kind];
  const module = useKindModule(def.chunk);
  const [state, setState] = useKeptState(item.id);
  const Body = def.chunk.surface("Body", <ItemSkeleton />);
  const props: CanvasBodyProps = { item, source: item.source, env: environmentId, state, setState, shell };
  const Bar = module?.Bar;
  return (
    <div data-canvas-pane data-kind={item.kind} className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <KindBar feeds={feeds} tools={Bar ? <Bar {...props} /> : undefined} onHistory={def.history ? shell.openHistory : undefined} />
      {feeds.status ? <StateLine line={feeds.status} /> : null}
      <div data-canvas-body className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        <Body {...props} />
      </div>
      <SelectionBar selection={feeds.selection} onAsk={onAsk} onDismiss={() => shell.selection(null)} />
    </div>
  );
}
