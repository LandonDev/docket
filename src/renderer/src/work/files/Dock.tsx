import { useEffect, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { FileTab } from "@shared/contract-work-files";
import type { CanvasItem, ContextChip } from "@shared/work";
import { useEnvironmentBlock } from "../../chrome/ConnectionLine";
import { AppWindow, X } from "../../chrome/icons";
import { Tip, TruncateTip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { TooltipProvider } from "../../components/ui/tooltip";
import { useSashKeys } from "../../hooks/useSashKeys";
import { suppressTextSelection } from "../../lib/drag";
import type { Session } from "../../lib/session";
import { sessionStore } from "../../lib/tcserver/store";
import { useMetaById, useSessionById } from "../../lib/threads/agents";
import { workDockPort, workOpenPort } from "../../lib/workSwitch";
import { LoadLine } from "../../surfaces/SessionPane";
import { SurfaceSkeleton } from "../../surfaces/SurfaceSkeleton";
import { useSessionActions, useThreadChat } from "../../surfaces/threadChat";
import { ThreadView } from "../../surfaces/threads/ThreadView";
import { addContextChip } from "../canvas/chips";
import { addRowChips, dockThread, enterDock, leaveDock, type DockThread } from "./dockThread";
import { clampDock, DOCK, dockMost } from "./model";
import type { OpenFrom } from "./open";
import { dragging, ROWS_MIME } from "./rowParts";

/**
 * The chat docked at the right of a file tab (docs/DESIGN.md "The Files place"): a 32px head, level with the kind's bar, with the thread's
 * title ("New chat" for a draft), Open in its own tab once it is a thread, and Close; under it the thread's
 * transcript and composer, as a tab draws them, without its canvas (the file is beside it). Until the thread is
 * known, and while its rows come, the transcript's skeleton. Files rows dragged onto it become a file chip each in
 * the composer, under the document surface's wash while they are over it.
 */
export function Dock({
  workspace,
  tab,
  item,
  chip,
  focus,
  preset = null,
  onChipTaken,
  onClose,
}: {
  workspace: OpenFrom["workspace"];
  tab: FileTab;
  /** the tab's item; null until the pane's list has come */
  item: CanvasItem | null;
  /** chips to put in the composer once the thread is known (a selection's Ask, files asked about together) */
  chip: ContextChip | readonly ContextChip[] | null;
  /** the composer takes the caret when the dock opens */
  focus: boolean;
  /** a preview's thread, shown without asking which: nothing in the app passes it */
  preset?: DockThread | null;
  onChipTaken(): void;
  onClose(): void;
}) {
  const [thread, setThread] = useState<DockThread | null>(preset);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const itemId = item?.id ?? null;
  useEffect(() => {
    if (!item || preset) return;
    let live = true;
    setFailed(false);
    dockThread(workspace, tab, item).then(
      (next) => live && setThread(next),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
    // The item is the tab's for its life: its id stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, tab.id, itemId, attempt]);
  // On screen, a draft is in the open set with its first send's step; closed (or the tab gone), one he sent nothing in goes.
  // Set in the commit that draws the composer, so no send can come before the step.
  const id = thread?.id ?? null;
  useLayoutEffect(() => {
    if (!id) return;
    enterDock(id);
    return () => leaveDock(id);
  }, [id]);

  const root = useRef<HTMLElement>(null);
  const caret = (): void => void requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[data-composer-input]")?.focus());
  useEffect(() => {
    if (!id || !chip) return;
    for (const one of Array.isArray(chip) ? chip : [chip as ContextChip]) addContextChip(id, one);
    onChipTaken();
    caret();
  }, [id, chip, onChipTaken]);

  // Rows of the list dragged here: nothing moves while they are dragged; a drop puts a chip each in the composer.
  const [rowsOver, setRowsOver] = useState(false);
  const rowsDragged = (event: ReactDragEvent): boolean => !!id && [...event.dataTransfer.types].includes(ROWS_MIME) && !!dragging();
  const drop = {
    onDragOver: (event: ReactDragEvent) => {
      if (!rowsDragged(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setRowsOver(true);
    },
    onDragLeave: (event: ReactDragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRowsOver(false);
    },
    onDrop: (event: ReactDragEvent) => {
      setRowsOver(false);
      const now = dragging();
      if (!rowsDragged(event) || !now) return;
      event.preventDefault();
      addRowChips(id!, now.entries, now.from.place);
      caret();
    },
  };

  const meta = useMetaById(id);
  const title = meta?.title || "New chat";
  return (
    <section ref={root} aria-label="Chat" data-files-dock={id ?? ""} data-draft={thread?.draft && !meta ? "" : undefined} className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background" {...drop}>
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border ps-3 pe-1">
        <TruncateTip text={title}>
          <h3 className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium text-foreground">{title}</h3>
        </TruncateTip>
        <TooltipProvider>
          <div className="flex shrink-0 items-center gap-0.5">
            {meta && id ? (
              <Tip label="Open in its own tab">
                <Button variant="ghost" size="icon-xs" aria-label="Open in its own tab" className="text-muted-foreground" onClick={() => workOpenPort.get()?.(id)}>
                  <AppWindow />
                </Button>
              </Tip>
            ) : null}
            <Tip label="Close chat">
              <Button variant="ghost" size="icon-xs" aria-label="Close chat" className="text-muted-foreground" onClick={onClose}>
                <X />
              </Button>
            </Tip>
          </div>
        </TooltipProvider>
      </header>
      {failed ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-[13px] text-muted-foreground">The chat did not open</p>
          <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : id ? (
        <DockChat key={id} sessionId={id} environmentId={workspace.environmentId} focus={focus} />
      ) : (
        <Bones />
      )}
      {rowsOver ? (
        // The document surface's wash (work/canvas/fileDrop.tsx), 12px inside the dock.
        <div
          data-rows-wash
          aria-live="polite"
          className="pointer-events-none absolute inset-3 grid place-items-center rounded-lg border border-border bg-muted/70 transition-opacity duration-(--dur-fast) ease-(--ease-out) starting:opacity-0 motion-reduce:transition-none"
        >
          <span className="text-[13px] text-muted-foreground">Drop to add to the message</span>
        </div>
      ) : null}
    </section>
  );
}

const Bones = () => (
  <div className="min-h-0 flex-1" data-transcript-loading="loading">
    <SurfaceSkeleton kind="transcript" label="Loading chat" />
  </div>
);

/** The thread's transcript and composer, as the master board's child pane draws them (ChildPane.tsx). */
function DockChat({ sessionId, environmentId, focus }: { sessionId: string; environmentId: string; focus: boolean }) {
  const meta = useMetaById(sessionId);
  const session = useSessionById(sessionId);
  const block = useEnvironmentBlock(environmentId);
  // A draft has no rows to wait for; a thread waits for its host's answer, never shown as empty.
  const answered = session?.loaded === true || session?.load?.phase === "loaded";
  const loading = !session || (!!meta && session.blocks.length === 0 && !answered);
  if (loading)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-transcript-loading={session?.load?.phase ?? "loading"}>
        {session?.load ? <LoadLine name={block.name} load={session.load} onRetry={() => sessionStore.retryLoad(sessionId)} /> : null}
        <Bones />
      </div>
    );
  return <DockThreadView session={session} focus={focus} />;
}

function DockThreadView({ session, focus }: { session: Session; focus: boolean }) {
  const actions = useSessionActions();
  const rootRef = useRef<HTMLDivElement>(null);
  const port = workDockPort.get();
  const openFile = port?.openFile ?? NOOP;
  const openDiff = port?.openDiff ?? NOOP;
  const chat = useThreadChat({
    session,
    actions,
    visible: true,
    focused: true,
    composerFocused: focus,
    // The dock's draft is this workspace's chat about this file: its folder, host, branch, type and name are not his to pick here.
    hideProjectPicker: true,
    draftRow: false,
    rootRef,
    onFocusPane: NOOP,
    onOpenFile: openFile,
    onOpenDiff: openDiff,
    onOpenSession: (id) => workOpenPort.get()?.(id),
  });
  return (
    <div ref={rootRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ThreadView
        session={session}
        renderChat={chat.renderChat}
        renderSlots={chat.renderSlots}
        composing={chat.newPassArmed}
        onArmNewPass={chat.armNewPass}
        onOpenFile={openFile}
        onOpenDiff={openDiff}
        onOpenSession={(id) => workOpenPort.get()?.(id)}
        bare
        seat={false}
      />
    </div>
  );
}

const NOOP = (): void => undefined;

/**
 * The hairline between the file and its dock, the canvas split's sash (SplitShell): an 8px grab, the arrows step 2%
 * of the body (Shift 10%), a double-click goes back to 360px, Escape during a drag goes back to where it began. The
 * width is the window's; it is written when the drag ends.
 */
export function DockSash({ width, body, onWidth }: { width: number; body: number; onWidth(width: number, done: boolean): void }) {
  const [dragging, setDragging] = useState(false);
  const keys = useSashKeys({
    label: "Resize the chat",
    orientation: "vertical",
    value: width,
    min: DOCK.min,
    max: dockMost(body),
    getSpan: () => body,
    direction: -1,
    onChange: (next) => onWidth(clampDock(next, body), true),
    onReset: () => onWidth(DOCK.width, true),
  });
  const start = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointer = event.pointerId;
    const from = { x: event.clientX, width };
    let last = width;
    handle.setPointerCapture?.(pointer);
    setDragging(true);
    const restore = suppressTextSelection();
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointer) return;
      last = clampDock(from.width - (ev.clientX - from.x), body);
      onWidth(last, false);
    };
    const end = (to: number): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
      try {
        handle.releasePointerCapture?.(pointer);
      } catch {
        /* already released */
      }
      restore();
      document.body.style.cursor = "";
      setDragging(false);
      onWidth(to, true);
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId === pointer) end(last);
    };
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      end(from.width);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
  };
  return (
    <div
      {...keys}
      data-files-sash
      onPointerDown={start}
      className={`relative z-10 w-px shrink-0 cursor-col-resize outline-none focus-visible:bg-accent ${dragging ? "bg-foreground/12" : "bg-border hover:bg-foreground/7"}`}
    >
      {/* The hairline is the sash; this widens the grab to 8px. */}
      <span className="absolute inset-y-0 -inset-x-1" />
    </div>
  );
}
