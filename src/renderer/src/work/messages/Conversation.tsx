import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from "react";
import { firstWords, lastHeard, staleOf, syncWhen, type ChatDetail, type ChatMessage, type ChatRow } from "@shared/work/messages";
import { ArrowLeft, ChevronDown, Copy, MessageSquarePlus, MoreHorizontal } from "../../chrome/icons";
import { RowsContextMenu, RowsMenu, tidy, type MenuRow } from "../../chrome/menuRows";
import { Tip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { anchorShift, RowLayout, type RowAnchor } from "../../lib/transcriptWindow";
import { openWorkView } from "../../lib/workSwitch";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { useMessagesData, type Paged } from "./data";
import { Composer } from "./Composer";
import { MessageBlock } from "./Message";
import { blocksOf, chatFact, estimateOf, menuKey, newSince, wantsRead, type Block } from "./model";
import { dropWanted, keepPlace, keepVisitSince, placeOf, useWanted, visitSince } from "./page";
import { chatChip, copyText, linkRows, mentionTarget, pickThreadVerb, threadRows, useStartThread } from "./threads";

/**
 * An open conversation (docs/agents/work-messages.md "The conversation"): the
 * 44px toolbar, then the messages in a 680px column, oldest at the top. It
 * opens at the first unread message, else at its foot, and stays at the foot
 * while he is there; older messages load as he scrolls up, his place held.
 * Opening it marks it read, and so does a message that arrives while it is
 * open and the window is in front. The composer sits at its foot.
 */
export function Conversation(props: { workspaceId: string; chatId: string; narrow: boolean; onBack: () => void }) {
  // Retry asks LifeOS afresh: the conversation's reads are mounted again.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return <ConversationBody key={attempt} {...props} retry={retry} />;
}

function ConversationBody({ workspaceId, chatId, narrow, onBack, retry }: { workspaceId: string; chatId: string; narrow: boolean; onBack: () => void; retry: () => void }) {
  const data = useMessagesData();
  const detail = data.useChat(chatId);
  const messages = data.useMessages(chatId);
  const chat = detail.status === "ready" ? detail.value?.chat : undefined;

  // Where "New" sits is read from the first answer, before any read mark is written, and kept for the visit in page.ts,
  // so a Retry or a remount finds the same line. Leaving the conversation ends the visit (MessagesScreen).
  const visited = visitSince(workspaceId, chatId);
  if (visited === undefined && chat) keepVisitSince(workspaceId, chatId, newSince(chat));
  const since = visited !== undefined ? visited : chat ? newSince(chat) : null;
  // The read mark waits until the column has placed him: a conversation whose messages did not come is not read.
  const [placed, setPlaced] = useState(false);
  const onPlaced = useCallback(() => setPlaced(true), []);
  // The list's row lends the toolbar its name while the conversation itself has not answered.
  const listed = data.useChats("all");
  const rowName = listed.status === "ready" ? listed.value.rows.find((row) => row._id === chatId)?.name : undefined;

  // His Mark unread holds: nothing marks the conversation read again until a newer message from someone else comes.
  // An unread mark that comes with no newer message is his: noted as it is drawn, before any effect could mark it read.
  const lastIn = chat?.lastInAt ?? 0;
  const [held, setHeld] = useState<number | null>(null);
  const [seen, setSeen] = useState<{ unread: boolean; lastIn: number } | null>(null);
  if (chat && (!seen || seen.unread !== chat.unread || seen.lastIn !== lastIn)) {
    if (seen && !seen.unread && chat.unread && lastIn <= seen.lastIn) setHeld(lastIn);
    setSeen({ unread: chat.unread, lastIn });
  }
  const holding = held !== null && lastIn <= held;

  // Opening marks it read; so does a newer message while it is open and the window is in front, or his coming back to
  // the window while something waits.
  const markRead = data.markRead;
  const wants = placed && chat && !holding ? wantsRead(chat) : false;
  const marked = useRef(false);
  useEffect(() => {
    if (!wants) return;
    if (!marked.current || document.hasFocus()) {
      marked.current = true;
      markRead(chatId);
      return;
    }
    const onFocus = (): void => markRead(chatId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [wants, chatId, markRead]);

  const failed = detail.status === "failed" || messages.status === "failed";
  const gone = detail.status === "ready" && !detail.value;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The toolbar stays whatever came back, so under 640px the way back is always there. */}
      <Toolbar workspaceId={workspaceId} detail={detail.status === "ready" ? detail.value : undefined} loading={detail.status === "loading"} name={rowName} narrow={narrow} onBack={onBack} />
      {failed ? (
        <EmptyState title={detail.status === "failed" ? "This conversation did not load" : "The messages did not load"} action={{ label: "Retry", onClick: retry }} />
      ) : gone ? (
        <EmptyState title="This conversation is no longer here" action={{ label: "Back to Messages", onClick: onBack }} />
      ) : messages.status === "loading" || !chat ? (
        <ColumnBones />
      ) : (
        <Column workspaceId={workspaceId} chat={chat} since={since} page={messages.value} onPlaced={onPlaced} />
      )}
      {detail.status === "ready" && detail.value && !failed ? <Composer workspaceId={workspaceId} detail={detail.value} /> : null}
    </div>
  );
}

// ── The toolbar ──

function Toolbar({ workspaceId, detail, loading, name, narrow, onBack }: { workspaceId: string; detail: ChatDetail | null | undefined; loading: boolean; name: string | undefined; narrow: boolean; onBack: () => void }) {
  const data = useMessagesData();
  const now = data.useNow();
  const start = useStartThread();
  const chat = detail?.chat;
  const link = chat?.link ?? detail?.link;
  // Under 640px the list and its sync line are hidden: this conversation's own source says it here, once. The source is
  // named on the line above, so this line says only when.
  const source = detail?.source;
  const heard = source ? lastHeard(source) : undefined;
  const line = narrow && source && staleOf(source, now) ? (heard ? `Last synced ${syncWhen(heard, now)}` : "Has not synced") : null;
  // Opening a conversation under 640px puts the keys on its way back.
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (narrow) back.current?.focus({ preventScroll: true });
  }, [narrow]);
  // Start thread has its own button; More holds the rest, Mention only while a thread is open.
  const rows = (): MenuRow[] =>
    chat
      ? tidy([
          chat.unread ? { kind: "item", id: "read", label: "Mark read" } : { kind: "item", id: "unread", label: "Mark unread" },
          ...threadRows(mentionTarget() !== null, false),
          { kind: "sep" },
          ...linkRows(chat.source, link),
        ])
      : [];
  const pick = (id: string): void => {
    if (!chat) return;
    if (id === "read") data.markRead(chat._id);
    else if (id === "unread") data.markUnread(chat._id);
    else pickThreadVerb(id, chatChip(chat), start, link);
  };
  // A direct chat's name opens the person in People, where LifeOS knows an address for them.
  const person = chat?.kind === "direct" ? detail?.email : undefined;
  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex h-11 items-center gap-0.5 px-2">
        {narrow ? (
          <Tip label="Back to Messages">
            <Button ref={back} variant="ghost" size="icon-sm" aria-label="Back to Messages" className="text-muted-foreground" onClick={onBack}>
              <ArrowLeft />
            </Button>
          </Tip>
        ) : null}
        {/* Under 640px the name starts at 44px, where the line under it starts. */}
        <div className={cn("flex min-w-0 flex-1 items-baseline gap-2", narrow ? "ps-1.5" : "ps-2")}>
          {!chat ? (
            name ? (
              <h2 className="min-w-0 truncate text-[13px] leading-5 font-semibold text-foreground">{name}</h2>
            ) : loading ? (
              <Skeleton className="h-3 w-32 self-center" />
            ) : null
          ) : person ? (
            <Button variant="link" className="h-auto min-w-0 shrink p-0 text-[13px] font-semibold text-foreground" onClick={() => openWorkView({ workspaceId, view: "people", person })}>
              <span className="truncate">{chat.name}</span>
            </Button>
          ) : (
            <h2 className="min-w-0 truncate text-[13px] leading-5 font-semibold text-foreground">{chat.name}</h2>
          )}
          {chat ? <span className="min-w-0 shrink-[2] truncate text-xs text-muted-foreground">{chatFact(chat)}</span> : null}
        </div>
        {start && chat ? (
          <Tip label="Start thread">
            <Button variant="ghost" size="icon-sm" aria-label="Start thread" className="text-muted-foreground" onClick={() => start(chatChip(chat))}>
              <MessageSquarePlus />
            </Button>
          </Tip>
        ) : null}
        {/* More has nothing to offer until there is a conversation: it is not drawn before. */}
        {chat ? (
          <RowsMenu
            label="More"
            align="end"
            className="min-w-48"
            rows={rows}
            onPick={pick}
            tip={{ label: "More" }}
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label="More" className="text-muted-foreground">
                <MoreHorizontal />
              </Button>
            }
          />
        ) : null}
      </div>
      {line ? (
        <p data-sync-line className={cn("truncate pb-2 text-xs text-muted-foreground", narrow ? "ps-11 pe-4" : "px-4")}>
          {line}
        </p>
      ) : null}
    </div>
  );
}

