import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { SOURCE_APP, syncLine, type ChatDetail, type ChatMessage } from "@shared/work/messages";
import { ArrowLeft, ChevronDown, Copy, ExternalLink, MoreHorizontal } from "../../chrome/icons";
import { RowsMenu, tidy, type MenuRow } from "../../chrome/menuRows";
import { Tip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { openUrl } from "../../lib/native";
import { anchorShift, RowLayout, type RowAnchor } from "../../lib/transcriptWindow";
import { openWorkView } from "../../lib/workSwitch";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { useMessagesData, type Paged } from "./data";
import { Composer } from "./Composer";
import { MessageBlock } from "./Message";
import { blocksOf, chatFact, estimateOf, newSince, threadRows, wantsRead, type Block } from "./model";
import { keepPlace, placeOf } from "./page";

/**
 * An open conversation (docs/agents/work-messages.md "The conversation"): the
 * 44px toolbar, then the messages in a 680px column, oldest at the top. It
 * opens at the first unread message, else at its foot, and stays at the foot
 * while he is there; older messages load as he scrolls up, his place held.
 * Opening it marks it read, and so does a message that arrives while it is
 * open and the window is in front. The composer sits at its foot.
 */
export function Conversation({ workspaceId, chatId, narrow, onBack }: { workspaceId: string; chatId: string; narrow: boolean; onBack: () => void }) {
  const data = useMessagesData();
  const detail = data.useChat(chatId);
  const messages = data.useMessages(chatId);
  const chat = detail.status === "ready" ? detail.value?.chat : undefined;

  // Opening marks it read; so does his coming back to the window while it is open and something waits.
  const markRead = data.markRead;
  const wants = chat ? wantsRead(chat) : false;
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

  if (detail.status === "failed") return <EmptyState title="This conversation did not load" line={detail.error} />;
  if (detail.status === "ready" && !detail.value) return <EmptyState title="This conversation is no longer here" action={{ label: "Back to Messages", onClick: onBack }} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar workspaceId={workspaceId} detail={detail.status === "ready" ? detail.value : undefined} narrow={narrow} onBack={onBack} />
      {messages.status === "failed" ? (
        <EmptyState title="The messages did not load" line={messages.error} />
      ) : messages.status === "loading" || !chat ? (
        <ColumnBones />
      ) : (
        <Column workspaceId={workspaceId} chatId={chatId} since={newSince(chat)} page={messages.value} />
      )}
      {detail.status === "ready" && detail.value ? <Composer workspaceId={workspaceId} detail={detail.value} /> : null}
    </div>
  );
}

// ── The toolbar ──

