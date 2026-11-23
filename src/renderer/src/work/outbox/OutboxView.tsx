import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { ActKind } from "@shared/work";
import { BusyLabel, Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { ItemButton } from "../../components/ui/item";
import { reveal, yields } from "../../components/ui/reveal";
import { StatusMark } from "../../components/ui/status";
import { Tabs, TabsIndicator, TabsList, TabsTrigger, TABS_PILL_TRIGGER } from "../../components/ui/tabs";
import { loadToast } from "../../components/ui/toaster";
import { ChevronDown, ChevronLeft, Globe, MoreHorizontal, Outbox, Plug, SquareMousePointer } from "../../chrome/icons";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { OverlayNav } from "../../chrome/TitleBar";
import { WindowControls } from "../../chrome/WindowControls";
import { useDragResize } from "../../hooks/useDragResize";
import { useSashKeys } from "../../hooks/useSashKeys";
import { cn } from "../../lib/cn";
import { usePageEscape } from "../../lib/pageEscape";
import { IS_MAC } from "../../lib/platform";
import { storeTitleOf } from "../../lib/threadMentions";
import { useEnvironments } from "../../lib/connection";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { EmptyState, PAGE_LIST_WIDTH, SurfaceSkeleton } from "../../surfaces/SurfaceSkeleton";
import { Facts } from "../../surfaces/settings/hosts/Facts";
import { Skeleton } from "../../components/ui/skeleton";
import { ActView } from "../acts/ActView";
import { kindHeading } from "../acts/kindRows";
import { Calendar, Chat, File, Mail } from "../icons";
import { EditDialog } from "./EditDialog";
import { GrantsSheet } from "./GrantsSheet";
import { byWorkspace, dayOf, decidedWords, EDITABLE, grantFor, offerLine, pastOf, payloadView, timeOf, WORK_CHATS_KEY } from "./model";
import { loadResults, undoResult, useResults } from "./results";
import { OfferLine } from "./OfferLine";
import { discardItem, fetchItem, grantAndSend, loadHost, loadOutbox, notSentWords, offerAfterPress, offerFrom, sendItem, sendMany, useOutbox, wentOut, type HostItem, type HostOffer } from "./store";

const MIN_WIDTH = 240;
const MAX_WIDTH = 420;
let rememberedWidth = PAGE_LIST_WIDTH;
let rememberedTab: "waiting" | "sent" = "waiting";
/** The tab the page opens on (its preview opens Sent). */
export function rememberOutboxTab(tab: "waiting" | "sent"): void {
  rememberedTab = tab;
}

/** An item's key across hosts. */
const keyOf = (item: Pick<HostItem, "environmentId" | "ref">): string => `${item.environmentId}:${item.ref.at}:${item.ref.id}`;
/** States a press may take an item from. */
const pressable = (item: HostItem): boolean => item.state === "held" || item.state === "live" || item.state === "failed";
/** What a plain Send may take, alone or with others: a send that may have gone waits for his own "Send again". */
const sendable = (item: HostItem): boolean => pressable(item) && !item.outcomeUnknown;
/**
 * What a list press (a group's Send N, a tick) may take: a computer act is
 * sent only from its own detail, where its kept picture shows, so it is left
 * out of the count and takes no tick (sendMany leaves one too, as a backstop).
 */
export const batchable = (item: HostItem): boolean => sendable(item) && item.kind !== "computer.act";
/**
 * Whether Edit has anything to offer: a field a person may change, or a body
 * not drawn from html alone. An act read from a live screen is carried out as
 * it was read, so the host refuses any change to it.
 */
export function canEdit(item: Pick<HostItem, "payload" | "state" | "kind">): boolean {
  if (item.state === "live" || !EDITABLE.includes(item.kind)) return false;
  const view = payloadView(item.payload);
  return view.fields.some((f) => f.edit !== null) || (view.body !== null && !view.body.readOnly);
}
/** A list press's past verb: the acts' own when they share one ("Posted 2"), else "Sent", as the list's Send N says; never the first item's alone. */
export function batchVerb(items: readonly (Pick<HostItem, "verb"> & { kind?: string })[]): string {
  const verbs = new Set(items.map((i) => i.verb));
  const kinds = new Set(items.map((i) => i.kind));
  return verbs.size === 1 ? pastOf([...verbs][0]!, kinds.size === 1 ? [...kinds][0] : undefined) : "Sent";
}
/** Where he looks to see whether a send that may have gone went. */
const checkWords = (item: HostItem): string => (item.kind === "mail.send" || item.kind === "office.mail.send" ? "Check Sent first" : "Check whether it went first");
/**
 * A list row's title and second line. Most acts split their summary at its
 * colon; a Google share's summary ("Share Budget Q3 final.xlsx with dana@…
 * (can edit)") has none, so a long file name would cut the person off: its
 * title is who and how ("Share with dana@purdue.edu (can edit)") and the file
 * its second line. The detail keeps its own heading.
 */
export function rowWords(item: Pick<HostItem, "kind" | "summary" | "verb" | "payload"> & { state?: HostItem["state"] }): { act: string; about: string | null } {
  // An agent's change to a shared file: the file leads ("Change Brief.docx"), so a long verb never cuts its name off,
  // and the line is the change, read after the file's own name (which may hold ": " itself), its count first.
  const changed = item.kind === "office.edit" || item.kind === "google.edit" ? kindHeading(item.kind, item.payload, item.state === "sent") : null;
  if (changed) {
    const p = (item.payload ?? {}) as { name?: unknown; edits?: unknown };
    const lead = typeof p.name === "string" ? item.summary.indexOf(` in ${p.name}: `) : -1;
    const about = lead >= 0 ? item.summary.slice(lead + ` in ${p.name}: `.length) : splitSummary(item.summary).about;
    const n = Array.isArray(p.edits) ? p.edits.length : 1;
    return { act: changed, about: about && n > 1 ? `${n} changes: ${about.replace(/ and \d+ more$/, "")}` : about };
  }
  if (item.kind === "share.google") {
    const p = (item.payload ?? {}) as { email?: unknown; name?: unknown };
    const role = /\(([^)]*)\)\s*$/.exec(item.summary)?.[1];
    if (typeof p.email === "string" && typeof p.name === "string") return { act: `${item.verb} with ${p.email}${role ? ` (${role})` : ""}`, about: p.name };
  }
  return splitSummary(item.summary);
}
/** "Send to Dana Lee: Re: budget" → the act and what it is about. */
export function splitSummary(summary: string): { act: string; about: string | null } {
  const at = summary.indexOf(": ");
  return at > 0 ? { act: summary.slice(0, at), about: summary.slice(at + 2) } : { act: summary, about: null };
}

