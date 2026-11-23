import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { messagesPaneOf, type ContextChip } from "@shared/work";
import "./messages.css";
import { openWorkView, useWorkView } from "../../lib/workSwitch";
import { Empty, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { MessageMultiple } from "../../chrome/icons";
import { CanvasSeat } from "../canvas/CanvasSeat";
import { sectorName } from "../shell/actions";
import { sessionWaits } from "../shell/lifeos";
import type { WorkViewProps } from "../views/registry";
import { ChatList } from "./ChatList";
import { Conversation } from "./Conversation";
import { MessagesDataProvider } from "./data";
import { liveData } from "./live";
import { patchPage, returnTo, usePage, wantMessage } from "./page";
import { StartThreadProvider } from "./threads";

/**
 * The Messages view of a linked Work workspace (docs/agents/work-messages.md):
 * the job's chat as LifeOS holds it, read on a session narrowed to the
 * workspace's sector, so it lists that job's conversations and no other's.
 * Mail's frame: the list 296px beside the open conversation, its edge dragged
 * between 260 and 480 and kept for the app; at and under 640px of view the two
 * take turns, and the conversation's toolbar leads with the way back. The
 * list's head is the view's head (`ownHead`).
 */

/** The toggle over the conversation when a file shares the pane with it. */
const PANE_TOGGLE = { label: "Messages", icon: MessageMultiple };

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
  const { lifeos, sector, startThread } = props;
  const workspaceId = props.workspace.id;
  // The live seam from the first render, client or none: a session still opening answers "loading" through the same
  // hooks it later reads with, so the screens under it never change how many hooks they call when the client lands.
  const data = useMemo(() => liveData(lifeos, sector, props.env, workspaceId), [lifeos, sector, props.env, workspaceId]);
  const start = useCallback((chip: ContextChip) => startThread(chip), [startThread]);
  const seat = useMemo(() => ({ env: props.env, onAsk: start }), [props.env, start]);
  useOpened(workspaceId);
  // A failed session is the frame's to say (its sign-in or its line), with nothing pulsing under it.
  if (!lifeos.client && !sessionWaits(lifeos)) return null;
  return (
    <MessagesDataProvider value={data}>
      <StartThreadProvider value={start}>
        <MessagesScreen workspaceId={workspaceId} job={sectorName(sector)} seat={seat} />
      </StartThreadProvider>
    </MessagesDataProvider>
  );
}

/**
 * A conversation asked for from elsewhere (a sent chip, the one search, a
 * tell), with one of its messages or none: taken once, then cleared, as Mail
 * takes a mail.
 */
export function useOpened(workspaceId: string): void {
  const wanted = useWorkView();
  const at = wanted?.workspaceId === workspaceId && wanted.view === "messages" ? wanted : null;
  const chat = at?.chat;
  const message = at?.message;
  useEffect(() => {
    if (!chat) return;
    patchPage(workspaceId, { chatId: chat, query: "" });
    if (message) wantMessage(workspaceId, chat, message);
    openWorkView({ workspaceId, view: "messages" });
  }, [workspaceId, chat, message]);
}

/**
 * The page under its data: the list beside the open conversation, for the
 * workspace (or the preview) named `workspaceId`. `narrow` holds the narrow
 * rule for a render that measures nothing (the preview); left out, the view's
 * own width decides.
 */
export function MessagesScreen({
  workspaceId,
  job,
  narrow: forced,
  seat,
}: {
  workspaceId: string;
  job: string;
  narrow?: boolean;
  /** Where a file opens beside the conversation: the host of the view's own pane, and what Ask there does. Absent (the preview, the tests), no pane is seated. */
  seat?: { env: string; onAsk(chip: ContextChip): void };
}) {
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
  const open = (chatId: string, messageId?: string): void => (messageId ? wantMessage(workspaceId, chatId, messageId) : patchPage(workspaceId, { chatId }));
  const back = (): void => {
    // Under 640px the list comes back in the conversation's place: the keys go back to the row he left.
    if (page.chatId) returnTo(workspaceId, page.chatId);
    patchPage(workspaceId, { chatId: null });
  };
  const list = <ChatList workspaceId={workspaceId} job={job} narrow={narrow} onOpen={open} />;
  // Keyed by the conversation: another one starts with its own place and its own pages.
  const conversation = page.chatId ? <Conversation key={page.chatId} workspaceId={workspaceId} chatId={page.chatId} narrow={narrow} onBack={back} /> : null;
  // A file opened from a message shows in the view's own pane beside the conversation, as Mail seats its reader.
  const seated = (pane: ReactNode): ReactNode =>
    seat ? (
      <CanvasSeat session={{ id: messagesPaneOf(workspaceId), environmentId: seat.env }} onAsk={seat.onAsk} chatToggle={PANE_TOGGLE}>
        {pane}
      </CanvasSeat>
    ) : (
      pane
    );
  return (
    <div ref={root} data-messages={workspaceId} data-narrow={narrow || undefined} className="tc-messages h-full min-h-0">
      {narrow ? (conversation ? seated(conversation) : list) : <ListFrame list={list} pane={seated(conversation ?? <NothingOpen />)} />}
    </div>
  );
}

/** The pane with no conversation in it: one line at its middle, level with an empty list's. */
function NothingOpen() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>No conversation open</EmptyTitle>
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