/** Where a conversation opens in its own app, when that is a web address. */
const linkOf = (detail: ChatDetail | undefined): string | undefined => (detail?.link && /^https?:\/\//i.test(detail.link) ? detail.link : undefined);

function Toolbar({ workspaceId, detail, narrow, onBack }: { workspaceId: string; detail: ChatDetail | null | undefined; narrow: boolean; onBack: () => void }) {
  const data = useMessagesData();
  const now = data.useNow();
  const chat = detail?.chat;
  const link = linkOf(detail ?? undefined);
  const verbs = chat ? threadRows(chat, false) : [];
  const start = verbs.find((row) => row.kind === "item" && row.id === "start-thread");
  // Under 640px the list and its sync line are hidden: this conversation's own source says it here, once.
  const line = narrow && detail?.source ? syncLine([detail.source], now) : null;
  const rows = (): MenuRow[] =>
    chat
      ? tidy([
          chat.unread ? { kind: "item", id: "read", label: "Mark read" } : { kind: "item", id: "unread", label: "Mark unread" },
          ...verbs.filter((row) => row !== start),
          { kind: "sep" },
          ...(link
            ? ([
                { kind: "item", id: "open", label: `Open in ${SOURCE_APP[chat.source]}`, icon: ExternalLink },
                { kind: "item", id: "copy", label: "Copy link", icon: Copy },
              ] as MenuRow[])
            : []),
        ])
      : [];
  const pick = (id: string): void => {
    if (!chat) return;
    if (id === "read") data.markRead(chat._id);
    else if (id === "unread") data.markUnread(chat._id);
    else if (id === "open" && link) void openUrl(link);
    else if (id === "copy" && link)
      void navigator.clipboard?.writeText(link).then(
        () => loadToast().then((toast) => toast("Link copied")),
        () => loadToast().then((toast) => toast.error("Couldn't copy the link")),
      );
  };
  // A direct chat's name opens the person in People, where LifeOS knows an address for them.
  const person = chat?.kind === "direct" ? detail?.email : undefined;
  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex h-11 items-center gap-0.5 px-2">
        {narrow ? (
          <Tip label="Back to Messages">
            <Button variant="ghost" size="icon-sm" aria-label="Back to Messages" className="text-muted-foreground" onClick={onBack}>
              <ArrowLeft />
            </Button>
          </Tip>
        ) : null}
        <div className={cn("flex min-w-0 flex-1 items-baseline gap-2", narrow ? "ps-1" : "ps-2")}>
          {!chat ? (
            <Skeleton className="h-3 w-32 self-center" />
          ) : person ? (
            <Button variant="link" className="h-auto min-w-0 shrink p-0 text-[13px] font-semibold text-foreground" onClick={() => openWorkView({ workspaceId, view: "people", person })}>
              <span className="truncate">{chat.name}</span>
            </Button>
          ) : (
            <h2 className="min-w-0 truncate text-[13px] leading-5 font-semibold text-foreground">{chat.name}</h2>
          )}
          {chat ? <span className="min-w-0 shrink-[2] truncate text-xs text-muted-foreground">{chatFact(chat)}</span> : null}
        </div>
        {start && start.kind === "item" ? (
          <Tip label={start.label}>
            <Button variant="ghost" size="icon-sm" aria-label={start.label} className="text-muted-foreground">
              {start.icon ? <start.icon /> : null}
            </Button>
          </Tip>
        ) : null}
        <RowsMenu
          label="More"
          align="end"
          className="min-w-48"
          rows={rows}
          onPick={pick}
          tip={{ label: "More" }}
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label="More" disabled={!chat} className="text-muted-foreground">
              <MoreHorizontal />
            </Button>
          }
        />
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
function Column({ workspaceId, chatId, since, page }: { workspaceId: string; chatId: string; since: number | null; page: Paged<ChatMessage> }) {
  const data = useMessagesData();
  const now = data.useNow();
  // "New" is fixed as the conversation opens: reading it does not move the line away.
  const [openedSince] = useState(since);
  const blocks = useMemo(() => blocksOf(page.rows, openedSince, now, page.done), [page.rows, openedSince, now, page.done]);
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
  /** Opening over "New": the block, until the window's true height places it. */
  const openOnNew = useRef<number | null>(null);
  const opened = useRef(false);
  const newest = useRef<string | undefined>(undefined);
  /** Messages from others that came while he was up the column ("2 new"). */
  const unseen = useRef(0);
  /** Messages that came while he was at the foot: they rise in as they are drawn. */
  const arrived = useRef(new Set<string>());

  /** Places the window `up` pixels over the foot. */
  const goTo = (up: number): void => {
    view.current.up = Math.max(0, up);
    atFoot.current = view.current.up <= AT_FOOT;
    anchor.current = atFoot.current ? null : layout.anchorAt(view.current.up);
  };
  const overNew = (index: number): number => layout.offsetOf(index + 1) + NEW_AIR - view.current.height;

  // Where the column opens: over "New", else where he left it, else its foot.
  if (!opened.current && upward.length) {
    opened.current = true;
    newest.current = upward[0]!.id;
    const fresh = upward.findIndex((block) => block.isNew);
    const kept = placeOf(workspaceId, chatId);
    if (fresh >= 0) openOnNew.current = fresh;
    goTo(fresh >= 0 ? overNew(fresh) : kept ? (layout.scrollTopFor(kept) ?? 0) : 0);
  }

  // Newer messages at the foot: he sees them rise in if he is there, else they count toward "2 new".
  const top = upward[0];
  if (top && newest.current && top.id !== newest.current) {
    const before = upward.findIndex((block) => block.id === newest.current);
    const came = before > 0 ? upward.slice(0, before) : [];
    newest.current = top.id;
    if (atFoot.current) for (const block of came) arrived.current.add(block.id);
    else unseen.current += came.filter((block) => !block.message.who.me).length;
  }

  const range = layout.range(view.current.up, view.current.height, OVERSCAN);
  const shown = upward.slice(range.start, range.end);

  // After each draw: measure what is drawn, keep his place against any change under it, and draw again if the window reaches past what is drawn.
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
    if (openOnNew.current !== null && el.clientHeight) {
      goTo(overNew(openOnNew.current));
      openOnNew.current = null;
    } else if (atFoot.current) view.current.up = 0;
    else if (anchor.current) view.current.up = layout.scrollTopFor(anchor.current) ?? view.current.up + anchorShift(changes, layout.indexOf(anchor.current.key));
    // The column-reverse scroller counts from its foot: 0 there, negative going up.
    if (Math.abs(-el.scrollTop - view.current.up) > 0.5) el.scrollTop = -view.current.up;
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
    if (!atFoot.current) arrived.current.clear();
    else if (unseen.current) {
      unseen.current = 0;
      redraw();
    }
    if (!page.done && view.current.up + view.current.height > layout.total() - LOAD_AHEAD) page.more();
    const next = layout.range(view.current.up, view.current.height, OVERSCAN / 2);
    if (next.start < range.start || next.end > range.end) redraw();
  };

  // A conversation shorter than its window asks for older messages at once.
  useEffect(() => {
    if (!page.done && layout.total() < view.current.height + LOAD_AHEAD) page.more();
  }, [page, layout]);

  const toFoot = (): void => {
    goTo(0);
    keepPlace(workspaceId, chatId, null);
    unseen.current = 0;
    redraw();
  };

  if (!blocks.length) return <EmptyState title="No messages yet" />;
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} data-column className="flex h-full flex-col-reverse overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
        <div className={cn(COLUMN, "pt-4 pb-5")} role="log" aria-label="Messages">
          <div aria-hidden style={{ height: layout.total() - layout.offsetOf(range.end) }} />
          {shown
            .slice()
            .reverse()
            .map((block: Block) => (
              <MessageBlock key={block.id} block={block} arrives={arrived.current.has(block.id)} workspaceId={workspaceId} chatId={chatId} />
            ))}
          <div aria-hidden style={{ height: layout.offsetOf(range.start) }} />
        </div>
      </div>
      {unseen.current > 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          {/* It floats over the column, so its fills stay opaque: muted on hover, foreground/12 over that on a press. */}
          <Button
            variant="ghost"
            size="sm"
            rounded
            onClick={toFoot}
            className="pointer-events-auto border border-border bg-popover ps-3 pe-2.5 text-muted-foreground shadow-overlay hover:bg-muted hover:text-foreground active:bg-muted active:bg-linear-to-b active:from-foreground/12 active:to-foreground/12"
          >
            {unseen.current} new
            <ChevronDown />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** While the messages load: runs in their own shape, at the column's foot where they will land. */
export function ColumnBones() {
  const runs = [
    [62, 40],
    [48],
    [70, 55, 30],
  ];
  return (
    <div aria-busy aria-label="Loading messages" className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
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
