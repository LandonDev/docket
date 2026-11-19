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
import { ChevronDown, Globe, MoreHorizontal, Outbox, Plug, SquareMousePointer } from "../../chrome/icons";
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
import { ActView } from "../acts/ActView";
import { Calendar, Mail } from "../icons";
import { EditDialog } from "./EditDialog";
import { GrantsSheet } from "./GrantsSheet";
import { byWorkspace, dayOf, decidedWords, grantFor, pastOf, timeOf, WORK_CHATS_KEY } from "./model";
import { undoResult, useResults } from "./results";
import { discardItem, grantAndSend, loadOutbox, notSentWords, sendItem, sendMany, useOutbox, wentOut, type HostItem } from "./store";

const MIN_WIDTH = 240;
const MAX_WIDTH = 420;
let rememberedWidth = PAGE_LIST_WIDTH;
let rememberedTab: "waiting" | "sent" = "waiting";

/** An item's key across hosts. */
const keyOf = (item: Pick<HostItem, "environmentId" | "ref">): string => `${item.environmentId}:${item.ref.at}:${item.ref.id}`;
/** States a press may take an item from. */
const pressable = (item: HostItem): boolean => item.state === "held" || item.state === "live" || item.state === "failed";
/** What a plain Send may take, alone or with others: a send that may have gone waits for his own "Send again". */
const sendable = (item: HostItem): boolean => pressable(item) && !item.outcomeUnknown;
/** Where he looks to see whether a send that may have gone went. */
const checkWords = (item: HostItem): string => (item.kind === "mail.send" || item.kind === "office.mail.send" ? "Check Sent first" : "Check whether it went first");
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
  "addon.call": Plug,
  "computer.act": SquareMousePointer,
  "portal.submit": Globe,
};
function KindGlyph({ kind, className }: { kind: ActKind; className?: string }) {
  const Glyph = KIND_GLYPH[kind] ?? Outbox;
  return <Glyph className={cn("size-3.5 text-muted-foreground", className)} />;
}

const toast = (line: string) => void loadToast().then((t) => t(line));
const toastError = (line: string) => void loadToast().then((t) => t.error(line));
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
 * the red mark.
 */
