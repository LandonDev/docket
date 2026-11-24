import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMailClient, type Draft, type MailClient } from "work-kit/mail";
import type { MailOffer } from "@shared/work/mailChat";
import { Button } from "../../../components/ui/button";
import { openWorkView } from "../../../lib/workSwitch";
import { NewEventDialog } from "../../agenda/NewEventDialog";
import { Calendar, Task } from "../../icons";
import type { LifeosSession } from "../../shell/lifeos";
import { NewTaskDialog } from "../../tasks/NewTaskDialog";
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

/**
 * What a proposed task or event keeps above the card's LifeOS gate (`OfferSession`): whether its form is open, whether
 * it was added, and Mail's newest actions (a task that names a mail files through Make task). A session that drops
 * swaps the card for its down line, never the form he has open: the form stays with what he typed, says the line and
 * holds Add, and writes through the new client once the session is back (docs/DESIGN.md "Loading and empty states").
 */
interface AddKeep {
  open: boolean;
  added: boolean;
  setOpen(open: boolean): void;
  /** Mail's actions as the card last drew them, over the session that reads. */
  actions: { current: MailActions | null };
}
const AddKeepContext = createContext<AddKeep | null>(null);

/**
 * The keeper of a proposed task's or event's form: the card (`children`) is drawn inside the session's gate, the form
 * beside it, outside, on `session` where there is one (else through the providers around it, as in a still page).
 */
export function AddKeeper({ task, event, at, session, children }: { task?: TaskOffer; event?: EventOffer; at: OfferAt; session?: LifeosSession; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState(false);
  const actions = useRef<MailActions | null>(null);
  const keep = useMemo<AddKeep>(() => ({ open, added, setOpen, actions }), [open, added]);
  const start = formOf(event?.start);
  const end = formOf(event?.end);
  return (
    <AddKeepContext.Provider value={keep}>
      {children}
      {open && task ? (
        <NewTaskDialog
          sector={at.sector}
          initial={{ title: task.title, due: formOf(task.due)?.day }}
          file={task.threadId ? ({ title, dueAt }) => actions.current!.makeTask(task.threadId!, { title, sector: at.sector as Draft["sector"], dueAt, pinned: false, waitingOn: "", notes: task.notes ?? "" }) : undefined}
          onAdded={() => setAdded(true)}
          onClose={() => setOpen(false)}
          session={session}
        />
      ) : null}
      {open && event ? (
        <NewEventDialog
          sector={at.sector}
          startsAt={null}
          initial={{ title: event.title, where: event.where ?? "", ...(start ? { day: start.day, from: start.time } : {}), ...(end ? { to: end.time } : {}) }}
          onAdded={() => setAdded(true)}
          onClose={() => setOpen(false)}
          session={session}
        />
      ) : null}
    </AddKeepContext.Provider>
  );
}

/**
 * A task or an event the chat proposes, as one 44px row: its glyph, its title and when. Add… opens the sheet he
 * already knows, filled in: New task (filed by Mail's Make task when it names a mail, so the task links to it) or
 * New event. He saves there; then the row says Added, with Open. The form is its keeper's (`AddKeeper`), one drawn
 * around it here where no session gate holds one.
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
  const actions = useMailClient().useMailActions();
  // The newest actions, in a ref: a press reads them, a render hands nothing up.
  useEffect(() => {
    keep.actions.current = actions;
  });
  const title = task?.title ?? event?.title ?? "";
  const line = task ? (task.due ? `Due ${when(task.due)}` : null) : [when(event?.start), event?.where].filter(Boolean).join(", ") || null;
  const Glyph = task ? Task : Calendar;
  return (
    <div data-mail-offer={task ? "task" : "event"} className={`${CARD} flex h-11 items-center gap-2.5 px-3`}>
      <Glyph className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{title}</span>
        {line ? <span className="shrink-0 truncate text-xs text-muted-foreground">{line}</span> : null}
      </div>
      {keep.added ? (
        <>
          <span className="text-xs text-muted-foreground">Added</span>
          <Button variant="ghost" size="sm" onClick={() => openWorkView({ workspaceId: at.workspaceId, view: task ? "tasks" : "agenda" })}>
            Open
          </Button>
        </>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => keep.setOpen(true)}>
          Add…
        </Button>
      )}
    </div>
  );
}