const KIND_GLYPH: Partial<Record<ActKind, ComponentType<{ className?: string }>>> = {
  "mail.send": Mail,
  "office.mail.send": Mail,
  "calendar.op": Calendar,
  "office.calendar.op": Calendar,
  "office.edit": File,
  "google.edit": File,
  "addon.call": Plug,
  "computer.act": SquareMousePointer,
  "portal.submit": Globe,
  "chat.reply": Chat,
};
/** A held act's glyph by its kind (Today's held rows lead with it too). */
export function KindGlyph({ kind, className }: { kind: ActKind; className?: string }) {
  const Glyph = KIND_GLYPH[kind] ?? Outbox;
  return <Glyph className={cn("size-3.5 text-muted-foreground", className)} />;
}

const toast = (line: string) => void loadToast().then((t) => t(line));
const toastError = (line: string) => void loadToast().then((t) => t.error(line));
/** What a press says when it completed a run: the line of the grant it earned, with Review, which opens the item in Sent. */
const toastEarned = (line: string, offer: HostOffer, review: () => void) =>
  void loadToast().then((t) => t(line, { description: offerLine(offer), action: { label: "Review", onClick: review } }));
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type Props = {
  besideRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
  /** Opens the thread that made an act. */
  onOpenSession?: (sessionId: string, environmentId: string) => void;
};

/**
 * The Outbox (docs/DESIGN.md "Around the canvas", docs/agents/work-outbox.md
 * "The screens"): on the Inbox's frame, every held act of every host with
 * Work on, under its workspace, with exactly what will go on the right and
 * one fixed bar of verbs under it. Sent sits beside Waiting. Held is never
 * amber: a held row's glyph is its kind's, and only a failed send takes
 * the red mark. Under 640px of page the list and the detail take turns: a
 * pick opens the detail, and its back row returns to the list.
 */
