import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import type { CanvasItem, CanvasKind } from "@shared/work";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { ItemSkeleton } from "./ItemBones";
import { StatusMark } from "../../components/ui/status";
import type { Chunk } from "../../lib/lazyChunk";
import type { Feeds } from "./frame";
import { canvasPanelId, canvasTabId } from "./CanvasTabs";
import { BarShut } from "./barHold";
import { KindBar } from "./KindBar";
import type { CanvasBodyProps, CanvasKindDef, CanvasKindModule, CanvasSelection, CanvasShell, StatusLine } from "./kind";
import { CANVAS, kindDefOf } from "./registry";
import { SelectionBar } from "./SelectionBar";
import { FailedHost, FetchState, OpenFailed, useFailedWords } from "./FetchState";
import { CutDetail, QuietLine } from "./QuietLine";
import { downloadItem, keepItem, useItemFetch } from "./fetched";
import { useKeptState } from "./store";
import { History } from "../icons";

/**
 * The bars and bodies whose kind's code did not load, by chunk. A body's Retry loads the code again (`loadAgain`), and
 * only once it lands are they all woken together, so every pane of that kind shows its tools and its body at once, and
 * none shows tools over a body that still says it could not open.
 */
const asleep = new Map<Chunk<CanvasKindModule>, Set<() => void>>();
function sleep(chunk: Chunk<CanvasKindModule>, wake: () => void): () => void {
  let seats = asleep.get(chunk);
  if (!seats) asleep.set(chunk, (seats = new Set()));
  seats.add(wake);
  return () => void seats.delete(wake);
}
function loadAgain(chunk: Chunk<CanvasKindModule>): void {
  // A load that fails again wakes nothing: the pressed body says so itself.
  chunk.load().then(
    () => {
      for (const wake of [...(asleep.get(chunk) ?? [])]) wake();
    },
    () => undefined,
  );
}

/**
 * The kind's module once its chunk has landed, else null, and whether its load failed: its optional parts (`Bar`,
 * `TabEnd`) are read from it. The module is kept in state, never read from the chunk while drawing: the React Compiler
 * holds a call's answer for as long as its argument is the same, so `chunk.loaded()` read in the hook's body stayed
 * null after the chunk landed, and a kind first opened in a window kept the bar's bone and never drew its tools.
 * A load that failed is not loading: the bar drops its bone, and the body's Retry starts it again (`loadAgain`); once
 * that load lands, the kind's tools come into the bar with its body.
 */
export function useKindLoad(chunk: Chunk<CanvasKindModule>): { module: CanvasKindModule | null; failed: boolean } {
  const [held, setHeld] = useState<{ chunk: Chunk<CanvasKindModule>; module: CanvasKindModule | null; failed: boolean }>(() => ({ chunk, module: chunk.loaded(), failed: false }));
  // Another kind's chunk under the same seat: what that chunk has now, taken in this render, so a kind already
  // loaded never draws the bone for a frame.
  let now = held;
  if (held.chunk !== chunk) {
    now = { chunk, module: chunk.loaded(), failed: false };
    setHeld(now);
  }
  const waiting = now.module === null && !now.failed;
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    chunk.load().then(
      (module) => live && setHeld((was) => (was.chunk === chunk ? { chunk, module, failed: false } : was)),
      () => live && setHeld((was) => (was.chunk === chunk ? { chunk, module: null, failed: true } : was)),
    );
    return () => {
      live = false;
    };
  }, [chunk, waiting]);
  const failed = now.failed;
  useEffect(() => {
    if (!failed) return;
    return sleep(chunk, () => setHeld((was) => (was.chunk === chunk ? { chunk, module: chunk.loaded(), failed: false } : was)));
  }, [chunk, failed]);
  return { module: now.module, failed };
}

/** The kind's module once its chunk has landed, else null (`useKindLoad`). */
export function useKindModule(chunk: Chunk<CanvasKindModule>): CanvasKindModule | null {
  return useKindLoad(chunk).module;
}

