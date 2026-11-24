import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ConvexProvider } from "convex/react";
import { Mailbox, MailClientProvider, MailKitProvider, useMailClient, useMailKit, type ComposeState, type MailNav, type MailTaskRequest, type MailtoDraft } from "work-kit/mail";
import "work-kit/mail/styles.css";
import "./mail.css";
import { Skeleton } from "../../components/ui/skeleton";
import { openWorkView, useWorkView } from "../../lib/workSwitch";
import { SurfaceSkeleton } from "../../surfaces/SurfaceSkeleton";
import { sessionWaits } from "../shell/lifeos";
import type { WorkViewProps } from "../views/registry";
import { mailClientFor, startNudge } from "./client";
import { tempcodeMailKit } from "./kit";
import { mailPaneOf, type ContextChip } from "@shared/work";
import { CanvasSeat } from "../canvas/CanvasSeat";
import { Mail as MailGlyph } from "../icons";
import { placedKit } from "./files";
import { onMailto } from "./mailto";
import { mailChip } from "./model";
import { defineChunk } from "../../lib/lazyChunk";
import { Button } from "../../components/ui/button";
import { Tip } from "../../components/tip";
import { modKey } from "../../lib/keys";
import { Ask as AskGlyph } from "../icons";
import { mailChatWithheld } from "@shared/work/mailChat";
import { mailChatSubject, type MailInView } from "./chat/subject";
import { mailDockPort } from "./chat/port";
import { BLANK, liveDraftIds, liveViews, pages, patch, showMail, usePage, type MailPage } from "./page";

export { patch, showMail, type MailPage } from "./page";
import { keepDockWidth, mailRoom, readDockWidth } from "./chat/layout";
import { DOCK_SIZE } from "../dock/shapes";
import { DockSash } from "../dock/DockSash";
import { MAIL_BESIDE } from "./chat/layout";
import type { SectorKey } from "@shared/work";

/** The chat beside the mail, in a chunk of its own: it loads when he first asks. */
export const mailChatChunk = defineChunk("work-mail-chat", () => import("./chat/MailDock"));
const MailDock = mailChatChunk.surface("MailDock", <div className="min-h-0 flex-1" />);

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

export const clampList = (width: number): number => Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, Math.round(width)));

function readListWidth(): number {
  try {
    const kept = Number(localStorage.getItem(LIST_WIDTH.key));
    return kept ? clampList(kept) : LIST_WIDTH.base;
  } catch {
    return LIST_WIDTH.base;
  }
}

const NO_TASKS: ReadonlySet<string> = new Set();

export function View(props: WorkViewProps) {
  const { lifeos, env, sector } = props;
  const convex = lifeos.client;
  // Bones only while the session is on its way; a failed one is the frame's line, with nothing pulsing under it.
  if (!convex) return sessionWaits(lifeos) ? <MailBones /> : null;
  return (
    <ConvexProvider client={convex}>
      <MailClientProvider client={mailClientFor(env, convex.url, sector ?? "all")}>
        <MailKitProvider kit={tempcodeMailKit}>
          <MailPageBody {...props} />
        </MailKitProvider>
      </MailClientProvider>
    </ConvexProvider>
  );
}

function MailPageBody({ workspace, startThread, env, sector }: WorkViewProps) {
  const id = workspace.id;
  const openTask = useCallback(() => openWorkView({ workspaceId: id, view: "tasks" }), [id]);
  const start = useCallback((mail: { id: string; subject: string }) => startThread(mailChip(mail.id, mail.subject)), [startThread]);
  // A sent mail chip opens this view on its mail (`openWorkView {mail}`): taken once, then cleared.
  const wanted = useWorkView();
  const mail = wanted?.workspaceId === id && wanted.view === "mail" ? wanted.mail : undefined;
  useEffect(() => {
    if (!mail) return;
    showMail(id, mail);
    openWorkView({ workspaceId: id, view: "mail" });
  }, [id, mail]);
  // A file of the open mail opens in the view's own pane beside the reader; Ask there opens the chat with its selection.
  const files = useMemo(() => ({ env, onAsk: (chip: ContextChip) => askChat(id, chip) }), [env, id]);
  // Waiting on's Draft a nudge: the host starts a thread that drafts it, and the thread opens.
  const nudge = useCallback((thread: { id: string }) => void startNudge(env, id, thread.id), [env, id]);
  const chat = useMemo(() => chatSeat({ id, environmentId: env, path: workspace.path }, sector as SectorKey), [id, env, workspace.path, sector]);
  return <MailScreen id={id} onOpenTask={openTask} onStartThread={start} files={files} onNudge={nudge} chat={chat} />;
}

/** Where the chat beside the mail is made, or none: while the chat is off (`MAIL_CHAT.on`) or the job is withheld, Mail has no Ask and no ⌘L. */
export function chatSeat(workspace: { id: string; environmentId: string; path: string }, sector: SectorKey | null): { workspace: { id: string; environmentId: string; path: string } } | undefined {
  return mailChatWithheld(sector) ? undefined : { workspace };
}

