import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { syncLine, type ChatHit, type ChatRow } from "@shared/work/messages";
import { useWindowed } from "work-kit/mail/lib/window";
import { ChevronDown, Circle, Check, CircleDot, Search, X } from "../../chrome/icons";
import { RowsContextMenu, RowsMenu, tidy, type MenuRow } from "../../chrome/menuRows";
import { Tip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { GroupInput, InputGroup } from "../../components/ui/input";
import { reveal, yields } from "../../components/ui/reveal";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { Face } from "../mail/face";
import { Hash } from "../icons";
import { openConnections } from "../shell/open";
import { useMessagesData } from "./data";
import { aroundMatch, CHAT_FILTERS, FILTER_EMPTY, FILTER_LABEL, FILTER_ROW, markWords, rowLine, rowTime, threadRows, type ChatFilter } from "./model";
import { keepListTop, listTopOf, patchPage, usePage } from "./page";

/**
 * The list of a job's conversations (docs/agents/work-messages.md "The
 * list"): the 44px head with the filter menu and the unread count, the 28px
 * search, the sync line while a source is stale, then the rows, newest first,
 * drawn only near the window. A search shows the messages that hold its words
 * in the rows' place.
 */

/** A row's height and the hairline of air under it. */
export const ROW_HEIGHT = 48;
const ROW_GAP = 1;
const SLOT = ROW_HEIGHT + ROW_GAP;
/** Rows of bones while the list loads. */
const BONES = 8;

/** A row's columns, shared with its bones: the gutter for the unread dot, the face in a 24px slot with 8px after it, the words. */
const ROW_GRID = "grid grid-cols-[20px_32px_minmax(0,1fr)] content-start py-1 ps-1 pe-2.5";
/** The face's cell: 32px from the row's top with the face at its foot, level with the two lines. */
const FACE_CELL = "row-span-2 flex h-8 items-end self-start";
/** An empty list's words, at the middle of the whole column (its head and search included), level with the pane's. */
const LIST_EMPTY = "pointer-events-none absolute inset-0 max-w-none";

export function ChatList({ workspaceId, job, onOpen }: { workspaceId: string; job: string; onOpen: (chatId: string) => void }) {
  const data = useMessagesData();
  const page = usePage(workspaceId);
  const sources = data.useSources();
  const now = data.useNow();
  const line = sources.status === "ready" ? syncLine(sources.value, now) : null;
  const query = useDeferredValue(page.query.trim());
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ListHead filter={page.filter} onFilter={(filter) => patchPage(workspaceId, { filter })} />
      <SearchField workspaceId={workspaceId} query={page.query} />
      {line ? (
        <p data-sync-line className="shrink-0 truncate px-4 pb-2 text-xs text-muted-foreground">
          {line}
        </p>
      ) : null}
      {query ? (
        <SearchHits workspaceId={workspaceId} query={query} openId={page.chatId} onOpen={onOpen} />
      ) : (
        // Keyed by the filter: another filter is another list, its own place and its own pages.
        <ChatRows key={page.filter} workspaceId={workspaceId} job={job} filter={page.filter} openId={page.chatId} linked={sources.status === "ready" ? sources.value.length > 0 : null} onOpen={onOpen} />
      )}
    </div>
  );
}

// ── The head ──

function ListHead({ filter, onFilter }: { filter: ChatFilter; onFilter: (filter: ChatFilter) => void }) {
  const unread = useMessagesData().useUnread();
  const rows = (): MenuRow[] => CHAT_FILTERS.map((f) => ({ kind: "item", id: f, label: FILTER_ROW[f], checked: f === filter }));
  return (
    <div className="flex h-11 shrink-0 items-center px-2">
      <RowsMenu
        label="Show"
        align="start"
        className="min-w-44"
        rows={rows}
        onPick={(id) => onFilter(id as ChatFilter)}
        trigger={
          <Button variant="ghost" size="sm" className="gap-1.5 px-2 font-semibold aria-expanded:bg-foreground/5">
            {FILTER_LABEL[filter]}
            {unread ? <span className="font-normal text-muted-foreground tabular-nums">{unread}</span> : null}
            <ChevronDown className="size-3 text-muted-foreground" />
          </Button>
        }
      />
    </div>
  );
}