// ── The column ──

/** The column's measure: 680px of words and faces, centred, 24px to a side. */
const COLUMN = "mx-auto w-full max-w-[728px] px-6";
/** Pixels of rows drawn past each edge of the window. */
const OVERSCAN = 800;
/** How near the top an older page is asked for. */
const LOAD_AHEAD = 1200;
/** Within this of the foot he counts as there. */
const AT_FOOT = 24;
/** The air left over "New" when the conversation opens on it. */
const NEW_AIR = 48;
/** The air left over a message he was sent to. */
const FOUND_AIR = 96;
/** How many older pages are read to find a message he was sent to before giving up on it. */
const FIND_PAGES = 20;
/** How long a message he was sent to keeps its mark before it fades. */
const FOUND_HOLD_MS = 1_200;
/** A window not yet measured (and a static render's) is taken to be this tall. */
const UNMEASURED = 800;

/**
 * The messages, newest at the foot. The scroller stacks from its foot
 * (`flex-col-reverse`), so it opens at the foot with no script, a new message
 * at the foot keeps him there, and an older page added at the top moves
 * nothing he sees. Only the blocks near the window are drawn: the column
 * keeps each block's measured height (lib/transcriptWindow.ts), measured
 * upward from the foot, and holds his place when one above the foot changes.
 */
