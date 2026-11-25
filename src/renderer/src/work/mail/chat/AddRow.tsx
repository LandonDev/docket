import { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { ConvexProvider } from "convex/react";
import { MailClientProvider, useMailClient, type Draft, type MailClient } from "work-kit/mail";
import type { MailOffer } from "@shared/work/mailChat";
import { TruncateTip } from "../../../components/tip";
import { Button } from "../../../components/ui/button";
import { StatusMark } from "../../../components/ui/status";
import { openWorkView } from "../../../lib/workSwitch";
import { useOpOutcome } from "../../agenda/added";
import { NewEventDialog } from "../../agenda/NewEventDialog";
import { Calendar, Task } from "../../icons";
import type { LifeosSession } from "../../shell/lifeos";
import { NewTaskDialog } from "../../tasks/NewTaskDialog";
import type { WorkViewProps } from "../../views/registry";
import { mailClientFor } from "../client";
import { answerOf } from "../writeAnswer";
import { CARD } from "./cardParts";
import type { OfferAt } from "./OfferCard";

type TaskOffer = Extract<MailOffer, { task: unknown }>["task"];
type EventOffer = Extract<MailOffer, { event: unknown }>["event"];

const pad = (n: number): string => String(n).padStart(2, "0");
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** An ISO time as LifeOS reads one: no offset is his own zone, and a day alone is 09:00 that morning. */
export function localOf(iso: string | undefined): Date | null {
  if (!iso) return null;
  const at = new Date(DAY_ONLY.test(iso) ? `${iso}T09:00` : iso);
  return Number.isNaN(at.getTime()) ? null : at;
}
/** An ISO time as the forms take it: its day and its clock, in his own zone. */
export function formOf(iso: string | undefined): { day: string; time: string } | null {
  const at = localOf(iso);
  if (!at || Number.isNaN(at.getTime())) return null;
  return { day: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, time: `${pad(at.getHours())}:${pad(at.getMinutes())}` };
}

const when = (iso: string | undefined): string | null => {
  const at = localOf(iso);
  if (!at || Number.isNaN(at.getTime())) return null;
  const dayOnly = DAY_ONLY.test(iso!);
  return at.toLocaleString([], dayOnly ? { weekday: "short", month: "short", day: "numeric" } : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

type MailActions = ReturnType<MailClient["useMailActions"]>;

/** What his Add came to, by card: a task LifeOS took, or the calendar change it queued, watched until Google answers. */
type Added = { task: true } | { op: string };

/** An Add form he opened from a card, with what fills it. */
interface AddHold {
  key: string;
  task?: TaskOffer;
  event?: EventOffer;
  at: OfferAt;
}

// The form Mail's frame holds, by workspace, and what each card's Add came to, by card: kept outside every card, so a
// card the session's drop takes away (and draws again once it is back) finds both where it left them.
const holds = new Map<string, AddHold>();
const addedByCard = new Map<string, Added>();
const listeners = new Set<() => void>();
const changed = (): void => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

function holdForm(workspaceId: string, next: AddHold | null, key: string): void {
  if (next) holds.set(workspaceId, next);
  else if (holds.get(workspaceId)?.key === key) holds.delete(workspaceId);
  else return;
  changed();
}

/** Records what his Add came to on the card `key` (a still page sets it to show a state). */
export function markAdded(key: string, added: Added): void {
  addedByCard.set(key, added);
  changed();
}

/**
 * The workspace whose Mail view holds its dock's Add forms (`MailAddKept`, drawn as Mail's `WorkViewModule.Kept`); null
 * where no view does (a thread pane, a still page). Mail provides it around the dock.
 */
export const AddHoldScope = createContext<string | null>(null);

/**
 * What a proposed task or event keeps above the card's LifeOS gate (`OfferSession`): whether its form is open and what
 * his Add came to. A session that drops swaps the card for its down line, never the form he has open: the form stays
 * with what he typed, says the line and holds Add, and writes through the new client once the session is back
 * (docs/DESIGN.md "Loading and empty states"). In Mail's dock the form is Mail's frame's (`AddHoldScope`), since a drop
 * takes the whole Mail view and the dock with it; elsewhere it is the keeper's own.
 */
interface AddKeep {
  open: boolean;
  added: Added | null;
  setOpen(open: boolean): void;
}
const AddKeepContext = createContext<AddKeep | null>(null);

/**
 * The keeper of a proposed task's or event's form: the card (`children`) is drawn inside the session's gate, the form
 * outside it, on `session` where there is one (else through the providers around it, as in a still page). `cardKey`
 * names the card for as long as its thread shows it (its block); a still page's card has its own.
 */
export function AddKeeper({ task, event, at, session, cardKey, children }: { task?: TaskOffer; event?: EventOffer; at: OfferAt; session?: LifeosSession; cardKey?: string; children: ReactNode }) {
  const own = useId();
  const key = cardKey ?? own;
  const framed = useContext(AddHoldScope) === at.workspaceId;
  const [openHere, setOpenHere] = useState(false);
  const heldThere = useSyncExternalStore(subscribe, () => holds.get(at.workspaceId)?.key === key);
  const added = useSyncExternalStore(subscribe, () => addedByCard.get(key) ?? null);
  const open = framed ? heldThere : openHere;
  const keep: AddKeep = {
    open,
    added,
    setOpen: (next) => (framed ? holdForm(at.workspaceId, next ? { key, task, event, at } : null, key) : setOpenHere(next)),
  };
  return (
    <AddKeepContext.Provider value={keep}>
      {children}
      {open && !framed ? <AddForm hold={{ key, task, event, at }} session={session} onClose={() => setOpenHere(false)} /> : null}
    </AddKeepContext.Provider>
  );
}

/**
 * Mail's `Kept`: the Add form a card in its dock opened, drawn by the view's frame above every gate, on the frame's
 * session. It goes when he closes it or leaves Mail.
 */
export function MailAddKept({ workspace, lifeos }: Pick<WorkViewProps, "workspace" | "lifeos">) {
  const id = workspace.id;
  const hold = useSyncExternalStore(subscribe, () => holds.get(id) ?? null);
  useEffect(
    () => () => {
      const was = holds.get(id);
      if (was) holdForm(id, null, was.key);
    },
    [id],
  );
  return hold ? <AddForm key={hold.key} hold={hold} session={lifeos} onClose={() => holdForm(id, null, hold.key)} /> : null;
}

/** New task or New event filled in from the card; what his Add came to is the card's (`markAdded`). */
function AddForm({ hold, session, onClose }: { hold: AddHold; session?: LifeosSession; onClose(): void }) {
  const { key, task, event, at } = hold;
  const actions = useRef<MailActions | null>(null);
  if (task) {
    const threadId = task.threadId;
    return (
      <>
        {threadId ? <MailActionsLive session={session} sector={at.sector} into={actions} /> : null}
        <NewTaskDialog
          sector={at.sector}
          initial={{ title: task.title, due: formOf(task.due)?.day }}
          // Mail's Make task, which links the task to its mail; the card says Added only once LifeOS took the write.
          file={
            threadId
              ? async ({ title, dueAt }) => {
                  const now = actions.current;
                  // Add is held while the session has no client, so a press always finds Mail's actions here.
                  if (!now) throw new Error("LifeOS did not add the task");
                  const answer = await answerOf(() => now.makeTask(threadId, { title, sector: at.sector as Draft["sector"], dueAt, pinned: false, waitingOn: "", notes: task.notes ?? "" }));
                  if (!answer.ok) throw answer.error;
                }
              : undefined
          }
          onAdded={() => markAdded(key, { task: true })}
          onClose={onClose}
          session={session}
        />
      </>
    );
  }
  const start = formOf(event?.start);
  const end = formOf(event?.end);
  return (
    <NewEventDialog
      sector={at.sector}
      startsAt={null}
      initial={{ title: event?.title ?? "", where: event?.where ?? "", ...(start ? { day: start.day, from: start.time } : {}), ...(end ? { to: end.time } : {}) }}
      onAdded={(op) => markAdded(key, { op })}
      onClose={onClose}
      session={session}
    />
  );
}

/**
 * Mail's actions over the form's own session, handed up in a ref the form reads at its press: never a card's, which a
 * drop takes away. With no session (a still page), the Mail client around it.
 */
function MailActionsLive({ session, sector, into }: { session?: LifeosSession; sector: OfferAt["sector"]; into: RefObject<MailActions | null> }) {
  if (!session) return <ActionsInto into={into} />;
  if (!session.client) return null;
  return (
    <ConvexProvider client={session.client}>
      <MailClientProvider client={mailClientFor(session.environmentId, session.client.url, sector)}>
        <ActionsInto into={into} />
      </MailClientProvider>
    </ConvexProvider>
  );
}

function ActionsInto({ into }: { into: RefObject<MailActions | null> }) {
  const actions = useMailClient().useMailActions();
  // The newest, in a ref: a press reads them, a render hands nothing up.
  useEffect(() => {
    into.current = actions;
  });
  return null;
}

/**
 * A task or an event the chat proposes, as one 44px row: its glyph, its title and when. Add… opens the sheet he
 * already knows, filled in: New task (filed by Mail's Make task when it names a mail, so the task links to it) or
 * New event. He saves there. A task says Added, with Open, once LifeOS took it; an event says Queued until LifeOS's
 * calendar change is done (then Added, with Open) or refused (then why, in its line's place, and Add… again). The form
 * is its keeper's (`AddKeeper`), one drawn around it here where no session gate holds one.
 */
export function AddRow(props: { task?: TaskOffer; event?: EventOffer; at: OfferAt }) {
  const keep = useContext(AddKeepContext);
  if (keep) return <Row {...props} keep={keep} />;
  return (
    <AddKeeper {...props}>
      <AddRow {...props} />
    </AddKeeper>
  );
}

function Row({ task, event, at, keep }: { task?: TaskOffer; event?: EventOffer; at: OfferAt; keep: AddKeep }) {
  const outcome = useOpOutcome(keep.added && "op" in keep.added ? keep.added.op : null);
  const title = task?.title ?? event?.title ?? "";
  const line = task ? (task.due ? `Due ${when(task.due)}` : null) : [when(event?.start), event?.where].filter(Boolean).join(", ") || null;
  const refused = outcome?.status === "failed" ? outcome.reason : null;
  const added = !!keep.added && ("task" in keep.added || outcome?.status === "done");
  const Glyph = task ? Task : Calendar;
  return (
    <div data-mail-offer={task ? "task" : "event"} className={`${CARD} flex h-11 items-center gap-2.5 px-3`}>
      <Glyph className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{title}</span>
        {refused ? (
          <TruncateTip text={refused}>
            <span data-add-refused role="alert" className="min-w-0 truncate text-xs text-destructive">
              {refused}
            </span>
          </TruncateTip>
        ) : line ? (
          <span className="shrink-0 truncate text-xs text-muted-foreground">{line}</span>
        ) : null}
      </div>
      {added ? (
        <>
          <span className="text-xs text-muted-foreground">Added</span>
          <Button variant="ghost" size="sm" onClick={() => openWorkView({ workspaceId: at.workspaceId, view: task ? "tasks" : "agenda" })}>
            Open
          </Button>
        </>
      ) : outcome?.status === "pending" ? (
        <StatusMark data-add-queued state="queued" className="shrink-0" />
      ) : (
        <Button variant="secondary" size="sm" onClick={() => keep.setOpen(true)}>
          Add…
        </Button>
      )}
    </div>
  );
}
