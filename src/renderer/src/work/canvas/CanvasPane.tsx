import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import type { CanvasItem, CanvasKind } from "@shared/work";
import { BusyLabel, Button } from "../../components/ui/button";
import { useTruncated } from "../../components/tip";
import { Skeleton } from "../../components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { ItemSkeleton } from "./ItemBones";
import { StatusMark } from "../../components/ui/status";
import type { Chunk } from "../../lib/lazyChunk";
import type { Feeds } from "./frame";
import { canvasPanelId, canvasTabId } from "./CanvasTabs";
import { KindBar } from "./KindBar";
import type { CanvasBodyProps, CanvasKindDef, CanvasKindModule, CanvasSelection, CanvasShell, StatusLine } from "./kind";
import { CANVAS, kindDefOf } from "./registry";
import { SelectionBar } from "./SelectionBar";
import { FetchState, kindNoun } from "./FetchState";
import { downloadItem, keepItem, useItemFetch } from "./fetched";
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

/** A transport's own words, said as a person would read them on the state line. */
export function detailWords(detail: string): string {
  if (/^not connected\.?$/i.test(detail.trim())) return "The host is not connected";
  if (/timed? ?out/i.test(detail)) return "The host did not answer in time";
  return detail;
}

/** The state line's detail, cut to its room: while cut it takes the focus too, so the keyboard can bring up the whole of it in the same tip the pointer does. */
function Detail({ text }: { text: string }) {
  const { ref, cut } = useTruncated(text);
  const span = (
    <span ref={ref} tabIndex={cut ? 0 : undefined} className="focus-ring block truncate rounded-sm">
      {text}
    </span>
  );
  if (!cut) return span;
  return (
    <Tooltip>
      <TooltipTrigger render={span} />
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

/** One line of state across the item: a source that did not answer, or one that needs the person. Never a second banner. A cut detail shows whole on hover. */
function StateLine({ line }: { line: StatusLine }) {
  const [running, setRunning] = useState(false);
  const action = line.action;
  const detail = typeof line.detail === "string" && line.detail ? detailWords(line.detail) : null;
  return (
    <div data-canvas-state={line.tone} role="status" className="flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1 text-[13px] leading-5">
      <StatusMark
        state={line.tone === "failed" ? "failed" : "waiting"}
        word={line.word}
        detail={
          detail ? <Detail text={detail} /> : null
        }
        className="min-w-0 flex-1"
      />
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
          <BusyLabel busy={running} label={action.label} />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Why a kind's code or body failed, in his words: a viewer whose code did not arrive is said so, not as a module URL,
 * and a fault in the code (a TypeError and its kin) as "It could not be shown"; a thrown sentence is said as it is.
 * React has already logged the error itself.
 */
export function bodyFailureWords(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  if (/dynamically imported module|importing a module script failed|loading chunk|failed to fetch/i.test(message)) return "Its viewer did not load";
  const fault = error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError || error instanceof SyntaxError;
  return !fault && message ? message : "It could not be shown";
}

/** The pane's shell, for a failed body drawn by its chunk's boundary, which a kind's own `failed` cannot be handed. */
const PaneShell = createContext<CanvasShell | null>(null);

/** A body that threw, or whose code did not load: what it fed the frame goes, and the state line says why, with Retry. */
function BodyFailed({ kind, error, retry }: { kind: CanvasKind; error: unknown; retry: () => void }) {
  const shell = useContext(PaneShell);
  useLayoutEffect(() => {
    if (!shell) return;
    shell.statusLine(null);
    shell.review(null);
    shell.selection(null);
    shell.mode(null);
    shell.written(null);
    shell.more?.(null);
    shell.saved?.(null);
    shell.ready?.(false);
  }, [shell]);
  return <StateLine line={{ tone: "failed", word: `Couldn't open this ${kindNoun(kind)}`, detail: bodyFailureWords(error), action: { label: "Retry", run: retry } }} />;
}

const bodyFailed =
  (kind: CanvasKind) =>
  (retry: () => void, error: unknown): ReactNode => <BodyFailed kind={kind} error={error} retry={retry} />;

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
  tabbed = false,
}: {
  item: CanvasItem;
  environmentId: string;
  feeds: Feeds;
  shell: CanvasShell;
  onAsk(selection: CanvasSelection): void;
  kinds?: Record<CanvasKind, CanvasKindDef>;
  /** The pane sits under a row of tabs (more than one item open). */
  tabbed?: boolean;
}) {
  const def = kindDefOf(kinds, item.kind);
  const module = useKindModule(def.chunk);
  const [state, setState] = useKeptState(item.id);
  const Body = def.chunk.surface("Body", <ItemSkeleton />, bodyFailed(def.kind));
  const props: CanvasBodyProps = { item, source: item.source, env: environmentId, state, setState, shell };
  const Bar = module?.Bar;
  // A mail's attachment comes to the host first: the kind mounts once its bytes are there (fetched.ts).
  const fetched = useItemFetch(environmentId, item);
  const waiting = fetched && fetched.fetch.phase !== "ready" ? fetched.fetch : null;
  const tools = waiting ? (waiting.phase === "fetching" ? <Skeleton aria-hidden data-bar-bone className="h-3 w-30" /> : undefined) : Bar ? <Bar {...props} /> : module ? undefined : <Skeleton aria-hidden data-bar-bone className="h-3 w-30" />;
  return (
    <div
      data-canvas-pane
      data-kind={item.kind}
      // Under the tab row the pane is the shown tab's panel, named by its tab; one item alone has no tabs, and no panel role.
      {...(tabbed ? { role: "tabpanel", id: canvasPanelId(item.id), "aria-labelledby": canvasTabId(item.id) } : {})}
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      {/* History is for an item that has opened: not while the kind's code loads, nor while the kind says it is opening or could not open. */}
      {/* While the kind's code loads, the bar holds a bone where its tools will be, so the body does not drop 32px when the code lands. */}
      <KindBar
        feeds={feeds}
        tools={tools}
        onDownload={fetched && !waiting ? () => downloadItem(environmentId, item) : undefined}
        onKeep={fetched && !waiting && item.workspaceId ? () => keepItem(environmentId, item.id) : undefined}
        onHistory={def.history && module && !fetched && feeds.ready !== false ? shell.openHistory : undefined}
      />
      {feeds.status ? <StateLine line={feeds.status} /> : null}
      <div data-canvas-body className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        {waiting ? <FetchState fetch={waiting} kind={item.kind} name={item.title} onRetry={fetched!.retry} /> : (
          <PaneShell.Provider value={shell}>
            <Body {...props} />
          </PaneShell.Provider>
        )}
      </div>
      <SelectionBar selection={feeds.selection} onAsk={onAsk} onDismiss={() => shell.selection(null)} />
    </div>
  );
}
