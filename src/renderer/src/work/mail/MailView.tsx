import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ConvexProvider } from "convex/react";
import { Mailbox, MailClientProvider, MailKitProvider, useMailClient, useMailKit, type ComposeState, type MailBox, type MailNav, type MailTaskRequest } from "work-kit/mail";
import "work-kit/mail/styles.css";
import "./mail.css";
import { Skeleton } from "../../components/ui/skeleton";
import { openWorkView, useWorkView } from "../../lib/workSwitch";
import { SurfaceSkeleton } from "../../surfaces/SurfaceSkeleton";
import { sessionWaits } from "../shell/lifeos";
import type { WorkViewProps } from "../views/registry";
import { mailClientFor } from "./client";
import { tempcodeMailKit } from "./kit";
import { mailPaneOf, type ContextChip } from "@shared/work";
import { CanvasSeat } from "../canvas/CanvasSeat";
import { Mail as MailGlyph } from "../icons";
import { placedKit } from "./files";
import { mailChip } from "./model";

/**
 * The Mail view of a linked Work workspace (docs/agents/work-mail.md):
 * LifeOS's own mail client, on a session narrowed to the workspace's
 * sector, so it lists that sector's mail and no other. Send goes through
 * the host. The list is 296px beside the reading pane and takes a drag
 * between 260 and 480, kept for the app. Under 640px of pane the list and
 * the open mail take turns, and the reader's toolbar leads with the way
 * back. New mail and Start thread are the mail client's own (the list's
 * head, the reader's More), so the frame draws no header over the list's
 * head (`ownHead`); the region still names the view.
 */

/** The list's width: its default, its bounds, and where the app keeps it. */
export const LIST_WIDTH = { base: 296, min: 260, max: 480, key: "tc.mail.listWidth" } as const;
/** The view's width at and under which the list and the open mail take turns. */
const NARROW_AT = 640;

export const clampList = (width: number): number => Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, Math.round(width)));

function readListWidth(): number {
  try {
    const kept = Number(localStorage.getItem(LIST_WIDTH.key));
    return kept ? clampList(kept) : LIST_WIDTH.base;
  } catch {
    return LIST_WIDTH.base;
  }
}

export interface MailPage {
  account: string | null;
  /** The mailbox the list shows. */
  box: MailBox;
  threadId: string | null;
  sheetOpen: boolean;
  compose: ComposeState | null;
}

const BLANK: MailPage = { account: null, box: "inbox", threadId: null, sheetOpen: false, compose: null };

// What each workspace's Mail showed (its mailbox, the open mail, a mail being written), kept while the window lives, so coming back finds it as it was.
const pages = new Map<string, MailPage>();
const listeners = new Set<() => void>();

/** Changes what a workspace's Mail shows. Exported for the preview page, which sets a scene. */
export function patch(workspaceId: string, next: Partial<MailPage>): void {
  pages.set(workspaceId, { ...(pages.get(workspaceId) ?? BLANK), ...next });
  for (const listener of listeners) listener();
}

function usePage(workspaceId: string): MailPage {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => pages.get(workspaceId) ?? BLANK,
  );
}

const NO_TASKS: ReadonlySet<string> = new Set();

export function View(props: WorkViewProps) {
  const { lifeos, env } = props;
  const convex = lifeos.client;
  // Bones only while the session is on its way; a failed one is the frame's line, with nothing pulsing under it.
  if (!convex) return sessionWaits(lifeos) ? <MailBones /> : null;
  return (
    <ConvexProvider client={convex}>
      <MailClientProvider client={mailClientFor(env, convex.url)}>
        <MailKitProvider kit={tempcodeMailKit}>
          <MailPageBody {...props} />
        </MailKitProvider>
      </MailClientProvider>
    </ConvexProvider>
  );
}

function MailPageBody({ workspace, startThread, env }: WorkViewProps) {
  const id = workspace.id;
  const openTask = useCallback(() => openWorkView({ workspaceId: id, view: "tasks" }), [id]);
  const start = useCallback((mail: { id: string; subject: string }) => startThread(mailChip(mail.id, mail.subject)), [startThread]);
  // A sent mail chip opens this view on its mail (`openWorkView {mail}`): taken once, then cleared.
  const wanted = useWorkView();
  const mail = wanted?.workspaceId === id && wanted.view === "mail" ? wanted.mail : undefined;
  useEffect(() => {
    if (!mail) return;
    patch(id, { threadId: mail, compose: null });
    openWorkView({ workspaceId: id, view: "mail" });
  }, [id, mail]);
  // A file of the open mail opens in the view's own pane beside the reader; Ask there starts a thread about it.
  const files = useMemo(() => ({ env, onAsk: (chip: ContextChip) => startThread(chip) }), [env, startThread]);
  return <MailScreen id={id} onOpenTask={openTask} onStartThread={start} files={files} />;
}