export function OutboxView({ besideRail = false, onClose, onToggleSidebar, onOpenSession }: Props) {
  const outbox = useOutbox();
  const [tab, setTab] = useState<"waiting" | "sent">(rememberedTab);
  const [selected, setSelected] = useState<string | null>(null);
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

  const list = tab === "waiting" ? outbox.waiting : outbox.sent;
  // The detail shows only the item he picked: one that left under him (sent elsewhere, a grant, a stale draft)
  // leaves the detail empty, never the next item under the Send he was about to press.
  const current = selected === null ? null : (list.find((item) => keyOf(item) === selected) ?? null);
  const first = list[0] ? keyOf(list[0]) : null;
  useEffect(() => {
    if (selected === null && first !== null) setSelected(first);
  }, [selected, first]);
  // Ticks hold only items still waiting.
  const tickedItems = outbox.waiting.filter((item) => ticked.has(keyOf(item)) && sendable(item));
  const tick = (item: HostItem, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(keyOf(item));
      else next.delete(keyOf(item));
      return next;
    });

  // After a press the item leaves Waiting: the next one down takes the selection.
  const afterPress = (item: HostItem) => {
    const at = outbox.waiting.findIndex((x) => keyOf(x) === keyOf(item));
    const next = outbox.waiting[at + 1] ?? outbox.waiting[at - 1];
    setSelected(next ? keyOf(next) : null);
  };

  const sendSeveral = async (items: readonly HostItem[], where?: string): Promise<void> => {
    const { sent, failed } = await sendMany(items);
    setTicked(new Set());
    if (sent) toast(`${pastOf(items[0]?.verb ?? "Send")} ${sent}${where ? ` from ${where}` : ""}`);
    if (failed.length) toastError(`${failed.length} could not go: ${failed[0]!.error}`);
  };

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
          <Button size="xs" variant="ghost" onClick={() => void loadOutbox()}>
            Retry
          </Button>
        </div>
      ))}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div ref={resize.attachPane} className="relative flex h-full min-h-0 shrink-0 flex-col border-r border-border">
          <div className="flex shrink-0 items-center border-b border-border p-2">
            <Tabs
              value={tab}
              onValueChange={(v) => {
                setTab(v as "waiting" | "sent");
                setSelected(null);
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
          </div>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none">
            {!outbox.loaded && list.length === 0 ? (
              <SurfaceSkeleton kind="rows" lines={2} count={6} label="Loading the Outbox" />
            ) : list.length === 0 ? null : tab === "waiting" ? (
              <WaitingList
                items={outbox.waiting}
                current={current}
                ticked={ticked}
                ticking={ticked.size > 0}
                nameOf={nameOf}
                onSelect={(item) => setSelected(keyOf(item))}
                onTick={tick}
                onSendGroup={sendSeveral}
              />
            ) : (
              <SentList items={outbox.sent} current={current} nameOf={nameOf} onSelect={(item) => setSelected(keyOf(item))} />
            )}
          </div>
          <div
            {...sashKeys}
            className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none outline-none focus-visible:bg-accent ${resize.dragging ? "bg-foreground/12" : "hover:bg-foreground/7"}`}
            onPointerDown={resize.onPointerDown}
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {tab === "waiting" && tickedItems.length > 0 ? (
            <TickedDetail items={tickedItems} onClear={() => setTicked(new Set())} onSend={() => sendSeveral(tickedItems)} />
          ) : !outbox.loaded && list.length === 0 ? null : !current ? (
            list.length > 0 ? (
              <EmptyState title="No longer waiting" line="Another press or device decided it. Pick an item from the list." />
            ) : tab === "waiting" ? (
              <EmptyState title="Nothing held" line="What a thread would send, post or accept waits here for your press." />
            ) : (
              <EmptyState title="Nothing sent yet" line="What left the machine shows here, newest first." />
            )
          ) : tab === "waiting" ? (
            <HeldDetail key={keyOf(current)} item={current} workspace={nameOf(current.environmentId, current.workspaceId)} onOpenSession={onOpenSession} onPressed={afterPress} />
          ) : (
            <SentDetail key={keyOf(current)} item={current} workspace={nameOf(current.environmentId, current.workspaceId)} grantLabel={outbox.grants.find((g) => current.decidedBy === `grant:${g.id}`)?.label ?? null} onOpenSession={onOpenSession} />
          )}
        </div>
      </div>
      <GrantsSheet open={grantsOpen} onOpenChange={setGrantsOpen} grants={outbox.grants} nameOf={nameOf} />
    </div>
  );
}

// ── the lists ─────────────────────────────────────────────────────────────

function GroupHead({ sector, name, children }: { sector: string | null; name: string; children?: React.ReactNode }) {
  return (
    <div className="mt-3 flex h-7 items-center gap-2 pe-1 ps-2 first:mt-1">
      <SectorDot sector={sector} className="size-3.5" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">{name}</span>
      {children}
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
        const ready = group.items.filter(sendable);
        return (
          <section key={group.key} aria-label={name}>
            <GroupHead sector={group.sector} name={name}>
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
                const { act, about } = splitSummary(item.summary);
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
                    <span className={cn("pointer-events-none absolute start-2 top-2.5 grid size-4 place-items-center", sendable(item) && (ticking ? "opacity-0" : yields("row")))}>
                      {item.state === "failed" ? <StatusMark state="failed" word={false} /> : item.state === "sending" ? <StatusMark state="working" word={false} /> : <KindGlyph kind={item.kind} />}
                    </span>
                    {sendable(item) ? (
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
              const { act, about } = splitSummary(item.summary);
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
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">{pastTense(act, item.verb)}</span>
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
function pastTense(act: string, verb: string): string {
  return act.startsWith(verb) ? `${pastOf(verb)}${act.slice(verb.length)}` : act;
}

// ── the detail ────────────────────────────────────────────────────────────

/** Who, where and when, over the act's name. */
function DetailHead({ item, facts, menu }: { item: HostItem; facts: string[]; menu?: React.ReactNode }) {
  const { act } = splitSummary(item.summary);
  return (
    <header className="flex flex-col">
      <div className="flex min-h-7 items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
          <SectorDot sector={item.sector} className="-ms-1 size-4" />
          <span className="min-w-0 truncate">{facts.filter(Boolean).join(" · ")}</span>
        </span>
        {menu}
      </div>
      <h1 className="mt-1 text-base font-semibold leading-6 tracking-[-0.01em] text-balance">{item.state === "sent" ? pastTense(act, item.verb) : act}</h1>
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

function HeldDetail({ item, workspace, onOpenSession, onPressed }: { item: HostItem; workspace: string; onOpenSession?: Props["onOpenSession"]; onPressed: (item: HostItem) => void }) {
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
      toast(which === "discard" ? "Discarded" : `${pastOf(item.verb)}${about ? `: ${about}` : ""}`);
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
          <DetailHead item={item} facts={[workspace, threadWords(item) ?? "", timeOf(item.createdAt)]} menu={<ThreadMenu item={item} onOpenSession={onOpenSession} />} />
          {item.state === "failed" ? (
            <div role="alert" className="flex items-start gap-2 text-[13px] leading-5">
              <StatusMark state="failed" word={false} />
              <span className="min-w-0 flex-1 text-destructive">{item.error ?? "It couldn't be sent."}</span>
            </div>
          ) : null}
          {item.kind === "computer.act" ? <p className="text-[13px] leading-5 text-muted-foreground">Takes this host's screen for a moment.</p> : null}
          {item.proposed ? <p className="text-[13px] leading-5 text-muted-foreground">An agent's rewrite waits in this draft; what shows is what goes.</p> : null}
          <ActView item={item} env={item.environmentId} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-8 py-3">
        <Button variant="ghost" size="sm" disabled={!waiting || busy !== null} onClick={() => void press("discard")}>
          <BusyLabel busy={busy === "discard"} label="Discard" />
        </Button>
        <span className="flex-1" />
        {/* A send that may have gone: no plain Send, only his own Send again once he has looked. */}
        {item.outcomeUnknown && waiting ? <span className="text-[13px] leading-5 text-muted-foreground">{checkWords(item)}</span> : null}
        {waiting ? (
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : null}
        {item.outcomeUnknown && waiting ? (
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void press("again")}>
            <BusyLabel busy={busy === "send"} label={`${item.verb} again`} />
          </Button>
        ) : (
          <span className="flex items-center">
            <Button size="sm" disabled={!waiting || busy !== null} className={cn(grant && "rounded-e-none")} onClick={() => void press("send")}>
              <BusyLabel busy={busy === "send" || busy === "grant"} label={item.state === "failed" ? `${item.verb} again` : item.verb} />
            </Button>
            {grant ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button size="icon-sm" disabled={!waiting || busy !== null} aria-label={`More ways to ${item.verb.toLowerCase()}`} className="rounded-s-none border-s border-primary-foreground/15" />}
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
      </div>
      {editing ? <EditDialog item={item} onClose={() => setEditing(false)} /> : null}
    </>
  );
}

function SentDetail({ item, workspace, grantLabel, onOpenSession }: { item: HostItem; workspace: string; grantLabel: string | null; onOpenSession?: Props["onOpenSession"] }) {
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
        </div>
      </div>
      <div className="flex h-[57px] shrink-0 items-center gap-2 border-t border-border px-8">
        <span className="flex-1" />
        {!results.loaded ? null : result?.undoneAt ? (
          <span className="text-[13px] text-muted-foreground">Taken back at {timeOf(result.undoneAt)}</span>
        ) : result?.undo ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void back()}>
            <BusyLabel busy={busy} label={result.undo.label ?? "Undo"} />
          </Button>
        ) : (
          <span className="text-[13px] text-muted-foreground">{item.kind === "mail.send" || item.kind === "office.mail.send" ? "Sent mail cannot be taken back" : "This cannot be taken back"}</span>
        )}
      </div>
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
              const { act, about } = splitSummary(item.summary);
              return (
                <li key={keyOf(item)} className="flex h-8 min-w-0 items-center gap-2 border-t border-border text-[13px] first:border-t-0">
                  <KindGlyph kind={item.kind} />
                  <span className="shrink-0">{act}</span>
                  {about ? <span className="min-w-0 truncate text-muted-foreground">{about}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-8 py-3">
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
      </div>
    </>
  );
}