export function OutboxView({ besideRail = false, onClose, onToggleSidebar, onOpenSession }: Props) {
  const outbox = useOutbox();
  const [tab, setTab] = useState<"waiting" | "sent">(rememberedTab);
  const [selected, setSelected] = useState<string | null>(null);
  // Narrow, the detail shows only once he picks an item (the first is picked for the wide page by itself).
  const [opened, setOpened] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [grantsOpen, setGrantsOpen] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  usePageEscape(() => onCloseRef.current(), { fields: "blur" });
  useEffect(() => {
    void loadOutbox();
  }, []);
  useEffect(() => {
    rememberedTab = tab;
  }, [tab]);

  const resize = useDragResize({
    min: MIN_WIDTH,
    max: () => Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.5)),
    defaultWidth: PAGE_LIST_WIDTH,
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
  const nameOf = useMemo(() => {
    const names = new Map(workspaces.map((w) => [`${w.environmentId}:${w.id}`, w.name]));
    return (environmentId: string, workspaceId: string | null) =>
      !workspaceId || workspaceId === WORK_CHATS_KEY ? "Work Chats" : (names.get(`${environmentId}:${workspaceId}`) ?? "A Work workspace");
  }, [workspaces]);
  const hostName = (id: string) => environments.find((e) => e.id === id)?.name ?? "A host";
  const sectorOf = (environmentId: string, workspaceId: string | null): string | null =>
    workspaces.find((w) => w.environmentId === environmentId && w.id === workspaceId)?.sector ?? null;

  const list = tab === "waiting" ? outbox.waiting : outbox.sent;
  // The detail shows only the item he picked: one that left under him (sent elsewhere, a grant, a stale draft)
  // leaves the detail empty, never the next item under the Send he was about to press.
  const current = selected === null ? null : (list.find((item) => keyOf(item) === selected) ?? null);
  const first = list[0] ? keyOf(list[0]) : null;
  useEffect(() => {
    if (selected === null && first !== null) setSelected(first);
  }, [selected, first]);
  // Ticks hold only items still waiting.
  const tickedItems = outbox.waiting.filter((item) => ticked.has(keyOf(item)) && batchable(item));
  const tick = (item: HostItem, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(keyOf(item));
      else next.delete(keyOf(item));
      return next;
    });

  const pick = (item: HostItem) => {
    setSelected(keyOf(item));
    setOpened(true);
  };
  // Narrow, what shows is his to choose, apart from the ticks: a tick stays in the list, Waiting goes back to it with
  // the ticks kept, and "Review N" opens the ticked rows again.
  const narrowDetail = opened;

  // After a press the item leaves Waiting: the next one down takes the selection, but only while that item is still
  // what he has on screen in Waiting. A reply that lands after he picked another item, or went to Sent, moves nothing.
  const onScreen = useRef({ tab, selected });
  onScreen.current = { tab, selected };
  const afterPress = (item: HostItem) => {
    if (onScreen.current.tab !== "waiting" || onScreen.current.selected !== keyOf(item)) return;
    const at = outbox.waiting.findIndex((x) => keyOf(x) === keyOf(item));
    const next = outbox.waiting[at + 1] ?? outbox.waiting[at - 1];
    setSelected(next ? keyOf(next) : null);
  };
  // A press that earned a grant: Review opens the item in Sent, where the offer waits beside it.
  const review = (item: HostItem) => {
    setTab("sent");
    setSelected(keyOf(item));
    setOpened(true);
  };

  const sendSeveral = async (items: readonly HostItem[], where?: string): Promise<void> => {
    const { sent, failed, waiting } = await sendMany(items);
    setTicked(new Set());
    // What waits for its own look is said plainly, beside what went: never as a failure.
    const left = waiting.length ? `${waiting.length} ${waiting.length === 1 ? "waits" : "wait"} for you to open ${waiting.length === 1 ? "it" : "them"}` : null;
    if (sent || left) toast([sent ? `${batchVerb(items)} ${sent}${where ? ` from ${where}` : ""}` : null, left].filter(Boolean).join(". "));
    if (failed.length) toastError(`${failed.length} could not go: ${failed[0]!.error}`);
  };

  // An empty list is clear only when every host answered: a host that failed is named above with its Retry (the one
  // place that names it), and its items are not known, so the words never say "Nothing held" beside a failed read.
  const down = outbox.errors.length;
  const emptyWords = !outbox.complete ? (
    <EmptyState title="Not known yet" line={down === 1 ? "Shown once it answers." : down > 1 ? "Shown once they answer." : "Shown once every host answers."} />
  ) : tab === "waiting" ? (
    <EmptyState title="Nothing held" line="What a thread would send, post or accept waits here for your press." />
  ) : (
    <EmptyState title="Nothing sent yet" line="What left the machine shows here, newest first." />
  );

  return (
    <div role="region" aria-label="Outbox" data-work-outbox className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-border" data-tauri-drag-region="deep">
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <Outbox className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium">Outbox</span>
        </div>
        <Button variant="ghost" size="sm" className="me-2 text-muted-foreground" onClick={() => setGrantsOpen(true)}>
          Grants
        </Button>
        {IS_MAC ? null : <WindowControls />}
      </div>
      {outbox.errors.map((e) => (
        <div key={e.environmentId} role="status" className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
          <StatusMark state="failed" word={false} />
          <span className="min-w-0 flex-1 truncate">
            {hostName(e.environmentId)} did not answer <span className="text-muted-foreground">{e.error}</span>
          </span>
          <HostRetry environmentId={e.environmentId} />
        </div>
      ))}
      <div className="@container/outbox flex min-h-0 min-w-0 flex-1">
        <div
          ref={resize.attachPane}
          data-outbox-list=""
          className={cn(
            "relative flex h-full min-h-0 shrink-0 flex-col border-r border-border @max-[40rem]/outbox:w-full! @max-[40rem]/outbox:border-r-0",
            narrowDetail && "@max-[40rem]/outbox:hidden",
          )}
        >
          <div className="flex shrink-0 items-center border-b border-border p-2">
            <Tabs
              value={tab}
              onValueChange={(v) => {
                setTab(v as "waiting" | "sent");
                setSelected(null);
                setOpened(false);
              }}
            >
              <TabsList aria-label="Outbox" className="relative bg-transparent p-0 group-data-[orientation=horizontal]/tabs:h-7">
                <TabsIndicator className="bg-foreground/7" />
                <TabsTrigger value="waiting" className={cn("h-7 px-2.5 text-[13px]", TABS_PILL_TRIGGER)}>
                  Waiting
                </TabsTrigger>
                <TabsTrigger value="sent" className={cn("h-7 px-2.5 text-[13px]", TABS_PILL_TRIGGER)}>
                  Sent
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {tab === "waiting" && tickedItems.length > 0 ? (
              <Button variant="ghost" size="xs" className="ms-auto hidden @max-[40rem]/outbox:inline-flex" onClick={() => setOpened(true)}>
                Review {tickedItems.length}
              </Button>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none">
            {!outbox.loaded && list.length === 0 ? (
              <SurfaceSkeleton kind="rows" lines={2} count={6} label="Loading the Outbox" />
            ) : list.length === 0 ? (
              // Narrow, the list is the pane on screen: an empty list says so here (the detail's copy is hidden then).
              <div data-outbox-empty="list" className="hidden h-full @max-[40rem]/outbox:flex">
                {emptyWords}
              </div>
            ) : tab === "waiting" ? (
              <WaitingList
                items={outbox.waiting}
                current={current}
                ticked={ticked}
                ticking={ticked.size > 0}
                nameOf={nameOf}
                onSelect={pick}
                onTick={tick}
                onSendGroup={sendSeveral}
              />
            ) : (
              <SentList items={outbox.sent} current={current} nameOf={nameOf} onSelect={pick} />
            )}
          </div>
          <div
            {...sashKeys}
            className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none outline-none focus-visible:bg-accent @max-[40rem]/outbox:hidden ${resize.dragging ? "bg-foreground/12" : "hover:bg-foreground/7"}`}
            onPointerDown={resize.onPointerDown}
          />
        </div>
        <div data-outbox-detail="" className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !narrowDetail && "@max-[40rem]/outbox:hidden")}>
          <div className="hidden shrink-0 px-4 pt-2 @max-[40rem]/outbox:block">
            <Button variant="ghost" size="xs" onClick={() => setOpened(false)}>
              <ChevronLeft className="size-3.5" />
              {tab === "waiting" ? "Waiting" : "Sent"}
            </Button>
          </div>
          {tab === "waiting" && tickedItems.length > 0 ? (
            <TickedDetail items={tickedItems} onClear={() => setTicked(new Set())} onSend={() => sendSeveral(tickedItems)} />
          ) : !outbox.loaded && list.length === 0 ? (
            <DetailSkeleton />
          ) : !current ? (
            list.length > 0 ? (
              <EmptyState title="No longer waiting" line="Another press or device decided it. Pick an item from the list." />
            ) : (
              <div data-outbox-empty="detail" className="flex h-full">
                {emptyWords}
              </div>
            )
          ) : tab === "waiting" ? (
            <HeldDetail key={keyOf(current)} item={current} workspace={nameOf(current.environmentId, current.workspaceId)} host={hostName(current.environmentId)} onOpenSession={onOpenSession} onPressed={afterPress} onReview={review} />
          ) : (
            <SentDetail key={keyOf(current)} item={current} offer={offerFrom(outbox.offers, current)} workspace={nameOf(current.environmentId, current.workspaceId)} grantLabel={outbox.grants.find((g) => current.decidedBy === `grant:${g.id}`)?.label ?? null} onOpenSession={onOpenSession} />
          )}
        </div>
      </div>
      <GrantsSheet open={grantsOpen} onOpenChange={setGrantsOpen} grants={outbox.grants} nameOf={nameOf} sectorOf={sectorOf} />
    </div>
  );
}

// ── the lists ─────────────────────────────────────────────────────────────

/** A workspace's heading; its Send N shows on hover, as a row's controls do. */
function GroupHead({ sector, name, children, busy = false }: { sector: string | null; name: string; children?: React.ReactNode; busy?: boolean }) {
  return (
    <div className="group/item mt-3 flex h-7 items-center gap-2 pe-1 ps-2 first:mt-1">
      <SectorDot sector={sector} className="size-3.5" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">{name}</span>
      {children ? <span className={cn(reveal("item", { row: true }), busy && "opacity-100")}>{children}</span> : null}
    </div>
  );
}

function WaitingList({
  items,
  current,
  ticked,
  ticking,
  nameOf,
  onSelect,
  onTick,
  onSendGroup,
}: {
  items: HostItem[];
  current: HostItem | null;
  ticked: ReadonlySet<string>;
  ticking: boolean;
  nameOf: (environmentId: string, workspaceId: string | null) => string;
  onSelect: (item: HostItem) => void;
  onTick: (item: HostItem, on: boolean) => void;
  onSendGroup: (items: HostItem[], where: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="flex flex-col p-1">
      {byWorkspace(items).map((group) => {
        const name = nameOf(group.items[0]!.environmentId, group.workspaceId);
        const ready = group.items.filter(batchable);
        return (
          <section key={group.key} aria-label={name}>
            <GroupHead sector={group.sector} name={name} busy={busy === group.key}>
              {ready.length > 1 ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy(group.key);
                    void onSendGroup(ready, name).finally(() => setBusy(null));
                  }}
                >
                  <BusyLabel busy={busy === group.key} label={`Send ${ready.length}`} />
                </Button>
              ) : null}
            </GroupHead>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const { act, about } = rowWords(item);
                const active = !ticking && current !== null && keyOf(current) === keyOf(item);
                return (
                  <li key={keyOf(item)} className="group/row relative">
                    <ItemButton
                      size="sm"
                      aria-current={active ? "true" : undefined}
                      onClick={() => onSelect(item)}
                      className={cn("flex-col flex-nowrap items-stretch gap-0 rounded-md py-2 pe-2 ps-8 text-left transition-none", active ? "bg-muted" : "hover:bg-foreground/5")}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span data-row-title className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">
                          {act}
                        </span>
                        <time className="shrink-0 text-xs tabular-nums text-muted-foreground">{timeOf(item.createdAt)}</time>
                      </span>
                      <span className="truncate text-xs leading-4 text-muted-foreground">
                        {item.state === "failed" ? (item.error ?? "Couldn't send") : item.state === "sending" ? "Sending" : (about ?? item.account ?? "")}
                      </span>
                    </ItemButton>
                    {/* The glyph column: the kind's glyph, which gives way to the tick on hover, and to every tick while any row is ticked. */}
                    <span className={cn("pointer-events-none absolute start-2 top-2.5 grid size-4 place-items-center", batchable(item) && (ticking ? "opacity-0" : yields("row")))}>
                      {item.state === "failed" ? <StatusMark state="failed" word={false} /> : item.state === "sending" ? <StatusMark state="working" word={false} /> : <KindGlyph kind={item.kind} />}
                    </span>
                    {batchable(item) ? (
                      <span className={cn("absolute start-2 top-2.5 grid size-4 place-items-center", !ticking && reveal("row", { row: true, overlay: true }))}>
                        <Checkbox aria-label={`Tick ${act}`} checked={ticked.has(keyOf(item))} onCheckedChange={(on) => onTick(item, on)} />
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function SentList({
  items,
  current,
  nameOf,
  onSelect,
}: {
  items: HostItem[];
  current: HostItem | null;
  nameOf: (environmentId: string, workspaceId: string | null) => string;
  onSelect: (item: HostItem) => void;
}) {
  const days = new Map<string, HostItem[]>();
  for (const item of items) {
    const day = dayOf(item.decidedAt ?? item.updatedAt);
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  return (
    <div className="flex flex-col p-1">
      {[...days].map(([day, rows]) => (
        <section key={day} aria-label={day}>
          <div className="mt-3 flex h-7 items-center ps-2 text-xs font-medium text-muted-foreground first:mt-1">{day}</div>
          <ul className="flex flex-col gap-0.5">
            {rows.map((item) => {
              const { act, about } = rowWords(item);
              const active = current !== null && keyOf(current) === keyOf(item);
              const at = item.decidedAt ?? item.updatedAt;
              return (
                <li key={keyOf(item)}>
                  <ItemButton
                    size="sm"
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelect(item)}
                    className={cn("flex-col flex-nowrap items-stretch gap-0 rounded-md px-2 py-2 text-left transition-none", active ? "bg-muted" : "hover:bg-foreground/5")}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <SectorDot sector={item.sector} className="size-4" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">{pastTense(act, item.verb, item.kind)}</span>
                      <time className="shrink-0 text-xs tabular-nums text-muted-foreground">{timeOf(at)}</time>
                    </span>
                    <span className="truncate ps-6 text-xs leading-4 text-muted-foreground">{about ?? nameOf(item.environmentId, item.workspaceId)}</span>
                  </ItemButton>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** "Send to Dana Lee" → "Sent to Dana Lee", by the act's own verb. */
function pastTense(act: string, verb: string, kind: string): string {
  return act.startsWith(verb) ? `${pastOf(verb, kind)}${act.slice(verb.length)}` : act;
}

// ── the detail ────────────────────────────────────────────────────────────

/**
 * Who, where and when, over the act's name. `narrowOnly` facts (a held
 * item's workspace) show only in the narrow stack: wide, the list's group
 * heading beside the detail already names them.
 */
function DetailHead({ item, facts, narrowOnly = [], menu }: { item: HostItem; facts: string[]; narrowOnly?: string[]; menu?: React.ReactNode }) {
  const { act } = splitSummary(item.summary);
  return (
    <header className="flex flex-col">
      <div className="flex min-h-7 items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
          <SectorDot sector={item.sector} className="-ms-1 size-4" />
          {narrowOnly.length ? (
            <>
              <Facts parts={facts} className="min-w-0 @max-[40rem]/outbox:hidden" />
              <Facts parts={[...narrowOnly, ...facts]} className="hidden min-w-0 @max-[40rem]/outbox:inline-flex" />
            </>
          ) : (
            <Facts parts={facts} className="min-w-0" />
          )}
        </span>
        {menu}
      </div>
      <h1 className="mt-1 text-base font-semibold leading-6 tracking-[-0.01em] text-balance">
        {kindHeading(item.kind, item.payload, item.state === "sent") ?? (item.state === "sent" ? pastTense(act, item.verb, item.kind) : act)}
      </h1>
    </header>
  );
}

function ThreadMenu({ item, onOpenSession }: { item: HostItem; onOpenSession?: Props["onOpenSession"] }) {
  if (!item.sessionId || !onOpenSession) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" className="text-muted-foreground" />}>
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onOpenSession(item.sessionId!, item.environmentId)}>Open the thread</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const threadWords = (item: HostItem): string | null => {
  const title = item.sessionId ? storeTitleOf(item.sessionId) : null;
  return title ? `from ${title}` : null;
};

/**
 * A LifeOS mail is read whole before it may go: the list leaves out the quote
 * LifeOS sends under a reply, and his press approves what he read (the hold
 * review's finding 28). Other kinds show as listed.
 */
function useWhole(item: HostItem): { shown: HostItem; ready: boolean; failed: boolean; retry(): void } {
  const needs = item.kind === "mail.send";
  const key = JSON.stringify([item.ref, item.updatedAt]);
  const [read, setRead] = useState<{ key: string; item: HostItem | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!needs) return;
    let live = true;
    setRead(null);
    fetchItem(item.environmentId, item.ref).then(
      (whole) => live && setRead({ key, item: { ...whole, environmentId: item.environmentId } as HostItem }),
      () => live && setRead({ key, item: null }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again for another item, a change, or a Retry
  }, [key, attempt]);
  if (!needs) return { shown: item, ready: true, failed: false, retry: () => {} };
  const mine = read?.key === key ? read : null;
  return { shown: mine?.item ?? item, ready: !!mine?.item, failed: !!mine && !mine.item, retry: () => setAttempt((n) => n + 1) };
}

/**
 * A held item whole, with its verbs: what the Outbox shows beside its list, and what Today shows in a sheet over its
 * page (work/today/HeldSheet.tsx), so there is one Send and one rule for it. It fills a flex column: the payload
 * scrolls, the verb bar stays at the foot.
 */
export function HeldDetail({
  item: listed,
  workspace,
  host,
  alone = false,
  onOpenSession,
  onPressed,
  onReview,
}: {
  item: HostItem;
  workspace: string;
  host: string;
  /** No list beside it names the workspace (Today's sheet): the head's facts say it at every width. */
  alone?: boolean;
  onOpenSession?: Props["onOpenSession"];
  onPressed: (item: HostItem) => void;
  onReview: (item: HostItem) => void;
}) {
  const { shown: item, ready: read, failed: unread, retry } = useWhole(listed);
  const picture = usePicture(listed);
  // Send waits until all he approves is on screen: the act's own view loaded, the mail read whole, the act's kept picture drawn (the hold review).
  // The act's own view says when its payload is on screen, again after its Retry, and not while its boundary shows an error.
  const [viewLoaded, setViewLoaded] = useState(false);
  const ready = read && pictureShown(picture) && viewLoaded;
  const [busy, setBusy] = useState<"send" | "discard" | "grant" | null>(null);
  const [editing, setEditing] = useState(false);
  const grant = grantFor(item);
  const { about } = splitSummary(item.summary);
  const press = async (which: "send" | "again" | "discard" | "grant") => {
    setBusy(which === "again" ? "send" : which);
    try {
      const after = which === "discard" ? await discardItem(item) : which === "grant" ? await grantAndSend(item, grant!) : await sendItem(item, { again: which === "again" });
      if (which !== "discard" && !wentOut(after)) return void toastError(notSentWords(after));
      onPressed(item);
      const done = which === "discard" ? "Discarded" : `${pastOf(item.verb, item.kind)}${about ? `: ${about}` : ""}`;
      // A plain press may have completed a run: the host makes the offer before it answers.
      const earned = which === "send" || which === "again" ? await offerAfterPress(item) : null;
      if (earned) toastEarned(done, earned, () => onReview(item));
      else toast(done);
      if (which === "grant") toast(`Grant made: ${grant!.label}`);
    } catch (err) {
      toastError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const waiting = pressable(item);
  return (
    <>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-8 py-8">
          <DetailHead item={item} narrowOnly={alone ? [] : [workspace]} facts={[...(alone ? [workspace] : []), threadWords(item) ?? "", timeOf(item.createdAt)]} menu={<ThreadMenu item={item} onOpenSession={onOpenSession} />} />
          {item.state === "failed" ? (
            <div role="alert" className="flex items-start gap-2 text-[13px] leading-5">
              <StatusMark state="failed" word={false} />
              <span className="min-w-0 flex-1 text-destructive">{item.error ?? "It couldn't be sent."}</span>
            </div>
          ) : null}
          {item.kind === "computer.act" ? <p className="text-[13px] leading-5 text-muted-foreground">Takes {host}'s screen for a moment.</p> : null}
          {unread ? (
            <p role="alert" className="flex items-baseline gap-2 text-[13px] leading-5">
              <span className="text-destructive">The mail did not load</span>
              <Button variant="ghost" size="xs" onClick={retry}>
                Retry
              </Button>
            </p>
          ) : null}
          <ActView item={item} env={item.environmentId} onReady={setViewLoaded} />
          {/* While the mail is read whole, a bone where its quote may land: Send waits on it. */}
          {item.kind === "mail.send" && !read && !unread ? <Skeleton data-mail-quote-bone className="h-4 w-2/3 rounded" /> : null}
          {/* What his press approves: the window as the host read it, above the verbs. */}
          {item.kind === "computer.act" ? <KeptPicture item={item} picture={picture} /> : null}
        </div>
      </div>
      <VerbBar>
        <Button variant="ghost" size="sm" disabled={!waiting || busy !== null} onClick={() => void press("discard")}>
          <BusyLabel busy={busy === "discard"} label="Discard" />
        </Button>
        <span className="flex-1" />
        {/* A send that may have gone: no plain Send, only his own Send again once he has looked. */}
        {item.outcomeUnknown && waiting ? <span className="text-[13px] leading-5 text-muted-foreground">{checkWords(item)}</span> : null}
        {waiting && canEdit(item) ? (
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : null}
        {item.outcomeUnknown && waiting ? (
          <Button variant="secondary" size="sm" disabled={!ready || busy !== null} onClick={() => void press("again")}>
            <BusyLabel busy={busy === "send"} label={`${item.verb} again`} />
          </Button>
        ) : (
          <span className="flex items-center">
            <Button size="sm" disabled={!waiting || !ready || busy !== null} className={cn(grant && "rounded-e-none")} onClick={() => void press("send")}>
              <BusyLabel busy={busy === "send" || busy === "grant"} label={item.state === "failed" ? `${item.verb} again` : item.verb} />
            </Button>
            {grant ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button size="icon-sm" disabled={!waiting || !ready || busy !== null} aria-label={`More ways to ${item.verb.toLowerCase()}`} className="rounded-s-none border-s border-primary-foreground/15" />}
                >
                  <ChevronDown />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{item.verb} and stop holding</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => void press("grant")}>{grant.label}</DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </span>
        )}
      </VerbBar>
      {editing ? <EditDialog item={item} onClose={() => setEditing(false)} /> : null}
    </>
  );
}

function SentDetail({
  item,
  offer: listed,
  workspace,
  grantLabel,
  onOpenSession,
}: {
  item: HostItem;
  offer: HostOffer | null;
  workspace: string;
  grantLabel: string | null;
  onOpenSession?: Props["onOpenSession"];
}) {
  const picture = usePicture(item);
  // The offer stays on screen once shown, so taking it can say so (with Undo) after the host stops listing it.
  const [offer, setOffer] = useState<HostOffer | null>(listed);
  useEffect(() => {
    if (listed) setOffer(listed);
  }, [listed]);
  // The act's Result carries its way back (work_results); a mail has none.
  const results = useResults(item.environmentId, item.sessionId ?? "", !!item.sessionId);
  const result = results.rows.find((r) => {
    const held = (r.ref as { held?: { at: string; id: string } } | null)?.held;
    return held?.at === item.ref.at && held.id === item.ref.id;
  });
  const [busy, setBusy] = useState(false);
  const at = item.decidedAt ?? item.updatedAt;
  const back = async () => {
    if (!result) return;
    setBusy(true);
    try {
      await undoResult(result);
      toast(`${result.undo?.label ?? "Undone"}: ${splitSummary(item.summary).about ?? item.summary}`);
    } catch (err) {
      toastError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-8 py-8">
          <DetailHead item={item} facts={[workspace, `${decidedWords(item, grantLabel)} ${dayOf(at) === "Today" ? "at" : "on"} ${timeOf(at)}`]} menu={<ThreadMenu item={item} onOpenSession={onOpenSession} />} />
          <ActView item={item} env={item.environmentId} />
          {item.kind === "computer.act" ? <KeptPicture item={item} picture={picture} /> : null}
          {offer ? <OfferLine offer={offer} /> : null}
        </div>
      </div>
      <VerbBar>
        <span className="flex-1" />
        {!results.loaded ? null : results.error && !result ? (
          <>
            <span className="min-w-0 truncate text-[13px] text-destructive">{results.error}</span>
            <Button variant="ghost" size="sm" disabled={results.reading} onClick={() => loadResults(item.environmentId, item.sessionId ?? "")}>
              <BusyLabel busy={results.reading} label="Retry" />
            </Button>
          </>
        ) : result?.undoneAt ? (
          <span className="text-[13px] text-muted-foreground">Taken back at {timeOf(result.undoneAt)}</span>
        ) : result?.undo ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void back()}>
            <BusyLabel busy={busy} label={result.undo.label ?? "Undo"} />
          </Button>
        ) : (
          <span className="text-[13px] text-muted-foreground">{item.kind === "mail.send" || item.kind === "office.mail.send" ? "Sent mail cannot be taken back" : "This cannot be taken back"}</span>
        )}
      </VerbBar>
    </>
  );
}

function TickedDetail({ items, onClear, onSend }: { items: HostItem[]; onClear: () => void; onSend: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3 px-8 py-8">
          <h1 className="text-base font-semibold leading-6 tracking-[-0.01em]">Ticked</h1>
          <ul className="flex flex-col">
            {items.map((item) => {
              const { act, about } = rowWords(item);
              return (
                // Narrow, the act and what it is about take a line each, so a long recipient never pushes the subject off.
                <li key={keyOf(item)} data-ticked-row className="flex min-h-8 min-w-0 items-center gap-2 border-t border-border text-[13px] leading-5 first:border-t-0 @max-[40rem]/outbox:items-start @max-[40rem]/outbox:py-1.5">
                  <span className="flex h-5 shrink-0 items-center">
                    <KindGlyph kind={item.kind} />
                  </span>
                  <span className="flex min-w-0 flex-1 items-baseline gap-2 @max-[40rem]/outbox:flex-col @max-[40rem]/outbox:items-stretch @max-[40rem]/outbox:gap-0">
                    <span data-ticked-act className="shrink-0 @max-[40rem]/outbox:shrink @max-[40rem]/outbox:break-words">{act}</span>
                    {about ? <span data-ticked-about className="min-w-0 truncate text-muted-foreground">{about}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <VerbBar>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClear}>
          Clear
        </Button>
        <span className="flex-1" />
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onSend().finally(() => setBusy(false));
          }}
        >
          <BusyLabel busy={busy} label={`Send ${items.length}`} />
        </Button>
      </VerbBar>
    </>
  );
}

/** The detail's foot: the hairline across the pane, its verbs in the detail's own 640px column so they line up with the text. */
function VerbBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0 border-t border-border">
      <div className="mx-auto flex min-h-14 w-full max-w-[640px] items-center gap-2 px-8 py-3 @max-[40rem]/outbox:px-4">{children}</div>
    </div>
  );
}

/** While the Outbox first loads: the detail's head and a few lines, in its column. */
function DetailSkeleton() {
  return (
    <div role="status" aria-label="Loading the item" aria-busy className="mx-auto flex w-full max-w-[640px] flex-col gap-2 px-8 py-8">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="mt-1 h-4 w-64 max-w-full" />
      <div className="mt-4 flex flex-col gap-3">
        <Skeleton className="h-3 w-[88%]" />
        <Skeleton className="h-3 w-[72%]" />
        <Skeleton className="h-3 w-[80%]" />
      </div>
    </div>
  );
}

/**
 * A computer act's kept picture: the window as it was read, in the held
 * detail (what his press approves) and in its Sent record (DESIGN.md
 * "Around the canvas"). The list leaves the picture's bytes out, so the
 * whole act is read for it; an act that kept none draws nothing, and a read
 * that failed says so with Retry.
 */
type Picture = { kept: { width?: number; height?: number } | null | undefined; src: string | null | undefined | "failed"; loaded: boolean; retry(): void; onLoad(): void; onError(): void };

/** The kept picture of a computer act, read whole: undefined while it comes, "failed" when the host did not answer, null when none was kept. */
function usePicture(item: HostItem): Picture {
  const kept = item.kind === "computer.act" ? (item.payload as { picture?: { width?: number; height?: number } | null } | null)?.picture : null;
  const key = kept ? JSON.stringify(item.ref) : null;
  const [src, setSrc] = useState<string | null | undefined | "failed">(undefined);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    let live = true;
    setSrc(undefined);
    setLoaded(false);
    fetchItem(item.environmentId, item.ref).then(
      (whole) => {
        const picture = (whole.payload as { picture?: { data?: string; mimeType?: string } | null } | null)?.picture;
        // A picture the act kept but whose bytes did not come is a failure, never "none kept".
        if (live) setSrc(picture?.data ? `data:${picture.mimeType ?? "image/jpeg"};base64,${picture.data}` : "failed");
      },
      () => live && setSrc("failed"),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again only for another act or a Retry
  }, [key, attempt]);
  return { kept, src: key ? src : null, loaded, retry: () => setAttempt((n) => n + 1), onLoad: () => setLoaded(true), onError: () => setSrc("failed") };
}

/** Whether what his press approves is all on screen: a computer act's kept picture has drawn, or none was kept. */
const pictureShown = (p: Picture): boolean => p.src === null || (typeof p.src === "string" && p.src !== "failed" && p.loaded);

function KeptPicture({ item, picture }: { item: HostItem; picture: Picture }) {
  const { kept, src } = picture;
  const key = kept ? "kept" : null;
  if (!key || src === null) return null;
  const shape = kept?.width && kept.height ? `${kept.width} / ${kept.height}` : "16 / 10";
  if (src === undefined) return <Skeleton className="w-full rounded-lg" style={{ aspectRatio: shape }} />;
  if (src === "failed")
    return (
      <p className="flex items-baseline gap-2 text-[13px] leading-5">
        <span className="text-destructive">The picture did not load</span>
        <Button variant="ghost" size="xs" onClick={picture.retry}>
          Retry
        </Button>
      </p>
    );
  return <img src={src} onLoad={picture.onLoad} onError={picture.onError} alt={`The window as it was read, ${item.summary}`} draggable={false} className="h-auto w-full rounded-lg outline outline-1 -outline-offset-1 outline-image-outline" style={{ aspectRatio: shape }} />;
}

/** A host's error row's Retry: that host alone asked again, busy and off while it reads; the row goes once it answers. */
export function HostRetry({ environmentId }: { environmentId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void loadHost(environmentId).finally(() => setBusy(false));
      }}
    >
      <BusyLabel busy={busy} label="Retry" />
    </Button>
  );
}