function SearchField({ workspaceId, query }: { workspaceId: string; query: string }) {
  const field = useRef<HTMLInputElement>(null);
  const clear = (): void => patchPage(workspaceId, { query: "" });
  return (
    <div className="shrink-0 px-3 pb-2">
      <InputGroup
        role="search"
        className="h-7 rounded-md px-2"
        leading={<Search />}
        trailing={
          query ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear search"
              // The field keeps its focus: a press here must not blur it first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                clear();
                field.current?.focus();
              }}
            >
              <X />
            </Button>
          ) : null
        }
      >
        <GroupInput
          ref={field}
          type="search"
          aria-label="Search messages"
          placeholder="Search messages"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => patchPage(workspaceId, { query: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            if (query) clear();
            else field.current?.blur();
          }}
          className="[&::-webkit-search-cancel-button]:hidden"
        />
      </InputGroup>
    </div>
  );
}

// ── The rows ──

function ChatRows({ workspaceId, job, filter, openId, linked, onOpen }: { workspaceId: string; job: string; filter: ChatFilter; openId: string | null; linked: boolean | null; onOpen: (chatId: string) => void }) {
  const data = useMessagesData();
  const chats = data.useChats(filter);
  if (chats.status === "failed") return <ListEmpty title="Messages did not load" />;
  // Held until the sources answer too, so an empty job says its true cause the first time.
  if (chats.status === "loading" || (chats.value.rows.length === 0 && linked === null)) return <RowBones />;
  const { rows } = chats.value;
  if (rows.length === 0) {
    if (filter !== "all") return <ListEmpty title={FILTER_EMPTY[filter]} action={{ label: "Clear filter", onClick: () => patchPage(workspaceId, { filter: "all" }) }} />;
    if (!linked) return <ListEmpty title={`No chat is linked to ${job}`} action={{ label: "Open Connections", onClick: openConnections }} />;
    return <ListEmpty title={`No messages in ${job} yet`} />;
  }
  return <RowsWindow workspaceId={workspaceId} rows={rows} done={chats.value.done} more={chats.value.more} openId={openId} onOpen={onOpen} />;
}

