import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";
import { Tabs, TabsIndicator, TabsList, TabsTrigger, TABS_PILL_TRIGGER } from "../../components/ui/tabs";
import { ChevronLeft, Outbox } from "../../chrome/icons";
import { OverlayNav } from "../../chrome/TitleBar";
import { WindowControls } from "../../chrome/WindowControls";
import { useDragResize } from "../../hooks/useDragResize";
import { useSashKeys } from "../../hooks/useSashKeys";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../lib/connection";
import { nameInLine } from "../../lib/hostWords";
import { bareKey, chordKey, modKey } from "../../lib/keys";
import { innerLayerOwnsEscape, isTextField, usePageEscape } from "../../lib/pageEscape";
import { IS_MAC } from "../../lib/platform";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { storeTitleOf } from "../../lib/threadMentions";
import { useSlowClock } from "../../lib/turnClock";
import { workErrorWords } from "../../lib/workErrorWords";
import { EmptyState, PAGE_LIST_WIDTH } from "../../surfaces/SurfaceSkeleton";
import { DoneDetail } from "./DoneDetail";
import { GrantsSheet } from "./GrantsSheet";
import { HeldDetail, type DetailCommands } from "./HeldDetail";
import { DoneList, ListSkeleton, ROW_ATTR, WaitingList } from "./Lists";
import { WORK_CHATS_KEY } from "./model";
import { DetailSkeleton, HostRetry } from "./parts";
import { loadOutbox, offerFrom, useOutbox, useWantedOutboxItem, wantOutboxItem, type HostItem } from "./store";
import { pressMany, TickedDetail, type Batch } from "./Ticked";
import { RequestCard } from "./RequestCard";
import { askedItemKeys, requestKey, useOpenRequests } from "./requests";
import { doneDays, FOLD_AT, FOLD_SHOWS, itemKey, tickable, waitingSections } from "./waiting";

export { HeldDetail } from "./HeldDetail";
export { batchVerb, canEdit, HostRetry, KindGlyph, rowWords, splitSummary } from "./parts";
/** What a tick may take (Today and the tests read it). */
export const batchable = tickable;

const MIN_WIDTH = 240;
const MAX_WIDTH = 420;
/** Waiting's rows carry a trailing word: the list opens a little wider than the Inbox's. */
const LIST_WIDTH = Math.max(PAGE_LIST_WIDTH, 320);
let rememberedWidth = LIST_WIDTH;
type Tab = "waiting" | "done";
let rememberedTab: Tab = "waiting";
/** The tab the page opens on ("sent" is Done's old name, from a caller written before it). */
export function rememberOutboxTab(tab: Tab | "sent"): void {
  rememberedTab = tab === "sent" ? "done" : tab;
}

/** Why a host's list did not come, in his words, when it says more than the row's own "did not answer". */
const hostWhy = (error: string, host: string): string | null => {
  const why = workErrorWords(error, { host });
  return why && !/did not answer/i.test(why) ? why : null;
};

type Props = {
  besideRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
  /** Opens the thread that made an act. */
  onOpenSession?: (sessionId: string, environmentId: string) => void;
};

/**
 * The Outbox (docs/DESIGN.md "The Outbox", docs/agents/work-outbox.md "The
 * screens"): on the Inbox's frame, Waiting and Done over the list, and on the
 * right exactly what a press does and what will go. Waiting leads with what
 * did not go and what starts soon, then each thread's items together, then
 * what he timed. Ticks turn the right side into one summary and one press.
 * Every verb has a key while the page has focus. Held is never amber. Under
 * 640px of page the list and the detail take turns.
 */