/** The toggle over the reader, when an attachment shares the pane with it. */
const READER_TOGGLE = { label: "Mail", icon: MailGlyph };

/** The page under its providers: the list beside the reading pane, for the workspace (or the preview) named `id`. */
export function MailScreen({
  id,
  onOpenTask,
  onStartThread,
  files,
  onNudge,
  chat,
}: {
  id: string;
  /** The chat beside the mail, where the window has a host to make it on. Absent (the preview, a withheld sector), no Ask. */
  chat?: { workspace: { id: string; environmentId: string; path: string } };
  onOpenTask: () => void;
  onStartThread?: (mail: { id: string; subject: string }) => void;
  /** Waiting on's Draft a nudge, where the host has threads to write it. Absent (the preview), the row offers none. */
  onNudge?: (thread: { id: string }) => void;
  /** Where the reader's files open: the host and what Ask does there. Absent (the preview), files are saved. */
  files?: { env: string; onAsk(chip: ContextChip): void };
}) {
  const page = usePage(id);
  const kit = useMailKit();
  const pane = mailPaneOf(id);
  const env = files?.env;
  const toggleChat = useCallback(() => patch(id, { chat: !(pages.get(id) ?? BLANK).chat, chatAt: null }), [id]);
  const placed = useMemo(() => {
    // A draft asked for this workspace's Mail (`writeMail(draft, id)`) is heard here and in no other job's.
    let base = env ? { ...placedKit(kit, { env, pane }), onMailto: (hear: (draft: MailtoDraft) => void) => onMailto(hear, id) } : kit;
    if (onNudge) base = { ...base, nudge: onNudge };
    if (chat) base = { ...base, paneEnd: () => <AskButton pressed={page.chat} onPress={toggleChat} />, bulkEnd: (ids: string[]) => <AskButton glyph pressed={page.chat} onPress={() => patch(id, { chat: true, chatAt: { box: page.box, threadId: null, subject: null, query: null, picked: ids } })} /> };
    return base === kit ? null : base;
  }, [kit, env, pane, onNudge, chat, page.chat, page.box, toggleChat, id]);
  const client = useMailClient();
  const accounts = client.useMailAccounts();
  const actions = client.useMailActions();

  const nav = useMemo<MailNav>(
    () => ({
      account: page.account,
      box: page.box,
      // Another mailbox is another list: the mail that was open belongs to the one he left.
      setBox: (box) => patch(id, { box, threadId: null, chatAt: null }),
      threadId: page.threadId,
      // His own move in the list or the reader: the chat follows it.
      setThreadId: (threadId) => patch(id, { threadId, chatAt: null }),
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
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = (): void => setWidth(el.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const open = !!chat && page.chat;
  const [dockWidth, setDockWidth] = useState(() => readDockWidth(DOCK_SIZE.width));
  const room = mailRoom(width, open, dockWidth);
  const narrow = room.narrow;

  // What Mail shows, as the chat reads it: the search, the ticked rows and his saved reply come from the kit.
  const [view, setView] = useState<{ query: string | null; picked: string[]; draftId: string | null }>(NO_VIEW);
  const onView = useCallback(
    (next: { query: string | null; picked: string[]; draftId: string | null }) => {
      liveDraftIds.set(id, next.draftId);
      setView((was) => {
        // A tick or a search is his own move: a chat held on a mail opened from a chip follows it again.
        if ((was.query ?? "") !== (next.query ?? "") || was.picked.join(",") !== next.picked.join(",")) if ((pages.get(id) ?? BLANK).chatAt) patch(id, { chatAt: null });
        return next;
      });
    },
    [id],
  );
  const thread = client.useMailThread(open ? page.threadId : null);
  const live: MailInView = { box: page.box, threadId: page.threadId, subject: thread?.thread.subject ?? null, query: view.query, picked: view.picked };
  liveViews.set(id, live);
  const about = page.chatAt ?? live;
  const subject = useMemo(() => mailChatSubject(id, about), [id, about.box, about.threadId, about.subject, about.query, about.picked.join(",")]);

  // ⌘L opens and closes the chat anywhere in Mail; a canvas selection's Ask takes it first.
  useEffect(() => {
    if (!chat) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key.toLowerCase() !== "l" || event.altKey || event.shiftKey || !modKey(event)) return;
      if (!root.current?.isConnected) return;
      event.preventDefault();
      toggleChat();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chat, toggleChat]);
  // While the chat is open, Mention in a thread puts a mail in its composer.
  useEffect(() => {
    if (!open) return;
    mailDockPort.set((chip) => askChat(id, chip));
    return () => mailDockPort.set(null);
  }, [open, id]);
  // Esc in the chat's composer gives the keys back to the list.
  const onDockKey = (event: ReactKeyboardEvent): void => {
    if (event.key !== "Escape" || !(event.target as HTMLElement).closest("[data-composer-input]")) return;
    (event.target as HTMLElement).blur();
    root.current?.querySelector<HTMLElement>("[data-mail-list] [tabindex='0'], [data-mail-list] button")?.focus();
  };
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
  const box = (
    <Mailbox nav={nav} accounts={accounts} compose={page.compose} setCompose={setCompose} openTaskIds={NO_TASKS} onTask={onTask} frame={frame} narrow={narrow} sectors={false} onStartThread={onStartThread} onView={chat ? onView : undefined} />
  );
  const asked = useAsked(id);
  return (
    <div ref={root} data-mail-kit className="tc-mail relative flex h-full min-h-0">
      <div data-mail-room="" inert={open && room.over ? true : undefined} className="h-full min-h-0 min-w-0 flex-1">
        {placed ? <MailKitProvider kit={placed}>{box}</MailKitProvider> : box}
      </div>
      {open && chat ? (
        <>
          {room.over ? null : (
            <DockSash
              name="mail"
              width={room.dock}
              body={width}
              beside={MAIL_BESIDE}
              onWidth={(next, done) => {
                setDockWidth(next);
                if (done) keepDockWidth(next);
              }}
            />
          )}
          <div
            data-mail-dock-seat={room.over ? "over" : "beside"}
            onKeyDown={onDockKey}
            style={room.over ? undefined : { width: room.dock }}
            className={room.over ? "absolute inset-0 z-20 flex bg-background" : "flex shrink-0"}
          >
            <MailDock
              workspace={chat.workspace}
              subject={subject}
              facts={startersFacts(about, thread, page, view)}
              chip={asked.chip}
              focus={asked.focus}
              onChipTaken={asked.taken}
              onClose={() => patch(id, { chat: false, chatAt: null })}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

const NO_VIEW = { query: null, picked: [] as string[], draftId: null };

/** Chips asked into the chat (a selection's Ask), and whether its composer takes the caret, per workspace. */
const askedChips = new Map<string, { chip: ContextChip | null; focus: boolean }>();
const askListeners = new Set<() => void>();
const NOT_ASKED = { chip: null, focus: false };

/** Opens the chat beside the mail with a chip in its composer, the caret in it. */
export function askChat(workspaceId: string, chip: ContextChip | null): void {
  askedChips.set(workspaceId, { chip, focus: true });
  patch(workspaceId, { chat: true });
  for (const listener of askListeners) listener();
}

function useAsked(workspaceId: string): { chip: ContextChip | null; focus: boolean; taken(): void } {
  const asked = useSyncExternalStore(
    (fn) => {
      askListeners.add(fn);
      return () => void askListeners.delete(fn);
    },
    () => askedChips.get(workspaceId) ?? NOT_ASKED,
  );
  const taken = useCallback(() => {
    askedChips.set(workspaceId, { chip: null, focus: (askedChips.get(workspaceId) ?? NOT_ASKED).focus });
    for (const listener of askListeners) listener();
  }, [workspaceId]);
  return { ...asked, taken };
}

/** What the starters are made from: the open mail's other party, who wrote last, how long it is, his own reply. */
function startersFacts(about: MailInView, thread: ReturnType<ReturnType<typeof useMailClient>["useMailThread"]>, page: MailPage, view: { draftId: string | null }) {
  const messages = about.threadId && thread?.thread.id === about.threadId ? thread.messages : [];
  const last = messages[messages.length - 1];
  const other = [...messages].reverse().find((m) => !m.fromMe);
  const firstName = other ? (other.from.name || other.from.address).trim().split(/[\s@]/)[0] || null : null;
  return {
    box: about.box,
    query: about.query,
    firstName,
    wroteLast: !!last?.fromMe,
    messageCount: messages.length,
    replyOpen: !!page.compose && page.compose.threadId === about.threadId && !!view.draftId,
  };
}

/** Ask, at the reader toolbar's right end: secondary, flat on `muted` while the chat is open; a glyph alone in the ticked head. */
function AskButton({ pressed, onPress, glyph = false }: { pressed: boolean; onPress(): void; glyph?: boolean }) {
  const button = (
    <Button
      variant={pressed ? "ghost" : glyph ? "ghost" : "secondary"}
      size={glyph ? "icon-sm" : "sm"}
      aria-label={glyph ? "Ask about these" : undefined}
      aria-pressed={pressed}
      className={glyph ? "shrink-0 text-muted-foreground aria-pressed:bg-muted" : "ms-1 shrink-0 aria-pressed:bg-muted"}
      onClick={onPress}
    >
      <AskGlyph />
      {glyph ? null : "Ask"}
    </Button>
  );
  return glyph ? <Tip label="Ask about these">{button}</Tip> : button;
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