function RowsWindow({ workspaceId, rows, done, more, openId, onOpen }: { workspaceId: string; rows: readonly ChatRow[]; done: boolean; more: () => void; openId: string | null; onOpen: (chatId: string) => void }) {
  const data = useMessagesData();
  const now = data.useNow();
  const drafted = data.useDrafted();
  const scroller = useRef<HTMLDivElement>(null);
  const range = useWindowed(scroller, SLOT, rows.length);
  // Back where he left the list.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = listTopOf(workspaceId);
  }, [workspaceId]);
  // The next page, as he nears the end of this one.
  useEffect(() => {
    if (!done && range.end >= rows.length - 20) more();
  }, [done, range.end, rows.length, more]);
  const byId = useMemo(() => new Map(rows.map((row) => [row._id, row])), [rows]);
  const menu = (id: string | null): MenuRow[] | null => {
    const row = id ? byId.get(id) : undefined;
    if (!row) return null;
    return tidy([{ kind: "item", id: row.unread ? "read" : "unread", label: row.unread ? "Mark read" : "Mark unread" }, { kind: "sep" }, ...threadRows(row, false)]);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = openId ? rows.findIndex((row) => row._id === openId) : -1;
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + step))];
    if (!next) return;
    onOpen(next._id);
    const el = scroller.current;
    if (!el) return;
    const index = rows.indexOf(next);
    if (index * SLOT < el.scrollTop) el.scrollTop = index * SLOT;
    else if ((index + 1) * SLOT > el.scrollTop + el.clientHeight) el.scrollTop = (index + 1) * SLOT - el.clientHeight;
  };
  return (
    <div ref={scroller} onScroll={(event) => keepListTop(workspaceId, event.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <RowsContextMenu lazyMount label="Conversation" rowsFor={menu} onPick={(pick, id) => id && (pick === "read" ? data.markRead(id) : pick === "unread" ? data.markUnread(id) : undefined)}>
        {/* One tab stop: the arrow keys move the open conversation, which the list names as its active row. */}
        <div role="listbox" tabIndex={0} aria-label="Conversations" aria-activedescendant={openId && byId.has(openId) ? rowId(openId) : undefined} onKeyDown={keys} className="group/list px-1.5 pb-1.5 outline-none">
          <div aria-hidden style={{ height: range.start * SLOT }} />
          {rows.slice(range.start, range.end).map((row) => (
            <ChatRowView key={row._id} row={row} open={row._id === openId} drafted={drafted.has(row._id)} now={now} onOpen={onOpen} onRead={data.markRead} onUnread={data.markUnread} />
          ))}
          <div aria-hidden style={{ height: (rows.length - range.end) * SLOT }} />
        </div>
      </RowsContextMenu>
    </div>
  );
}

const rowId = (id: string): string => `chat-row-${id}`;

/** The 24px face slot: the person of a direct chat, two lapped faces for a group, the channel's glyph. */
function RowFace({ row }: { row: Pick<ChatRow, "kind" | "name" | "faces"> }) {
  if (row.kind === "channel" || (row.kind !== "direct" && row.name.startsWith("#"))) {
    return (
      <span aria-hidden className="grid size-6 place-items-center rounded-full bg-muted text-muted-foreground">
        <Hash className="size-3.5" />
      </span>
    );
  }
  if (row.kind === "group" && row.faces.length > 1) {
    const [a, b] = row.faces;
    return (
      <span aria-hidden className="relative size-6">
        <Face name={a!.name} picture={a!.picture} size="chip" className="absolute start-0 top-0" />
        <Face name={b!.name} picture={b!.picture} size="chip" className="absolute end-0 bottom-0 ring-2 ring-background" />
      </span>
    );
  }
  const who = row.faces[0];
  return <Face name={who?.name ?? row.name} picture={who?.picture} size="row" />;
}

/** A conversation as a screen reader says it: "Unread, Dana Lee, Also, the art team…, 3:31 PM". */
const rowLabel = (row: ChatRow, time: string, drafted: boolean): string => [row.unread ? "Unread" : "", row.name, rowLine(row), time, drafted ? "a draft waits" : ""].filter(Boolean).join(", ");

/**
 * One conversation, 48px: the unread dot, the face, the name (600 and ink when
 * unread) with the time at its end, the newest words under it. Under the
 * pointer the time gives way to Mark read or Mark unread. Memoised: a list
 * re-renders only the rows that changed.
 */
const ChatRowView = memo(function ChatRowView({ row, open, drafted, now, onOpen, onRead, onUnread }: { row: ChatRow; open: boolean; drafted: boolean; now: number; onOpen: (id: string) => void; onRead: (id: string) => void; onUnread: (id: string) => void }) {
  const time = rowTime(row.lastAt, now);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the list's keys move the open row
    <div
      role="option"
      id={rowId(row._id)}
      aria-selected={open}
      aria-label={rowLabel(row, time, drafted)}
      data-menu-id={row._id}
      data-unread={row.unread || undefined}
      onClick={() => onOpen(row._id)}
      style={{ height: ROW_HEIGHT, marginBottom: ROW_GAP }}
      className={cn(
        "group/row relative cursor-default rounded-md select-none",
        ROW_GRID,
        open ? "bg-foreground/9 group-focus-visible/list:outline-2 group-focus-visible/list:-outline-offset-2 group-focus-visible/list:outline-accent" : "hover:bg-foreground/5",
      )}
    >
      <span className="row-span-2 grid h-5 w-4 place-items-center self-start">{row.unread ? <i aria-hidden className="size-1.5 rounded-full bg-foreground" /> : null}</span>
      <span className={FACE_CELL}>
        <RowFace row={row} />
      </span>
      <span className="flex h-5 min-w-0 items-center text-[13px]">
        <span className={cn("min-w-0 truncate", row.unread ? "font-semibold text-foreground" : "text-muted-foreground")}>{row.name}</span>
        <span className={cn("ms-auto flex shrink-0 items-center gap-1 ps-2 text-xs text-muted-foreground tabular-nums", yields("row"))}>
          {drafted ? <CircleDot aria-hidden className="size-3.5 text-warning" /> : null}
          <time>{time}</time>
        </span>
      </span>
      <span dir="auto" className="h-5 truncate text-start text-xs leading-5 text-muted-foreground">
        {rowLine(row)}
      </span>
      {/* Under the pointer the time gives way to what he most often does to a row. */}
      <span className={cn("absolute end-1.5 top-1", reveal("row", { overlay: true }))}>
        <Tip label={row.unread ? "Mark read" : "Mark unread"}>
          <Button
            variant="ghost"
            size="icon-xs"
            tabIndex={-1}
            aria-label={row.unread ? "Mark read" : "Mark unread"}
            className="text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              // The row under it would open.
              event.stopPropagation();
              (row.unread ? onRead : onUnread)(row._id);
            }}
          >
            {row.unread ? <Check /> : <Circle />}
          </Button>
        </Tip>
      </span>
    </div>
  );
});

