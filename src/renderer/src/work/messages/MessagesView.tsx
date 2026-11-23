import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./messages.css";
import { Empty, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { sectorName } from "../shell/actions";
import { sessionWaits } from "../shell/lifeos";
import type { WorkViewProps } from "../views/registry";
import { ChatList } from "./ChatList";
import { Conversation } from "./Conversation";
import { MessagesDataProvider, WAITING } from "./data";
import { liveData } from "./live";
import { patchPage, usePage } from "./page";

/**
 * The Messages view of a linked Work workspace (docs/agents/work-messages.md):
 * the job's chat as LifeOS holds it, read on a session narrowed to the
 * workspace's sector, so it lists that job's conversations and no other's.
 * Mail's frame: the list 296px beside the open conversation, its edge dragged
 * between 260 and 480 and kept for the app; at and under 640px of view the two
 * take turns, and the conversation's toolbar leads with the way back. The
 * list's head is the view's head (`ownHead`).
 */

/** The list's width: its default, its bounds, and where the app keeps it. */
export const LIST_WIDTH = { base: 296, min: 260, max: 480, key: "tc.messages.listWidth" } as const;
/** The view's width at and under which the list and the open conversation take turns. */
export const NARROW_AT = 640;
/** The room the conversation keeps beside the list. */
const PANE_ROOM = 360;

export const clampList = (width: number): number => Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, Math.round(width)));

function readListWidth(): number {
  try {
    const kept = Number(localStorage.getItem(LIST_WIDTH.key));
    return kept ? clampList(kept) : LIST_WIDTH.base;
  } catch {
    return LIST_WIDTH.base;
  }
}

export function View(props: WorkViewProps) {
  const { lifeos, sector } = props;
  const data = useMemo(() => (lifeos.client ? liveData(lifeos, sector, props.env, props.workspace.id) : null), [lifeos, sector, props.env, props.workspace.id]);
  // A failed session is the frame's to say (its sign-in or its line), with nothing pulsing under it.
  if (!data && !sessionWaits(lifeos)) return null;
  return (
    <MessagesDataProvider value={data ?? WAITING}>
      <MessagesScreen workspaceId={props.workspace.id} job={sectorName(sector)} />
    </MessagesDataProvider>
  );
}

/**
 * The page under its data: the list beside the open conversation, for the
 * workspace (or the preview) named `workspaceId`. `narrow` holds the narrow
 * rule for a render that measures nothing (the preview); left out, the view's
 * own width decides.
 */
export function MessagesScreen({ workspaceId, job, narrow: forced }: { workspaceId: string; job: string; narrow?: boolean }) {
  const page = usePage(workspaceId);
  const root = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el || forced !== undefined) return;
    const measure = (): void => setMeasured(el.clientWidth > 0 && el.clientWidth <= NARROW_AT);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [forced]);
  const narrow = forced ?? measured;
  const open = (chatId: string): void => patchPage(workspaceId, { chatId });
  const back = (): void => patchPage(workspaceId, { chatId: null });
  const list = <ChatList workspaceId={workspaceId} job={job} onOpen={open} />;
  // Keyed by the conversation: another one starts with its own place and its own pages.
  const conversation = page.chatId ? <Conversation key={page.chatId} workspaceId={workspaceId} chatId={page.chatId} narrow={narrow} onBack={back} /> : null;
  return (
    <div ref={root} data-messages={workspaceId} data-narrow={narrow || undefined} className="tc-messages h-full min-h-0">
      {narrow ? (conversation ?? list) : <ListFrame list={list} pane={conversation ?? <NothingOpen />} />}
    </div>
  );
}

/** The pane with no conversation in it: one line at its middle, level with an empty list's. */
function NothingOpen() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle className="font-normal text-muted-foreground">No conversation open</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * The list beside the conversation, with the edge between them to drag: 260 to 480px, kept for the
 * app. The arrow keys move the edge 16px on its own tab stop, and a double press puts it back. In a
 * view too narrow for the kept width the list draws narrower, leaving the pane its 360px.
 */
export function ListFrame({ list, pane }: { list: ReactNode; pane: ReactNode }) {
  const [width, setWidth] = useState(readListWidth);
  const [room, setRoom] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = (): void => setRoom(el.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  // Unmeasured (0) draws the kept width.
  const drawn = room > 0 ? Math.max(LIST_WIDTH.min, Math.min(width, room - PANE_ROOM)) : width;
  const keep = (next: number): void => {
    const clamped = clampList(next);
    setWidth(clamped);
    try {
      localStorage.setItem(LIST_WIDTH.key, String(clamped));
    } catch {
      // A window that may not store keeps the width for its own life.
    }
  };
  return (
    <div ref={root} className="flex h-full min-h-0">
      <div data-messages-list="" style={{ width: drawn }} className="flex shrink-0 flex-col">
        {list}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a draggable edge is a separator with a value, which no element is */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the list"
        aria-valuenow={drawn}
        aria-valuemin={LIST_WIDTH.min}
        aria-valuemax={LIST_WIDTH.max}
        tabIndex={0}
        className="group/edge relative z-10 -mx-[3px] w-[7px] shrink-0 cursor-col-resize touch-none outline-none"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width: drawn };
        }}
        onPointerMove={(event) => {
          if (drag.current) keep(drag.current.width + event.clientX - drag.current.x);
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() => keep(LIST_WIDTH.base)}
        onKeyDown={(event) => {
          const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
          if (!step) return;
          event.preventDefault();
          keep(drawn + step);
        }}
      >
        <span className="absolute inset-y-0 left-[3px] w-px bg-border transition-colors duration-(--dur-fast) ease-(--ease-out) group-hover/edge:bg-ring group-focus-visible/edge:bg-ring group-active/edge:bg-ring" />
      </div>
      <div data-messages-pane="" className="flex min-w-0 flex-1 flex-col">
        {pane}
      </div>
    </div>
  );
}