/** One line of state across the item: a source that did not answer, or one that needs the person. Never a second banner. A cut detail shows whole on hover and on focus. */
export function StateLine({ line, onHistory }: { line: StatusLine; onHistory?: (() => void) | undefined }) {
  if (line.tone === "quiet")
    return (
      <QuietLine
        data-canvas-state="quiet"
        word={line.word}
        detail={line.detail}
        wrap={line.wrap}
        press={line.action}
        end={
          line.history && onHistory ? (
            <Button variant="ghost" size="xs" className="shrink-0" onClick={onHistory}>
              <History />
              History
            </Button>
          ) : null
        }
      />
    );
  return <LoudLine line={line} />;
}

function LoudLine({ line }: { line: StatusLine }) {
  const [running, setRunning] = useState(false);
  const action = line.action;
  // A host's reason is worded once, as the centred failure words it; a raw one shows no detail.
  const detail = useFailedWords(typeof line.detail === "string" ? line.detail : null) || null;
  // A word that wraps (a long computer's name) takes the line's width: its detail is then a line of its own under it,
  // on the word's edge, wrapping too, so what it says (that nothing is lost) is never the part cut off.
  const under = !!line.wrap && !!detail;
  const mark = (
    <StatusMark
      state={line.tone === "failed" ? "failed" : "waiting"}
      word={line.word}
      wrap={line.wrap}
      detail={detail && !under ? <CutDetail text={detail} /> : null}
      className={under ? "min-w-0" : "min-w-0 flex-1"}
    />
  );
  return (
    <div data-canvas-state={line.tone} role="status" className="flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1 text-[13px] leading-5">
      {under ? (
        <span className="flex min-w-0 flex-1 flex-col">
          {mark}
          {/* Past the glyph's 14px and its 8px, where the word starts. */}
          <span data-canvas-detail className="ps-5.5 text-xs text-pretty text-muted-foreground">
            {detail}
          </span>
        </span>
      ) : (
        mark
      )}
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
 * and a fault in the code (a TypeError and its kin) as nothing, since the title says it; a thrown sentence is said as it is.
 * React has already logged the error itself.
 */
export function bodyFailureWords(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  if (/dynamically imported module|importing a module script failed|loading chunk|failed to fetch/i.test(message)) return "Its viewer did not load";
  const fault = error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError || error instanceof SyntaxError;
  return !fault && message ? message : "";
}

/** The pane's shell, for a failed body drawn by its chunk's boundary, which a kind's own `failed` cannot be handed. */
const PaneShell = createContext<CanvasShell | null>(null);

/** A body that threw, or whose code did not load: what it fed the frame goes, and the centred failure says why, with Retry. */
function BodyFailed({ kind, chunk, error, retry }: { kind: CanvasKind; chunk: Chunk<CanvasKindModule>; error: unknown; retry: () => void }) {
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
  // A body whose code did not load sleeps with the bars: another pane's Retry that lands it wakes this one too.
  useEffect(() => (chunk.loaded() ? undefined : sleep(chunk, retry)), [chunk, retry]);
  // The body's lazy loads the code again, and every seat that saw it fail waits on that same load.
  const again = () => {
    retry();
    loadAgain(chunk);
  };
  return <OpenFailed kind={kind} why={bodyFailureWords(error)} onRetry={again} />;
}

const bodyFailed =
  (kind: CanvasKind, chunk: Chunk<CanvasKindModule>) =>
  (retry: () => void, error: unknown): ReactNode => <BodyFailed kind={kind} chunk={chunk} error={error} retry={retry} />;

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
  historyOpen = false,
  saveLine = false,
  barLead,
  barEnd,
}: {
  item: CanvasItem;
  environmentId: string;
  feeds: Feeds;
  shell: CanvasShell;
  onAsk(selection: CanvasSelection): void;
  kinds?: Record<CanvasKind, CanvasKindDef>;
  /** The pane sits under a row of tabs (more than one item open). */
  tabbed?: boolean;
  /** The item's History shows beside it already (a Files tab): its bar offers no second way in. */
  historyOpen?: boolean;
  /** The item's save line is drawn beside it (a Files tab, a side file, a seat): a state line about saving is said there alone. */
  saveLine?: boolean;
  /** The bar's first and last parts, where the pane is a second file beside a tab's own (SideFile): its head rides in the bar. */
  barLead?: ReactNode;
  barEnd?: ReactNode;
}) {
  const def = kindDefOf(kinds, item.kind);
  const { module, failed } = useKindLoad(def.chunk);
  const [state, setState] = useKeptState(item.id);
  const Body = def.chunk.surface("Body", <ItemSkeleton />, bodyFailed(def.kind, def.chunk));
  const props: CanvasBodyProps = { item, source: item.source, env: environmentId, state, setState, shell };
  const Bar = module?.Bar;
  // A mail's attachment comes to the host first: the kind mounts once its bytes are there (fetched.ts).
  const fetched = useItemFetch(environmentId, item);
  const waiting = fetched && fetched.fetch.phase !== "ready" ? fetched.fetch : null;
  // A body that cannot open until he acts tells the bar (`useShutsBar`): its hold lets go. Keyed by the item, so it starts open.
  const [shut, setShut] = useState(false);
  // History where he can open it: in the bar, or at the end of a read-only item's quiet line (`StatusLine.history`).
  const history = def.history && !historyOpen && module && !fetched && feeds.ready !== false && !shut ? shell.openHistory : undefined;
  const line = feeds.status && !(saveLine && feeds.status.saving) ? feeds.status : null;
  const historyOnLine = !!history && line?.tone === "quiet" && !!line.history;
  const tools = waiting ? (waiting.phase === "fetching" ? <Skeleton aria-hidden data-bar-bone className="h-3 w-30" /> : undefined) : Bar ? <Bar {...props} /> : module || failed || def.bar === false ? undefined : <Skeleton aria-hidden data-bar-bone className="h-3 w-30" />;
  return (
    <div
      data-canvas-pane
      // ⌘S finds the file it saves by this (lib/saveKey.ts).
      data-canvas-item={item.id}
      data-kind={item.kind}
      // Under the tab row the pane is the shown tab's panel, named by its tab; one item alone has no tabs, and no panel role.
      {...(tabbed ? { role: "tabpanel", id: canvasPanelId(item.id), "aria-labelledby": canvasTabId(item.id) } : {})}
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      {/* History is for an item that has opened: not while the kind's code loads, nor while the kind says it is opening or could not open, nor while the body says it is shut. */}
      {/* While the kind's code loads, the bar holds a bone where its tools will be, so the body does not drop 32px when the code lands; a load that failed holds none. */}
      <KindBar
        feeds={feeds}
        environmentId={environmentId}
        tools={tools}
        onDownload={fetched && !waiting ? () => downloadItem(environmentId, item) : undefined}
        onKeep={fetched && !waiting && item.workspaceId ? () => keepItem(environmentId, item.id) : undefined}
        onHistory={historyOnLine ? undefined : history}
        lead={barLead}
        end={barEnd}
        savedAt={saveLine && feeds.saved?.state === "saved" ? (feeds.saved.at ?? null) : null}
        shut={shut || (!!line && line.tone === "quiet" && !!line.history)}
      />
      <FailedHost.Provider value={environmentId}>
        {line ? <StateLine line={line} onHistory={history} /> : null}
        <div data-canvas-body className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
          {waiting ? <FetchState fetch={waiting} kind={item.kind} name={item.title} onRetry={fetched!.retry} /> : (
            <PaneShell.Provider value={shell}>
              <BarShut.Provider value={setShut}>
                <Body {...props} />
              </BarShut.Provider>
            </PaneShell.Provider>
          )}
        </div>
      </FailedHost.Provider>
      <SelectionBar selection={feeds.selection} onAsk={onAsk} onDismiss={() => shell.selection(null)} />
    </div>
  );
}