function Column({ workspaceId, chat, since, page, onPlaced }: { workspaceId: string; chat: ChatRow; since: number | null; page: Paged<ChatMessage>; onPlaced: () => void }) {
  const data = useMessagesData();
  const now = data.useNow();
  const chatId = chat._id;
  const start = useStartThread();
  const blocks = useMemo(() => blocksOf(page.rows, since, now, page.done), [page.rows, since, now, page.done]);
  // Newest first: index 0 sits at the foot, and offsets count up from there.
  const upward = useMemo(() => [...blocks].reverse(), [blocks]);
  const layout = useMemo(() => new RowLayout(), []);
  useMemo(() => layout.setRows(upward.map((block) => ({ key: block.id, estimate: estimateOf(block) }))), [layout, upward]);

  const scroller = useRef<HTMLDivElement>(null);
  /** How far up from the foot he is, and how tall the window is. */
  const view = useRef({ up: 0, height: UNMEASURED });
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const atFoot = useRef(true);
  const anchor = useRef<RowAnchor | null>(null);
  const opened = useRef(false);
  /** Older pages read to reach "New" when it lies above the first page, counted once a page. */
  const reach = useRef({ asked: -1, pages: 0 });

  // What came at the foot, kept as state and moved on only after a draw: the newest block counted, the ones that rose
  // in while he was there, how many came from others while he was up the column ("2 new"), and the one line said.
  const [newest, setNewest] = useState<string | undefined>(() => upward[0]?.id);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(NONE);
  const [unseen, setUnseen] = useState(0);
  const [said, setSaid] = useState("");
  const top = upward[0];
  // What is newer than the newest counted: an empty conversation's first messages, else the blocks above it. A newest
  // that left (his Undo) leaves nothing to count, and the count moves on to the newest now there.
  const came = useMemo(() => {
    if (!top || top.id === newest) return [];
    if (newest === undefined) return upward;
    const at = upward.findIndex((block) => block.id === newest);
    return at > 0 ? upward.slice(0, at) : [];
  }, [upward, top, newest]);

  /** Places the window `up` pixels over the foot. */
  const goTo = (up: number): void => {
    view.current.up = Math.max(0, up);
    atFoot.current = view.current.up <= AT_FOOT;
    anchor.current = atFoot.current ? null : layout.anchorAt(view.current.up);
  };
  const over = (index: number, air: number): number => layout.offsetOf(index + 1) + air - view.current.height;

  const wanted = useWanted(workspaceId, chatId);
  // "New" above the first page: older pages are read until it is held (a bounded number), and the column opens there.
  const fresh = upward.findIndex((block) => block.isNew);
  const unreadAbove = since !== null && fresh < 0 && !page.done && blocks.length > 0 && blocks[0]!.message.sentAt > since && blocks.some((block) => !block.message.who.me && block.message.sentAt > since);

  const range = layout.range(view.current.up, view.current.height, OVERSCAN);
  const shown = upward.slice(range.start, range.end);

  // After each draw: measure what is drawn, open where it should, count what came, keep his place against any change
  // under it, and draw again if the window reaches past what is drawn.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (el.clientHeight) view.current.height = el.clientHeight;
    const changes: { index: number; delta: number }[] = [];
    for (const node of el.querySelectorAll<HTMLElement>("[data-block]")) {
      const height = node.offsetHeight;
      // A static render or a hidden pane measures nothing: the estimates stand.
      if (!height) continue;
      const change = layout.measure(node.dataset.block!, height);
      if (change) changes.push(change);
    }
    if (!opened.current && upward.length) {
      if (unreadAbove && reach.current.pages < FIND_PAGES) {
        if (reach.current.asked !== page.rows.length) {
          reach.current = { asked: page.rows.length, pages: reach.current.pages + 1 };
          page.more();
        }
      } else {
        // Where the column opens: on a message he was sent to (its own effect places it), over "New", else where he
        // left it, else its foot.
        opened.current = true;
        const kept = placeOf(workspaceId, chatId);
        if (!wanted) goTo(fresh >= 0 ? over(fresh, NEW_AIR) : kept ? (layout.scrollTopFor(kept) ?? 0) : 0);
        onPlaced();
      }
    } else if (atFoot.current) view.current.up = 0;
    else if (anchor.current) view.current.up = layout.scrollTopFor(anchor.current) ?? view.current.up + anchorShift(changes, layout.indexOf(anchor.current.key));
    // The column-reverse scroller counts from its foot: 0 there, negative going up.
    if (Math.abs(-el.scrollTop - view.current.up) > 0.5) el.scrollTop = -view.current.up;
    // The newest counted moves on after every page that changed the foot, removals and an emptied page included.
    if (top?.id !== newest) {
      if (came.length) {
        const others = came.filter((block) => !block.message.who.me);
        if (atFoot.current) setArrived(new Set(came.map((block) => block.id)));
        else if (others.length) setUnseen((n) => n + others.length);
        const last = others[0]?.message;
        if (last) setSaid(`${last.who.name}: ${firstWords(last.text, 80)}`);
      }
      setNewest(top?.id);
    }
    const next = layout.range(view.current.up, view.current.height, OVERSCAN);
    if (next.start !== range.start || next.end !== range.end) redraw();
  });

  // His place, read as he scrolls: the foot or a block, the window's reach, and the next older page near the top.
  const onScroll = (): void => {
    const el = scroller.current;
    if (!el) return;
    view.current.height = el.clientHeight || view.current.height;
    goTo(-el.scrollTop);
    keepPlace(workspaceId, chatId, anchor.current);
    if (!atFoot.current) {
      if (arrived.size) setArrived(NONE);
    } else if (unseen) setUnseen(0);
    if (!page.done && view.current.up + view.current.height > layout.total() - LOAD_AHEAD) page.more();
    const next = layout.range(view.current.up, view.current.height, OVERSCAN / 2);
    if (next.start < range.start || next.end > range.end) redraw();
  };

  // A message he was sent to: read back page by page until it is held (a bounded number of pages, counted afresh for
  // each message asked for), brought into view with air over it, and marked for a moment.
  const finding = useRef({ id: "", asked: -1, pages: 0 });
  const [found, setFound] = useState<{ id: string; on: boolean } | null>(null);
  useEffect(() => {
    if (!wanted) return;
    if (finding.current.id !== wanted) finding.current = { id: wanted, asked: -1, pages: 0 };
    const index = upward.findIndex((block) => block.id === wanted);
    if (index < 0) {
      if (page.done || finding.current.pages >= FIND_PAGES) dropWanted(workspaceId);
      else if (finding.current.asked !== page.rows.length) {
        finding.current = { ...finding.current, asked: page.rows.length, pages: finding.current.pages + 1 };
        page.more();
      }
      return;
    }
    opened.current = true;
    onPlaced();
    goTo(over(index, FOUND_AIR));
    keepPlace(workspaceId, chatId, anchor.current);
    setFound({ id: wanted, on: true });
    dropWanted(workspaceId);
    redraw();
  });
  useEffect(() => {
    if (!found?.on) return;
    const timer = setTimeout(() => setFound({ id: found.id, on: false }), FOUND_HOLD_MS);
    return () => clearTimeout(timer);
  }, [found]);

  // A message's menu, from a right-click, its ⋯, or the menu key on a focused message: a thread about it (its words ride
  // on the chip), Copy text, its link.
  const menuAt = useRef<((at: { x: number; y: number; id: string | null }) => void) | null>(null);
  const byId = useMemo(() => new Map(blocks.map((block) => [block.id, block.message])), [blocks]);
  const messageRows = (id: string | null): MenuRow[] | null => {
    const message = id ? byId.get(id) : undefined;
    if (!message) return null;
    return tidy([...threadRows(mentionTarget() !== null, start !== null), { kind: "item", id: "copy-text", label: "Copy text", icon: Copy }, { kind: "sep" }, ...linkRows(chat.source, message.permalink)]);
  };
  const pickMessage = (pick: string, id: string | null): void => {
    const message = id ? byId.get(id) : undefined;
    if (!message) return;
    if (pick === "copy-text") copyText(message.text, "Copied");
    else pickThreadVerb(pick, chatChip(chat, message.text), start, message.permalink);
  };
  const onMore = useMemo(
    () =>
      (id: string, button: HTMLElement): void => {
        const rect = button.getBoundingClientRect();
        menuAt.current?.({ x: rect.left, y: rect.bottom, id });
      },
    [],
  );
  // The keys on the column: up and down from message to message, and the menu key opens the focused one's menu.
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = (event.target as HTMLElement).closest<HTMLElement>("[data-block]");
    if (menuKey(event)) {
      if (!at) return;
      event.preventDefault();
      menuAt.current?.({ x: 0, y: 0, id: at.dataset.block! });
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    const all = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-block]")];
    // From the column itself: the first message inside the window going down, the last going up (overscan draws more).
    const frame = scroller.current?.getBoundingClientRect();
    const inView = frame ? all.filter((node) => node.getBoundingClientRect().bottom > frame.top && node.getBoundingClientRect().top < frame.bottom) : [];
    const from = inView.length ? inView : all;
    const next = at ? all[all.indexOf(at) + step] : from[step > 0 ? 0 : from.length - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  // A conversation shorter than its window asks for older messages at once.
  useEffect(() => {
    if (!page.done && layout.total() < view.current.height + LOAD_AHEAD) page.more();
  }, [page, layout]);

  const toFoot = (): void => {
    goTo(0);
    keepPlace(workspaceId, chatId, null);
    setUnseen(0);
    redraw();
  };

  if (!blocks.length) return <EmptyState title="No messages yet" />;
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} data-column className="flex h-full flex-col-reverse overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
        <RowsContextMenu lazyMount label="Message" rowsFor={messageRows} onPick={pickMessage} openRef={menuAt}>
          {/* A log that pages upward says nothing of itself: an older page drawn on the way up is not news. What comes at
              the foot is said once, in the status under it. */}
          <div className={cn(COLUMN, "focus-ring pt-4 pb-5")} role="log" aria-label="Messages" aria-live="off" tabIndex={0} onKeyDown={keys}>
            <div aria-hidden style={{ height: layout.total() - layout.offsetOf(range.end) }} />
            {shown
              .slice()
              .reverse()
              .map((block: Block) => (
                <MessageBlock
                  key={block.id}
                  block={block}
                  arrives={arrived.has(block.id) || (atFoot.current && came.includes(block))}
                  found={found?.id === block.id ? (found.on ? "on" : "off") : undefined}
                  workspaceId={workspaceId}
                  chatId={chatId}
                  chat={chat}
                  onMore={onMore}
                />
              ))}
            <div aria-hidden style={{ height: layout.offsetOf(range.start) }} />
          </div>
        </RowsContextMenu>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>
      {unseen > 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          {/* It floats over the column, so its fills stay opaque: muted on hover, foreground/12 over that on a press. */}
          <Button
            variant="ghost"
            size="sm"
            rounded
            onClick={toFoot}
            className="pointer-events-auto border border-border bg-popover ps-3 pe-2.5 text-muted-foreground shadow-overlay hover:bg-muted hover:text-foreground active:bg-muted active:bg-linear-to-b active:from-foreground/12 active:to-foreground/12"
          >
            {unseen} new
            <ChevronDown />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const NONE: ReadonlySet<string> = new Set();

/** While the messages load: runs in their own shape, at the column's foot where they will land. */
export function ColumnBones() {
  const runs = [
    [62, 40],
    [48],
    [70, 55, 30],
  ];
  return (
    // The scroller's strip is kept here too, so the bones stand where the messages will.
    <div aria-busy aria-label="Loading messages" className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden [scrollbar-gutter:stable]">
      <div className={cn(COLUMN, "flex flex-col gap-4 pt-4 pb-5")}>
        {runs.map((lines, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed bones that never reorder
          <div key={i} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3">
            <Skeleton className="row-span-2 size-7 rounded-full" />
            <div className="flex h-5 items-center gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2.5 w-12" />
            </div>
            <div className="col-start-2 flex flex-col">
              {lines.map((w, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed bones that never reorder
                <div key={j} className="flex h-[22px] items-center">
                  <Skeleton className="h-3" style={{ width: `${w}%` }} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