/** Rows of bones in the row's own grid and height, so nothing moves when the list lands. */
export function RowBones() {
  return (
    <div aria-hidden data-row-bones className="min-h-0 flex-1 overflow-hidden px-1.5">
      {Array.from({ length: BONES }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed bones that never reorder
        <div key={i} style={{ height: ROW_HEIGHT, marginBottom: ROW_GAP }} className={ROW_GRID}>
          <span className="row-span-2" />
          <span className={FACE_CELL}>
            <Skeleton className="size-6 rounded-full" />
          </span>
          <span className="flex h-5 items-center justify-between gap-6">
            <Skeleton className="h-3" style={{ width: `${[44, 30, 52, 36, 48, 28, 40, 34][i]}%` }} />
            <Skeleton className="h-2.5 w-9" />
          </span>
          <span className="flex h-5 items-center">
            <Skeleton className="h-2.5" style={{ width: `${[78, 64, 86, 70, 58, 82, 66, 74][i]}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function ListEmpty({ title, action }: { title: string; action?: { label: string; onClick: () => void } }) {
  return (
    <Empty className={LIST_EMPTY}>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
      {action ? (
        <Button size="sm" variant="secondary" className="pointer-events-auto" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </Empty>
  );
}

// ── A search ──

/** Text with a search's words in ink, where a word starts. */
function Lit({ text, query }: { text: string; query: string }): ReactNode {
  return markWords(text, query).map(([part, hit], i) =>
    hit ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text, in order
      <mark key={i} className="bg-transparent font-medium text-foreground">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/** The messages that hold the words: the conversation's name and the time, then who wrote and the words, lit. */
function SearchHits({ workspaceId, query, openId, onOpen }: { workspaceId: string; query: string; openId: string | null; onOpen: (chatId: string) => void }) {
  const data = useMessagesData();
  const now = data.useNow();
  const hits = data.useSearch(query);
  // A hit's conversation, where the list already holds it, lends the hit its face.
  const chats = data.useChats("all");
  const known = useMemo(() => new Map((chats.status === "ready" ? chats.value.rows : []).map((row) => [row._id, row])), [chats]);
  if (hits.status === "failed") return <ListEmpty title="The search did not run" />;
  if (hits.status === "loading") return <RowBones />;
  if (hits.value.length === 0) return <ListEmpty title="No matches" action={{ label: "Clear search", onClick: () => patchPage(workspaceId, { query: "" }) }} />;
  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <div role="listbox" aria-label="Search results" className="px-1.5 pb-1.5">
        {hits.value.map((hit) => (
          <HitRow key={hit.messageId} hit={hit} row={known.get(hit.chatId)} query={query} open={hit.chatId === openId} now={now} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function HitRow({ hit, row, query, open, now, onOpen }: { hit: ChatHit; row: ChatRow | undefined; query: string; open: boolean; now: number; onOpen: (id: string) => void }) {
  const kind = row?.kind ?? (hit.chat.startsWith("#") ? "channel" : "direct");
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a result opens on a press, as a row does
    <div
      role="option"
      aria-selected={open}
      tabIndex={0}
      data-hit={hit.messageId}
      onClick={() => onOpen(hit.chatId)}
      onKeyDown={(event) => event.key === "Enter" && onOpen(hit.chatId)}
      style={{ height: ROW_HEIGHT, marginBottom: ROW_GAP }}
      className={cn("relative cursor-default rounded-md select-none", ROW_GRID, open ? "bg-foreground/9" : "hover:bg-foreground/5")}
    >
      <span className="row-span-2" />
      <span className={FACE_CELL}>
        <RowFace row={row ?? { kind, name: hit.chat, faces: [{ name: hit.who }] }} />
      </span>
      <span className="flex h-5 min-w-0 items-center text-[13px]">
        <span className="min-w-0 truncate text-foreground">{hit.chat}</span>
        <time className="ms-auto shrink-0 ps-2 text-xs text-muted-foreground tabular-nums">{rowTime(hit.at, now)}</time>
      </span>
      <span dir="auto" className="h-5 truncate text-start text-xs leading-5 text-muted-foreground">
        {`${hit.who}: `}
        <Lit text={aroundMatch(hit.text, query)} query={query} />
      </span>
    </div>
  );
}