/** The toggle over the reader, when an attachment shares the pane with it. */
const READER_TOGGLE = { label: "Mail", icon: MailGlyph };

/** The page under its providers: the list beside the reading pane, for the workspace (or the preview) named `id`. */
export function MailScreen({
  id,
  onOpenTask,
  onStartThread,
  files,
}: {
  id: string;
  onOpenTask: () => void;
  onStartThread?: (mail: { id: string; subject: string }) => void;
  /** Where the reader's files open: the host and what Ask does there. Absent (the preview), files are saved. */
  files?: { env: string; onAsk(chip: ContextChip): void };
}) {
  const page = usePage(id);
  const kit = useMailKit();
  const pane = mailPaneOf(id);
  const env = files?.env;
  const placed = useMemo(() => (env ? placedKit(kit, { env, pane }) : null), [kit, env, pane]);
  const client = useMailClient();
  const accounts = client.useMailAccounts();
  const actions = client.useMailActions();

  const nav = useMemo<MailNav>(
    () => ({
      account: page.account,
      box: page.box,
      // Another mailbox is another list: the mail that was open belongs to the one he left.
      setBox: (box) => patch(id, { box, threadId: null }),
      threadId: page.threadId,
      setThreadId: (threadId) => patch(id, { threadId }),
      sheetOpen: page.sheetOpen,
    }),
    [id, page.account, page.box, page.threadId, page.sheetOpen],
  );
  const setCompose = useCallback((compose: ComposeState | null) => patch(id, { compose }), [id]);
  const onTask = useCallback(
    (request: MailTaskRequest) => {
      // An open task lives in Tasks; a new one is filed from the mail at once, as LifeOS's own sheet would.
      if (request.kind === "task") onOpenTask();
      else actions.makeTask(request.threadId, request.draft);
    },
    [actions, onOpenTask],
  );
  const root = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = (): void => setNarrow(el.clientWidth > 0 && el.clientWidth <= NARROW_AT);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const onAsk = files?.onAsk;
  const frame = useCallback(
    ({ list, pane: reader }: { list: ReactNode; pane: ReactNode }) => (
      <MailFrame
        list={list}
        pane={
          env && onAsk ? (
            <CanvasSeat session={{ id: pane, environmentId: env }} onAsk={onAsk} chatToggle={READER_TOGGLE}>
              {reader}
            </CanvasSeat>
          ) : (
            reader
          )
        }
      />
    ),
    [env, onAsk, pane],
  );
  const box = <Mailbox nav={nav} accounts={accounts} compose={page.compose} setCompose={setCompose} openTaskIds={NO_TASKS} onTask={onTask} frame={frame} narrow={narrow} sectors={false} onStartThread={onStartThread} />;
  return (
    <div ref={root} data-mail-kit className="tc-mail h-full min-h-0">
      {placed ? <MailKitProvider kit={placed}>{box}</MailKitProvider> : box}
    </div>
  );
}

/** The room the reading pane keeps beside the list. */
export const PANE_ROOM = 360;

/**
 * The list beside the reading pane, with the edge between them to drag: 260 to 480px, kept for the
 * app. The arrow keys move the edge 16px on its own tab stop, and a double press puts it back. In a
 * view too narrow for the kept width the list draws narrower, leaving the pane its 360px, and the
 * kept width comes back when the room does.
 */
export function MailFrame({ list, pane }: { list: ReactNode; pane: ReactNode }) {
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
      <div data-mail-list="" style={{ width: drawn }} className="flex shrink-0 flex-col">
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
      <div data-mail-pane="" className="flex min-w-0 flex-1 flex-col">
        {pane}
      </div>
    </div>
  );
}

/** While the session opens: the list's rows beside the reading pane's head and lines, the frame Mail lands in. */
export function MailBones() {
  return (
    <div role="status" aria-label="Loading Mail" aria-busy className="@container/mail flex h-full min-h-0 select-none">
      <div style={{ width: readListWidth() }} className="flex shrink-0 flex-col border-r border-border @max-[40rem]/mail:w-full! @max-[40rem]/mail:border-r-0">
        <SurfaceSkeleton kind="rows" count={8} />
      </div>
      <div className="min-w-0 flex-1 px-8 pt-8 @max-[40rem]/mail:hidden">
        <Skeleton className="h-4 w-64 max-w-full" />
        <Skeleton className="mt-2 h-3 w-40" />
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-3 w-[88%]" />
          <Skeleton className="h-3 w-[72%]" />
          <Skeleton className="h-3 w-[80%]" />
        </div>
      </div>
    </div>
  );
}
