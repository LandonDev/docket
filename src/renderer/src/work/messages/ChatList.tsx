import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
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
import { aroundMatch, CHAT_FILTERS, cutToFit, FILTER_EMPTY, FILTER_LABEL, FILTER_ROW, firstName, markWords, menuKey, rowLine, rowTime, type ChatFilter } from "./model";
import { chatChip, linkRows, mentionTarget, pickThreadVerb, threadRows, useStartThread } from "./threads";
import { keepListTop, listTopOf, markUnreadHeld, openedFrom, patchPage, peekReturn, returnToTop, takeReturn, usePage } from "./page";

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

/**
 * `shown`: whether the list is on screen. Under 640px it stays mounted, hidden, while a conversation is open, so
 * coming back takes the keys where they stood as it shows again rather than as it mounts.
 */
export function ChatList({ workspaceId, job, narrow, shown = true, onOpen }: { workspaceId: string; job: string; narrow: boolean; shown?: boolean; onOpen: (chatId: string, messageId?: string) => void }) {
  // Retry asks LifeOS afresh: the list's reads are mounted again. The press takes its own button away, so when it held
  // the keys the list's pane holds them while the read runs (a stable target, as the Outbox quote's slot), and what
  // lands takes them from it: the rows, a result list, or an empty list's action.
  const [attempt, setAttempt] = useState(0);
  const pane = useRef<HTMLDivElement>(null);
  const keep = useRef(false);
  const retry = useCallback(() => {
    keep.current = pane.current?.contains(document.activeElement) ?? false;
    setAttempt((n) => n + 1);
  }, []);
  useLayoutEffect(() => {
    if (!keep.current) return;
    keep.current = false;
    const fell = document.activeElement === null || document.activeElement === document.body;
    if (!fell) return;
    // What landed in this same render takes the keys at once (the rows, a result list, an empty list's action); else the
    // pane holds them, and what lands later takes them from it.
    const landed = pane.current?.querySelector<HTMLElement>("[role=listbox], [data-slot=empty] button");
    (landed ?? pane.current)?.focus({ preventScroll: true });
  }, [attempt]);
  return (
    <div ref={pane} tabIndex={-1} data-list-pane className="focus-ring flex h-full min-h-0 flex-col">
      <ListBody key={attempt} workspaceId={workspaceId} job={job} narrow={narrow} shown={shown} onOpen={onOpen} retry={retry} />
    </div>
  );
}

/** Whether the list's pane holds the keys for a Retry's read: what lands takes them. */
const paneHoldsKeys = (): boolean => document.activeElement?.hasAttribute("data-list-pane") ?? false;

/** Whether the job has a chat source: yes, no, not known yet, or the sources did not load. */
type Linked = boolean | null | "failed";

function ListBody({ workspaceId, job, narrow, shown, onOpen, retry }: { workspaceId: string; job: string; narrow: boolean; shown: boolean; onOpen: (chatId: string, messageId?: string) => void; retry: () => void }) {
  const data = useMessagesData();
  const page = usePage(workspaceId);
  const sources = data.useSources();
  const now = data.useNow();
  const line = sources.status === "ready" ? syncLine(sources.value, now) : null;
  const query = useDeferredValue(page.query.trim());
  const linked: Linked = sources.status === "ready" ? sources.value.length > 0 : sources.status === "failed" ? "failed" : null;
  // Clear search hands the keys to the search field, so the next keys type there.
  const searchField = useRef<HTMLInputElement>(null);
  const clearSearch = useCallback(() => {
    takeReturn(workspaceId);
    patchPage(workspaceId, { query: "" });
    searchField.current?.focus();
  }, [workspaceId]);
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ListHead filter={page.filter} searching={query !== ""} onFilter={(filter) => patchPage(workspaceId, { filter })} />
      <SearchField workspaceId={workspaceId} query={page.query} field={searchField} />
      {line && shown ? (
        <p data-sync-line className="shrink-0 px-4 pb-2 text-xs text-muted-foreground">
          {line}
        </p>
      ) : null}
      {query ? (
        <SearchHits workspaceId={workspaceId} query={query} narrow={narrow} shown={shown} onOpen={onOpen} onClear={clearSearch} retry={retry} />
      ) : (
        // Keyed by the filter: another filter is another list, its own place and its own pages.
        <ChatRows key={page.filter} workspaceId={workspaceId} job={job} filter={page.filter} openId={page.chatId} linked={linked} narrow={narrow} shown={shown} onOpen={onOpen} retry={retry} />
      )}
    </div>
  );
}