export function OutboxView({ besideRail = false, onClose, onToggleSidebar, onOpenSession }: Props) {
  const outbox = useOutbox();
  const [tab, setTab] = useState<Tab>(rememberedTab);
  const [selected, setSelected] = useState<string | null>(null);
  // Narrow, the detail shows only once he picks an item (the first is picked for the wide page by itself).
  const [opened, setOpened] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const lastTick = useRef<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [batch, setBatch] = useState<Batch | null>(null);
  const [grantsOpen, setGrantsOpen] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const commands = useRef<DetailCommands | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const clearTicks = () => {
    setTicked(new Set());
    setBatch(null);
    lastTick.current = null;
  };
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Escape belongs to the innermost thing first: an edit in place, then the ticks, then the page.
  usePageEscape(
    () => {
      if (commands.current?.editing()) return commands.current.cancelEdit();
      if (ticked.size || batch) return clearTicks();
      onCloseRef.current();
    },
    { fields: "blur" },
  );
  useEffect(() => {
    void loadOutbox();
  }, []);
  useEffect(() => {
    rememberedTab = tab;
  }, [tab]);

  const resize = useDragResize({
    min: MIN_WIDTH,
    max: () => Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.5)),
    defaultWidth: LIST_WIDTH,
    initial: rememberedWidth,
    onCommit: (width) => {
      rememberedWidth = width;
    },
  });
  const sashKeys = useSashKeys({
    label: "Resize the Outbox list",
    orientation: "vertical",
    value: resize.width,
    min: MIN_WIDTH,
    max: Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.5)),
    getSpan: (handle) => handle.closest(".app-shell")?.getBoundingClientRect().width || window.innerWidth,
    onChange: resize.resizeTo,
    onReset: resize.reset,
  });

  const workspaces = useWorkspaces();
  const environments = useEnvironments();
  const places = useMemo(() => {
    const names = new Map(workspaces.map((w) => [`${w.environmentId}:${w.id}`, w.name]));
    // The jobs in the rail's order; Work Chats after every job.
    const order = new Map(workspaces.filter((w) => w.kind === "work").map((w, i) => [`${w.environmentId}:${w.id}`, i]));
    const jobOf = (environmentId: string, workspaceId: string | null) =>
      !workspaceId || workspaceId === WORK_CHATS_KEY ? "Work Chats" : (names.get(`${environmentId}:${workspaceId}`) ?? "A Work workspace");
    return {
      jobOf,
      jobOrder: (environmentId: string, workspaceId: string | null) => (workspaceId ? (order.get(`${environmentId}:${workspaceId}`) ?? 10_000) : 20_000),
      titleOf: (item: { sessionId: string | null }) => (item.sessionId ? (storeTitleOf(item.sessionId) ?? null) : null),
    };
  }, [workspaces]);
  const hostName = (id: string) => environments.find((e) => e.id === id)?.name ?? "A host";
  const sectorOf = (environmentId: string, workspaceId: string | null): string | null =>
    workspaces.find((w) => w.environmentId === environmentId && w.id === workspaceId)?.sector ?? null;

  // A row's held time and a scheduled row's time read against the minute it is.
  const now = useSlowClock(true) || Date.now();
  // Asked in threads leads Waiting; an item an open request lists is under its request, not again under its thread.
  const requests = useOpenRequests();
  const waitingItems = useMemo(() => {
    const asked = askedItemKeys(requests);
    return asked.size ? outbox.waiting.filter((item) => !asked.has(itemKey(item))) : outbox.waiting;
  }, [outbox.waiting, requests]);
  const sections = useMemo(() => waitingSections(waitingItems, places, now), [waitingItems, places, now]);
  const days = useMemo(() => doneDays(outbox.done, now), [outbox.done, now]);
  const flat = useMemo(() => (tab === "waiting" ? sections.flatMap((s) => s.items) : days.flatMap((d) => d.items)), [tab, sections, days]);
  // The rows on screen, in order, with each fold's "N more": what ↑ and ↓ step through.
  const visible = useMemo(
    () =>
      tab === "waiting"
        ? [...requests.map(requestKey), ...sections.flatMap((s) => (s.items.length > FOLD_AT && !expanded.has(s.key) ? [...s.items.slice(0, FOLD_SHOWS).map(itemKey), `more:${s.key}`] : s.items.map(itemKey)))]
        : days.flatMap((d) => d.items.map(itemKey)),
    [tab, sections, days, expanded, requests],
  );

  // The detail shows only the item he picked: one that left under him (sent elsewhere, a grant) leaves the detail
  // empty, never the next item under the Send he was about to press.
  const current = selected === null ? null : (flat.find((item) => itemKey(item) === selected) ?? null);
  // A request picked stays on screen once answered or put away: its card says how it ended.
  const pickedRequest = tab === "waiting" && selected?.startsWith("request:") ? /^request:(.+):([^:]+)$/.exec(selected) : null;
  const first = visible.find((k) => !k.startsWith("more:")) ?? null;
  // The page picks the first row by itself; until he touches the page, a request that comes to lead (read a moment
  // after the lists) takes that pick. Once he has clicked or pressed a key, nothing moves under his hand.
  const touched = useRef(false);
  useEffect(() => {
    if (first !== null && (selected === null || (!touched.current && first.startsWith("request:") && selected !== first))) setSelected(first);
  }, [selected, first]);
  // An item a notice asked for (the digest's press): picked once a list holds it, in the tab that holds it.
  const wanted = useWantedOutboxItem();
  useEffect(() => {
    if (!wanted) return;
    // A request is picked at once: its card reads it from its host. An item by its host's number ("Held as item 12") is
    // found by that number on that host.
    const byNumber = (i: HostItem) => typeof wanted !== "string" && i.environmentId === wanted.environmentId && i.n === wanted.n;
    const numbered = typeof wanted === "string" ? null : (outbox.waiting.find(byNumber) ?? outbox.done.find(byNumber) ?? null);
    const key = typeof wanted === "string" ? wanted : numbered && itemKey(numbered);
    if (!key) return;
    const held = key.startsWith("request:") || outbox.waiting.some((item) => itemKey(item) === key) ? "waiting" : outbox.done.some((item) => itemKey(item) === key) ? "done" : null;
    // Not held yet is not "gone": the lists the page opens with may be from before the item was made.
    if (!held) return;
    touched.current = true;
    setTab(held);
    setSelected(key);
    setOpened(true);
    clearTicks();
    // A wanted item past its group's fold opens the fold.
    const section = sections.find((s) => s.items.some((i) => itemKey(i) === key));
    if (section) setExpanded((prev) => new Set(prev).add(section.key));
    wantOutboxItem(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- picked once, when the item first shows
  }, [wanted, outbox, requests]);
  useEffect(() => () => wantOutboxItem(null), []);

  // Ticks hold only items still waiting that a tick may take.
  const tickedItems = outbox.waiting.filter((item) => ticked.has(itemKey(item)) && tickable(item));
  const ticking = tab === "waiting" && (tickedItems.length > 0 || batch !== null);
  const tick = (item: HostItem, on: boolean, range = false) => {
    setBatch(null);
    // The range runs from the tick before this one: read it now, before this tick becomes the last.
    const from = range ? lastTick.current : null;
    setTicked((prev) => {
      const next = new Set(prev);
      const key = itemKey(item);
      if (from) {
        const order = flat.filter(tickable).map(itemKey);
        const [a, b] = [order.indexOf(from), order.indexOf(key)].sort((x, y) => x - y);
        if (a! >= 0) for (const k of order.slice(a, b! + 1)) next.add(k);
        else next.add(key);
      } else if (on) next.add(key);
      else next.delete(key);
      return next;
    });
    lastTick.current = itemKey(item);
  };

  const pick = (item: HostItem) => {
    setSelected(itemKey(item));
    setOpened(true);
    clearTicks();
  };

  // After a press the item leaves Waiting: the next one down takes the pick, but only while that item is still what
  // he has on screen in Waiting. A reply that lands after he picked another item, or went to Done, moves nothing.
  const onScreen = useRef({ tab, selected });
  onScreen.current = { tab, selected };
  const afterPress = (item: HostItem) => {
    if (onScreen.current.tab !== "waiting" || onScreen.current.selected !== itemKey(item)) return;
    const at = flat.findIndex((x) => itemKey(x) === itemKey(item));
    const next = flat[at + 1] ?? flat[at - 1];
    setSelected(next ? itemKey(next) : null);
  };
  // A press that earned a grant: Review opens the item in Done, where the offer waits beside it.
  const review = (item: HostItem) => {
    setTab("done");
    setSelected(itemKey(item));
    setOpened(true);
  };

  // ── keys: only while the page has focus, never in a field, a menu, a popover or a dialog ──
  const focusRow = (key: string) => list.current?.querySelector<HTMLElement>(`[${ROW_ATTR}="${CSS.escape(key)}"]`)?.focus();
  const move = (by: number) => {
    const from = focused && visible.includes(focused) ? focused : selected;
    const at = from ? visible.indexOf(from) : -1;
    const next = visible[Math.max(0, Math.min(visible.length - 1, at + by))];
    if (!next) return;
    // While rows are ticked, the keys move the focus alone: the right side stays their summary.
    if (!next.startsWith("more:") && !ticking) {
      setSelected(next);
      setOpened(true);
    }
    focusRow(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target as Element;
    if (isTextField(target) || (target as HTMLElement).isContentEditable || target.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [data-slot=popover-content], [role="listbox"]')) return;
    if (innerLayerOwnsEscape(target) && event.key === "Escape") return;
    const key = event.key;
    if (key === "Enter" && modKey(event.nativeEvent)) {
      event.preventDefault();
      return commands.current?.primary();
    }
    const bare = bareKey(event.nativeEvent);
    const lower = key.length === 1 ? key.toLowerCase() : key;
    if ((key === "ArrowDown" && bare) || (lower === "j" && bare)) return void (event.preventDefault(), move(1));
    if ((key === "ArrowUp" && bare) || (lower === "k" && bare)) return void (event.preventDefault(), move(-1));
    if (tab !== "waiting") return;
    const on = focused && visible.includes(focused) && !focused.startsWith("more:") ? focused : selected;
    const item = on ? outbox.waiting.find((i) => itemKey(i) === on) : undefined;
    if (lower === "x" && (bare || (event.shiftKey && !chordKey(event.nativeEvent)))) {
      if (!item || !tickable(item)) return;
      event.preventDefault();
      return tick(item, event.shiftKey ? true : !ticked.has(itemKey(item)), event.shiftKey);
    }
    if (!bare) return;
    if (lower === "e") return void (event.preventDefault(), commands.current?.edit());
    if (lower === "d") return void (event.preventDefault(), commands.current?.discard());
    if (lower === "l") return void (event.preventDefault(), commands.current?.later());
  };

  // The list's one tab stop: the row focused last, else the picked one, else the first.
  const stop = focused && visible.includes(focused) ? focused : selected && visible.includes(selected) ? selected : (visible[0] ?? null);

  // An empty list is clear only when every host answered: a host that failed is named above with its Retry.
  const down = outbox.errors.length;
  // What the tab lists: Waiting's open requests count with its items.
  const shownCount = tab === "waiting" ? outbox.waiting.length + requests.length : outbox.done.length;
  const emptyWords = !outbox.complete ? (
    <EmptyState title="Not known yet" line={down === 1 ? "Shown once it answers." : down > 1 ? "Shown once they answer." : "Shown once every host answers."} />
  ) : tab === "waiting" ? (
    <EmptyState title="Nothing held" />
  ) : (
    <EmptyState title="Nothing decided yet" />
  );

  return (
    <div
      ref={page}
      role="region"
      aria-label="Outbox"
      data-work-outbox
      onKeyDownCapture={() => (touched.current = true)}
      onPointerDownCapture={() => (touched.current = true)}
      onClickCapture={() => (touched.current = true)}
      onKeyDown={onKeyDown} className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
      <div className="@container/head flex h-10 shrink-0 select-none items-center border-b border-border" data-tauri-drag-region="deep">
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <Outbox className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium">Outbox</span>
        </div>
        {/* The page's name outlives its one button: on a very narrow page Grants gives way, never "Outbox". */}
        <Button variant="ghost" size="sm" className="me-2 text-muted-foreground @max-[18rem]/head:hidden" onClick={() => setGrantsOpen(true)}>
          Grants
        </Button>
        {IS_MAC ? null : <WindowControls />}
      </div>
      {outbox.errors.map((e) => (
        <div key={e.environmentId} role="status" className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
          <StatusMark state="failed" word={false} />
          <span className="min-w-0 flex-1 truncate">
            {hostName(e.environmentId)} did not answer <span className="text-muted-foreground">{hostWhy(e.error, nameInLine(hostName(e.environmentId)))}</span>
          </span>
          <HostRetry environmentId={e.environmentId} />
        </div>
      ))}
      <div className="@container/outbox flex min-h-0 min-w-0 flex-1">
        <div
          ref={resize.attachPane}
          data-outbox-list=""
          className={cn("relative flex h-full min-h-0 shrink-0 flex-col border-r border-border @max-[40rem]/outbox:w-full! @max-[40rem]/outbox:border-r-0", opened && "@max-[40rem]/outbox:hidden")}
        >
          <div className="flex shrink-0 items-center p-2">
            <Tabs
              value={tab}
              onValueChange={(v) => {
                setTab(v as Tab);
                setSelected(null);
                setFocused(null);
                setOpened(false);
                clearTicks();
              }}
            >
              <TabsList aria-label="Outbox" className="relative bg-transparent p-0 group-data-[orientation=horizontal]/tabs:h-7">
                <TabsIndicator className="bg-foreground/7" />
                <TabsTrigger value="waiting" className={cn("h-7 px-2.5 text-[13px]", TABS_PILL_TRIGGER)}>
                  Waiting
                </TabsTrigger>
                <TabsTrigger value="done" className={cn("h-7 px-2.5 text-[13px]", TABS_PILL_TRIGGER)}>
                  Done
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {ticking ? (
              <Button variant="ghost" size="xs" className="ms-auto hidden @max-[40rem]/outbox:inline-flex" onClick={() => setOpened(true)}>
                Review {batch ? batch.items.length : tickedItems.length}
              </Button>
            ) : null}
          </div>
          <div
            ref={list}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none"
            onFocus={(e) => setFocused((e.target as HTMLElement).getAttribute(ROW_ATTR))}
          >
            {!outbox.loaded && shownCount === 0 ? (
              <ListSkeleton />
            ) : shownCount === 0 ? (
              // Narrow, the list is the pane on screen: an empty list says so here (the detail's copy is hidden then).
              <div data-outbox-empty="list" className="hidden h-full @max-[40rem]/outbox:flex">
                {emptyWords}
              </div>
            ) : tab === "waiting" ? (
              <WaitingList
                sections={sections}
                requests={requests}
                onPickRequest={(request) => {
                  setSelected(requestKey(request));
                  setOpened(true);
                  clearTicks();
                }}
                current={ticking ? null : selected}
                stop={stop}
                ticked={ticked}
                expanded={expanded}
                now={now}
                onPick={pick}
                onTick={tick}
                onSelectGroup={(items) => {
                  setBatch(null);
                  setTicked((prev) => new Set([...prev, ...items.map(itemKey)]));
                }}
                onExpand={(key) => setExpanded((prev) => new Set(prev).add(key))}
              />
            ) : (
              <DoneList days={days} current={selected} stop={stop} now={now} onPick={pick} />
            )}
          </div>
          <div
            {...sashKeys}
            className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none outline-none focus-visible:bg-accent @max-[40rem]/outbox:hidden ${resize.dragging ? "bg-foreground/12" : "hover:bg-foreground/7"}`}
            onPointerDown={resize.onPointerDown}
          />
        </div>
        <div data-outbox-detail="" className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !opened && "@max-[40rem]/outbox:hidden")}>
          <div className="hidden shrink-0 px-4 pt-2 @max-[40rem]/outbox:block">
            <Button variant="ghost" size="xs" onClick={() => setOpened(false)}>
              <ChevronLeft className="size-3.5" />
              {tab === "waiting" ? "Waiting" : "Done"}
            </Button>
          </div>
          {ticking ? (
            <TickedDetail
              items={tickedItems}
              batch={batch}
              host={(item) => hostName(item.environmentId)}
              onToggle={(item, on) => tick(item, on)}
              onClear={clearTicks}
              onPress={(items, choice) => {
                setTicked(new Set());
                void pressMany(items, choice, setBatch);
              }}
              canRetry={(key) => outbox.waiting.some((i) => itemKey(i) === key && tickable(i))}
              onSendAgain={(keys) => {
                const again = outbox.waiting.filter((i) => keys.includes(itemKey(i)) && tickable(i));
                if (again.length) void pressMany(again, { do: "send" }, setBatch);
              }}
              commands={commands}
            />
          ) : pickedRequest ? (
            <RequestCard
              key={selected!}
              frame="page"
              environmentId={pickedRequest[1]!}
              id={pickedRequest[2]!}
              host={(item) => hostName(item.environmentId)}
              onOpenSession={onOpenSession}
              commands={commands}
            />
          ) : !outbox.loaded && shownCount === 0 ? (
            <DetailSkeleton />
          ) : !current ? (
            shownCount > 0 ? (
              <EmptyState title="No longer waiting" line="Another press or device decided it." />
            ) : (
              <div data-outbox-empty="detail" className="flex h-full">
                {emptyWords}
              </div>
            )
          ) : tab === "waiting" ? (
            <HeldDetail
              key={itemKey(current)}
              item={current}
              workspace={places.jobOf(current.environmentId, current.workspaceId)}
              host={hostName(current.environmentId)}
              onOpenSession={onOpenSession}
              onPressed={afterPress}
              onReview={review}
              commands={commands}
            />
          ) : (
            <DoneDetail
              key={itemKey(current)}
              item={current}
              offer={offerFrom(outbox.offers, current)}
              workspace={places.jobOf(current.environmentId, current.workspaceId)}
              grantLabel={outbox.grants.find((g) => current.decidedBy === `grant:${g.id}`)?.label ?? null}
              onOpenSession={onOpenSession}
            />
          )}
        </div>
      </div>
      <GrantsSheet open={grantsOpen} onOpenChange={setGrantsOpen} grants={outbox.grants} nameOf={places.jobOf} sectorOf={sectorOf} />
    </div>
  );
}