/** A failure's one action. */
const retryOf = (retry: () => void) => ({ label: "Retry", onClick: retry });

// ── The head ──

function ListHead({ filter, searching, onFilter }: { filter: ChatFilter; searching: boolean; onFilter: (filter: ChatFilter) => void }) {
  const unread = useMessagesData().useUnread();
  const rows = (): MenuRow[] => CHAT_FILTERS.map((f) => ({ kind: "item", id: f, label: FILTER_ROW[f], checked: f === filter }));
  // A search reads the whole job, so the head says "Messages" while it runs. The job's unread count stands only where it
  // counts what is listed: beside All and Unread.
  const shown = searching ? "all" : filter;
  const count = shown === "all" || shown === "unread" ? unread : null;
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
            {FILTER_LABEL[shown]}
            {count ? <span className="font-normal text-muted-foreground tabular-nums">{count}</span> : null}
            <ChevronDown className="size-3 text-muted-foreground" />
          </Button>
        }
      />
    </div>
  );
}

function SearchField({ workspaceId, query, field }: { workspaceId: string; query: string; field: RefObject<HTMLInputElement | null> }) {
  // One way to clear the words, for × and Escape alike: the way back belonged to them, so it goes first.
  const clear = (): void => {
    takeReturn(workspaceId);
    patchPage(workspaceId, { query: "" });
  };
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
          onChange={(event) => {
            // New words are a new search: the way back belonged to the words he left.
            takeReturn(workspaceId);
            patchPage(workspaceId, { query: event.currentTarget.value });
          }}
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

function ChatRows({
  workspaceId,
  job,
  filter,
  openId,
  linked,
  narrow,
  shown,
  onOpen,
  retry,
}: {
  workspaceId: string;
  job: string;
  filter: ChatFilter;
  openId: string | null;
  linked: Linked;
  narrow: boolean;
  shown: boolean;
  onOpen: (chatId: string) => void;
  retry: () => void;
}) {
  const data = useMessagesData();
  const chats = data.useChats(filter);
  // Whether the rows held the keys: when his reading takes the last row off a filtered list, the list goes from under
  // the keys, and they pass to Clear filter rather than fall to the page.
  const hadKeys = useRef(false);
  const heldKeys = useCallback(() => hadKeys.current, []);
  const onKeys = useCallback((on: boolean) => void (hadKeys.current = on), []);
  // A failure on his way back gives Retry the keys and keeps the way back for the list Retry brings.
  if (chats.status === "failed") return <ListEmpty title="Messages did not load" action={retryOf(retry)} returns={{ workspaceId, shown, keep: true }} />;
  if (chats.status === "loading") return <RowBones />;
  const { rows } = chats.value;
  if (rows.length === 0) {
    // Come back to a list his reading emptied, the keys go to Clear filter.
    // Clear filter leaves the keys to the whole list, on its first row.
    if (filter !== "all") return <ListEmpty title={FILTER_EMPTY[filter]} action={{ label: "Clear filter", onClick: () => (returnToTop(workspaceId), patchPage(workspaceId, { filter: "all" })) }} returns={{ workspaceId, shown }} takesKeys={heldKeys} />;
    // Held until the sources answer too, so an empty job says its true cause the first time; sources that did not load
    // leave the cause unknown, which is a list that did not load.
    if (linked === null) return <RowBones />;
    if (linked === "failed") return <ListEmpty title="Messages did not load" action={retryOf(retry)} />;
    if (!linked) return <ListEmpty title={`No chat is linked to ${job}`} action={{ label: "Open Connections", onClick: openConnections }} />;
    return <ListEmpty title={`No messages in ${job} yet`} />;
  }
  return <RowsWindow workspaceId={workspaceId} filter={filter} rows={rows} done={chats.value.done} more={chats.value.more} openId={openId} narrow={narrow} shown={shown} onOpen={onOpen} onKeys={onKeys} />;
}

function RowsWindow({
  workspaceId,
  filter,
  rows,
  done,
  more,
  openId,
  narrow,
  shown,
  onOpen,
  onKeys,
}: {
  workspaceId: string;
  filter: ChatFilter;
  rows: readonly ChatRow[];
  done: boolean;
  more: () => void;
  openId: string | null;
  narrow: boolean;
  shown: boolean;
  onOpen: (chatId: string) => void;
  /** Whether the listbox holds the keys, for the list around it. */
  onKeys: (on: boolean) => void;
}) {
  const data = useMessagesData();
  const now = data.useNow();
  const drafted = data.useDrafted();
  const scroller = useRef<HTMLDivElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const range = useWindowed(scroller, SLOT, rows.length);
  const byId = useMemo(() => new Map(rows.map((row) => [row._id, row])), [rows]);
  // The row the keys stand on. Beside the conversation it is the open one; under 640px, where opening hides the
  // list, the arrows move it and Enter opens it.
  const [active, setActive] = useState<string | null>(openId);
  useEffect(() => {
    if (!narrow) setActive(openId);
  }, [openId, narrow]);
  const show = (id: string): void => {
    const el = scroller.current;
    const index = rows.findIndex((row) => row._id === id);
    if (!el || index < 0) return;
    if (index * SLOT < el.scrollTop) el.scrollTop = index * SLOT;
    else if ((index + 1) * SLOT > el.scrollTop + el.clientHeight) el.scrollTop = (index + 1) * SLOT - el.clientHeight;
  };
  // Where the keys stood, by index: when the row they stood on leaves the list (read, under Unread), the row now at its
  // index becomes the active one, marked and named to a screen reader, so Enter and the menu key act on a row he sees.
  const keptAt = useRef(0);
  useLayoutEffect(() => {
    const at = active ? rows.findIndex((row) => row._id === active) : -1;
    if (at >= 0) keptAt.current = at;
    else if (active && rows.length) setActive(rows[Math.min(keptAt.current, rows.length - 1)]!._id);
  });
  // Back where he left this list as it shows; and, come back from a conversation under 640px, the keys on the row he left.
  useLayoutEffect(() => {
    if (!shown) return;
    if (paneHoldsKeys()) listbox.current?.focus({ preventScroll: true });
    const el = scroller.current;
    if (el) el.scrollTop = listTopOf(workspaceId, filter);
    // The row he left, or, gone from this list meanwhile (read, under Unread), the one now in its place.
    const back = takeReturn(workspaceId);
    const target = back ? (rows.some((row) => row._id === back.chatId) ? back.chatId : rows[Math.min(back.index, rows.length - 1)]?._id) : undefined;
    if (target) {
      setActive(target);
      show(target);
      listbox.current?.focus({ preventScroll: true });
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: once each time the list shows
  }, [workspaceId, filter, shown]);
  // The next page, as he nears the end of this one.
  useEffect(() => {
    if (!done && range.end >= rows.length - 20) more();
  }, [done, range.end, rows.length, more]);
  // Opening notes where the keys stood, so Back can hand them back there.
  const open = useCallback(
    (chatId: string): void => {
      openedFrom(workspaceId, { chatId, index: Math.max(0, rows.findIndex((row) => row._id === chatId)) });
      onOpen(chatId);
    },
    [workspaceId, rows, onOpen],
  );
  // Mark unread on the open conversation is held from the command, so its reader does not mark it read again.
  const markUnread = useCallback((id: string) => markUnreadHeld(data.markUnread, workspaceId, byId.get(id) ?? { _id: id }, id === openId), [data, workspaceId, byId, openId]);
  const start = useStartThread();
  const menuAt = useRef<((at: { x: number; y: number; id: string | null }) => void) | null>(null);
  const menu = (id: string | null): MenuRow[] | null => {
    const row = id ? byId.get(id) : undefined;
    if (!row) return null;
    return tidy([
      { kind: "item", id: row.unread ? "read" : "unread", label: row.unread ? "Mark read" : "Mark unread" },
      { kind: "sep" },
      ...threadRows(mentionTarget() !== null, start !== null),
      { kind: "sep" },
      ...linkRows(row.source, row.link),
    ]);
  };
  const pick = (pick: string, id: string | null): void => {
    const row = id ? byId.get(id) : undefined;
    if (!row) return;
    if (pick === "read") data.markRead(row._id);
    else if (pick === "unread") markUnreadHeld(data.markUnread, workspaceId, row, row._id === openId);
    else pickThreadVerb(pick, chatChip(row), start, row.link);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const found = active ? rows.findIndex((row) => row._id === active) : -1;
    if (menuKey(event)) {
      if (!active) return;
      event.preventDefault();
      menuAt.current?.({ x: 0, y: 0, id: active });
      return;
    }
    if (event.key === "Enter" && active) {
      event.preventDefault();
      open(active);
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    // Beside the conversation the arrows open rows. When the active row is not the open one (the open row left the list,
    // read under Unread, and the row now at its index took the keys; or the open conversation is not in this list),
    // Down opens that row itself rather than stepping past it; Up steps as ever. Under 640px Down moves from it.
    const inPlace = !narrow && step > 0 && active !== null && active !== openId && found >= 0;
    const next = inPlace ? rows[found] : rows[Math.max(0, Math.min(rows.length - 1, found + step))];
    if (!next) return;
    setActive(next._id);
    if (!narrow) open(next._id);
    show(next._id);
  };
  // The list names its active row only while that row is drawn; else it wears the ring itself.
  const activeAt = active ? rows.findIndex((row) => row._id === active) : -1;
  const standing = activeAt >= range.start && activeAt < range.end;
  return (
    <div ref={scroller} onScroll={(event) => keepListTop(workspaceId, filter, event.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <RowsContextMenu lazyMount label="Conversation" rowsFor={menu} onPick={pick} openRef={menuAt}>
        {/* One tab stop: the keys move the active row, which the list names; until one is, the list wears the ring itself. */}
        <div
          ref={listbox}
          role="listbox"
          tabIndex={0}
          aria-label="Conversations"
          aria-activedescendant={standing && active ? rowId(active) : undefined}
          onKeyDown={keys}
          onFocus={() => onKeys(true)}
          onBlur={() => onKeys(false)}
          className={cn("group/list px-1.5 pb-1.5", standing ? "outline-none" : "focus-ring")}
        >
          <div aria-hidden style={{ height: range.start * SLOT }} />
          {rows.slice(range.start, range.end).map((row) => (
            <ChatRowView key={row._id} row={row} open={row._id === openId} active={row._id === active} drafted={drafted.has(row._id)} now={now} onOpen={open} onRead={data.markRead} onUnread={markUnread} />
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
      // Lapped side by side by 4px, as Mail's fold row laps them "so each keeps its initial", level with a 24px face; the
      // first leans 4px into the gutter, so the words keep their edge. The ring is the row's own fill in each state.
      <span aria-hidden className="relative mb-[3px] h-[18px] w-6">
        <Face name={a!.name} picture={a!.picture} size="chip" className="absolute -start-1 top-0" />
        <Face name={b!.name} picture={b!.picture} size="chip" className="absolute start-2.5 top-0 ring-2 ring-(--row-fill)" />
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
const ChatRowView = memo(function ChatRowView({
  row,
  open,
  active,
  drafted,
  now,
  onOpen,
  onRead,
  onUnread,
}: {
  row: ChatRow;
  open: boolean;
  /** The row the list's keys stand on: it carries the ring while the list has the keyboard. */
  active: boolean;
  drafted: boolean;
  now: number;
  onOpen: (id: string) => void;
  onRead: (id: string) => void;
  onUnread: (id: string) => void;
}) {
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
        "tc-row group/row relative cursor-default rounded-md select-none",
        ROW_GRID,
        active && "group-focus-visible/list:outline-2 group-focus-visible/list:-outline-offset-2 group-focus-visible/list:outline-accent",
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
export function RowBones({ label = "Loading conversations" }: { label?: string }) {
  return (
    <div role="status" aria-busy aria-label={label} data-row-bones className="min-h-0 flex-1 overflow-hidden px-1.5">
      {Array.from({ length: BONES }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed bones that never reorder
        <div key={i} aria-hidden style={{ height: ROW_HEIGHT, marginBottom: ROW_GAP }} className={ROW_GRID}>
          <span className="row-span-2" />
          <span className={FACE_CELL}>
            <Skeleton className="size-6 rounded-full" />
          </span>
          <span className="flex h-5 items-center justify-between gap-6">
            <Skeleton className="h-3" style={{ width: [120, 88, 148, 104, 136, 80, 112, 96][i] }} />
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

/**
 * An empty list's line and its one action. `returns`: on his way back to the list (`returnTo`), the action takes the
 * keys as the list shows; it takes the way back with it, or, `keep` (a failure's Retry), leaves it for the list Retry
 * brings.
 */
function ListEmpty({
  title,
  action,
  returns,
  takesKeys,
}: {
  title: string;
  action?: { label: string; onClick: () => void };
  returns?: { workspaceId: string; shown: boolean; keep?: boolean };
  /** Whether the list that was here held the keys when it went: the action takes them, so they never fall to the page. */
  takesKeys?: () => boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const ws = returns?.workspaceId;
  const shown = returns?.shown ?? false;
  const keep = returns?.keep ?? false;
  useLayoutEffect(() => {
    const fell = document.activeElement === null || document.activeElement === document.body;
    if ((takesKeys?.() && fell) || paneHoldsKeys()) return void button.current?.focus();
    if (!ws || !shown || !peekReturn(ws)) return;
    if (!keep) takeReturn(ws);
    button.current?.focus();
  }, [ws, shown, keep, takesKeys]);
  return (
    <Empty className={LIST_EMPTY}>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
      {action ? (
        <Button ref={button} size="sm" variant="secondary" className="pointer-events-auto" onClick={action.onClick}>
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

/**
 * The messages that hold the words: the conversation's name and the time,
 * then who wrote and the words, lit. One list as the rows are: one tab stop,
 * the arrows move the active hit (and open it beside the list; under 640px
 * Enter opens it), the fill on the message he opened.
 */
function SearchHits({
  workspaceId,
  query,
  narrow,
  shown,
  onOpen,
  onClear,
  retry,
}: {
  workspaceId: string;
  query: string;
  narrow: boolean;
  shown: boolean;
  onOpen: (chatId: string, messageId?: string) => void;
  onClear: () => void;
  retry: () => void;
}) {
  const data = useMessagesData();
  const now = data.useNow();
  const hits = data.useSearch(query);
  // A hit's conversation, where the list already holds it, lends the hit its face and its ink.
  const chats = data.useChats("all");
  const known = useMemo(() => new Map((chats.status === "ready" ? chats.value.rows : []).map((row) => [row._id, row])), [chats]);
  const [active, setActive] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  // The last answer stays while the next words are asked, as Mail's search keeps its results: typing never flashes bones.
  const [kept, setKept] = useState<readonly ChatHit[] | null>(null);
  if (hits.status === "ready" && hits.value !== kept) setKept(hits.value);
  const listbox = useRef<HTMLDivElement>(null);
  // How wide a hit's line is at this width, and the font it is drawn in, so the word it found always shows.
  const [width, setWidth] = useState(0);
  const [family, setFamily] = useState("");
  const box = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    setFamily(getComputedStyle(el).fontFamily);
    const measure = (): void => setWidth(el.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const list = hits.status === "ready" ? hits.value : kept;
  // Come back from a hit under 640px: the first answer that shows takes the way back, once. Hits put the keys on the
  // hit he left, or the one now in its place; no hits put them on Clear search (ListEmpty); a failure leaves the way back
  // for the search Retry brings, its Retry holding the keys meanwhile. Later answers, as he types, take nothing.
  useLayoutEffect(() => {
    if (!shown || !list?.length || hits.status === "failed") return;
    if (paneHoldsKeys()) listbox.current?.focus({ preventScroll: true });
    const back = peekReturn(workspaceId);
    if (!back) return;
    takeReturn(workspaceId);
    const target = list.some((hit) => hit.messageId === back.hit) ? back.hit! : list[Math.min(back.index, list.length - 1)]!.messageId;
    setActive(target);
    listbox.current?.focus({ preventScroll: true });
    // The results drew afresh at their top: the hit he left (or the one now in its place) is brought into view.
    document.getElementById(hitId(target))?.scrollIntoView?.({ block: "nearest" });
  }, [shown, list, hits.status, workspaceId]);
  if (hits.status === "failed") return <ListEmpty title="The search did not run" action={retryOf(retry)} returns={{ workspaceId, shown, keep: true }} />;
  if (!list) return <RowBones label="Loading search results" />;
  // Come back to no hits at all: the keys go to Clear search, which hands them to the search field.
  if (list.length === 0) return <ListEmpty title="No matches" action={{ label: "Clear search", onClick: onClear }} returns={{ workspaceId, shown }} />;
  const open = (hit: ChatHit): void => {
    setActive(hit.messageId);
    setOpened(hit.messageId);
    openedFrom(workspaceId, { chatId: hit.chatId, index: list.indexOf(hit), hit: hit.messageId });
    onOpen(hit.chatId, hit.messageId);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = active ? list.findIndex((hit) => hit.messageId === active) : -1;
    if (event.key === "Enter" && at >= 0) {
      event.preventDefault();
      open(list[at]!);
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = list[Math.max(0, Math.min(list.length - 1, at + step))]!;
    if (narrow) setActive(next.messageId);
    else open(next);
    document.getElementById(hitId(next.messageId))?.scrollIntoView?.({ block: "nearest" });
  };
  const standing = active !== null && list.some((hit) => hit.messageId === active);
  // The line's room: the list's width less the row's insets, gutter and face column. Measured in the line's own font where
  // the window can measure text; else about 6.4px a 12px character.
  const room = width > 0 ? width - HIT_INSET : 0;
  const measure = room > 0 ? lineMeasure(family) : null;
  const chars = room > 0 ? Math.floor(room / 6.4) : 0;
  return (
    <div ref={box} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <div
        ref={listbox}
        role="listbox"
        tabIndex={0}
        aria-label="Search results"
        aria-activedescendant={standing ? hitId(active) : undefined}
        onKeyDown={keys}
        className={cn("group/list px-1.5 pb-1.5", standing ? "outline-none" : "focus-ring")}
      >
        {list.map((hit) => (
          <HitRow key={hit.messageId} hit={hit} row={known.get(hit.chatId)} query={query} chars={chars} fits={measure ? (line) => measure(line) <= room : null} fitsLead={measure ? (line) => measure(line) <= room * LEAD_SHARE : null} open={hit.messageId === opened} active={hit.messageId === active} now={now} onOpen={() => open(hit)} />
        ))}
      </div>
    </div>
  );
}

const hitId = (messageId: string): string => `chat-hit-${messageId}`;

/** What a cut hit's line gives the words up to and through its match, so a few words follow it. */
const LEAD_SHARE = 2 / 3;
/** A hit row's insets, gutter and face column: what of the list's width its second line cannot use. */
const HIT_INSET = 78;
/** Widths of text in the hits' 12px font, kept by font and words: a list redraws its lines on every key he types. */
const widths = new Map<string, number>();
let ruler: OffscreenCanvasRenderingContext2D | null | undefined;
/**
 * The width of a hit's second line in its own font (12px, a little more for the match's medium weight), or null where
 * the window cannot measure text (a test DOM): the line then falls back to counting characters.
 */
function lineMeasure(family: string): ((line: string) => number) | null {
  if (ruler === undefined) ruler = typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
  const ctx = ruler;
  if (!ctx || !family) return null;
  const font = `12px ${family}`;
  return (line) => {
    const at = `${font}\u0000${line}`;
    const known = widths.get(at);
    if (known !== undefined) return known;
    if (widths.size > 4000) widths.clear();
    ctx.font = font;
    // The match is drawn in medium: a twentieth more keeps it whole.
    const width = Math.ceil(ctx.measureText(line).width * 1.05);
    widths.set(at, width);
    return width;
  };
}

function HitRow({
  hit,
  row,
  query,
  chars,
  fits,
  fitsLead,
  open,
  active,
  now,
  onOpen,
}: {
  hit: ChatHit;
  row: ChatRow | undefined;
  query: string;
  chars: number;
  fits: ((line: string) => boolean) | null;
  fitsLead: ((line: string) => boolean) | null;
  open: boolean;
  active: boolean;
  now: number;
  onOpen: () => void;
}) {
  const kind = row?.kind ?? (hit.chat.startsWith("#") ? "channel" : "direct");
  // A direct chat's name is the other person already: only his own words are led, as a row leads them.
  const lead = kind === "direct" ? (hit.who === "You" ? "You: " : "") : `${firstName(hit.who)}: `;
  // Cut the words' start only where the line could not show the match otherwise; never cut the match itself.
  const room = chars > 0 ? Math.max(4, chars - lead.length - query.length - 6) : 40;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the list's keys move and open the active hit
    <div
      role="option"
      id={hitId(hit.messageId)}
      aria-selected={open}
      data-hit={hit.messageId}
      onClick={onOpen}
      style={{ height: ROW_HEIGHT, marginBottom: ROW_GAP }}
      className={cn(
        "tc-row relative cursor-default rounded-md select-none",
        ROW_GRID,
        active && "group-focus-visible/list:outline-2 group-focus-visible/list:-outline-offset-2 group-focus-visible/list:outline-accent",
      )}
    >
      <span className="row-span-2" />
      <span className={FACE_CELL}>
        <RowFace row={row ?? { kind, name: hit.chat, faces: [{ name: hit.who }] }} />
      </span>
      <span className="flex h-5 min-w-0 items-center text-[13px]">
        {/* The ink a row gives its name: in ink and semibold while the conversation is unread, else muted. */}
        <span className={cn("min-w-0 truncate", row?.unread ? "font-semibold text-foreground" : "text-muted-foreground")}>{hit.chat}</span>
        <time className="ms-auto shrink-0 ps-2 text-xs text-muted-foreground tabular-nums">{rowTime(hit.at, now)}</time>
      </span>
      <span dir="auto" className="h-5 truncate text-start text-xs leading-5 text-muted-foreground">
        {lead}
        <Lit text={fits ? cutToFit(hit.text, query, (line) => fits(lead + line), fitsLead ? (line) => fitsLead(lead + line) : undefined) : aroundMatch(hit.text, query, room, Math.min(12, room))} query={query} />
      </span>
    </div>
  );
}
