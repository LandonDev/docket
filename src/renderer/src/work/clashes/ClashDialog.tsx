import { makeFunctionReference } from "convex/server";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { clashTitle, driveLine, timeNear, type Clash, type ClashSide, type ClashWay } from "@shared/work/clashes";
import { addDays, startOfDay } from "work-kit/views/lib/agenda";
import { formatDayHeading } from "work-kit/views/lib/format";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { TruncateTip } from "../../components/tip";
import { BusyLabel, Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";
import { openWorkView } from "../../lib/workSwitch";
import { writeMail } from "../mail/mailto";
import { sectorName } from "../shell/actions";
import { sessionFailure, sessionWaits, useLifeosSession } from "../shell/lifeos";
import { useClashes } from "./mark";
import { doneWords, fieldOf, formOf, freeAfter, hintsOf, lateDraft, WAY_LABEL, wayWords, whenOf, type TimeForm } from "./model";
import type { ClashAsk } from "./open";

/**
 * The Clash dialog (docs/DESIGN.md "Clashes"): the two events in time order
 * with the drive between them, and under each the ways out it allows. A way
 * out swaps the body for its one step, which shows what goes before Send.
 * Decline, a proposed time and a move go as his own press through
 * `work.clashes.answer`; Running late opens Mail's composer, which holds its
 * own send; "This is fine" quiets the clash until a time or a place moves.
 */

type Side = "a" | "b";
type Step = { side: Side; way: Exclude<ClashWay, "late"> };
const eventGet = makeFunctionReference<"query">("events:get");

export function ClashDialog({ ask, onClose }: { ask: ClashAsk; onClose: () => void }) {
  // The clash's own day or two when the opener handed it over, else the fortnight every opener reads.
  // Whole local days (a day is 23 or 25 hours when the clocks change), so no event of the pair falls outside the read.
  const [from, to] = ask.clash ? [startOfDay(ask.clash.a.startsAt), addDays(startOfDay(ask.clash.b.startsAt), 1)] : [startOfDay(Date.now()), addDays(startOfDay(Date.now()), 14)];
  const marks = useClashes(ask.environmentId, from, to);
  const live = [...marks.clashes.values()].flat().find((c) => c.id === ask.id);
  const [pending, setPending] = useState(false);
  // His own press may be what ends the clash ("This is fine", a decline): the dialog keeps the clash it showed while that press is out and while it closes, and never turns to "No longer a clash" under his hand.
  const [settled, setSettled] = useState(false);
  // A way out's step he has open stays too, with what he typed: a calendar that settles the clash meanwhile is said in the step, never by taking the step away.
  const [stepping, setStepping] = useState(false);
  const shown = useRef<Clash | undefined>(undefined);
  // What the live read last said for certain: the clash, or that it is gone. A read that is out or has failed says nothing, so it changes neither: a clash seen gone never comes back from the opener's old copy.
  const known = useRef<{ clash: Clash | undefined } | null>(null);
  if (marks.ready) known.current = { clash: live };
  const read = known.current ? known.current.clash : ask.clash;
  const gone = known.current !== null && !known.current.clash;
  if (read) shown.current = read;
  const clash = read ?? (pending || settled || stepping ? shown.current : undefined);
  // Gone by something other than his press here: the title says so, and an open step sends nothing.
  const cleared = gone && !pending && !settled;
  // The day stays while a clash is on screen, so nothing under the title moves when the read lands.
  const day = clash ? formatDayHeading(startOfDay(clash.b.startsAt)) : undefined;
  const state = gone ? "gone" : marks.failed !== undefined ? "failed" : "loading";
  return (
    <Modal onClose={onClose} title={clash && !cleared ? clashTitle(clash) : gone ? "No longer a clash" : "Clash"} description={day} size="sm" busy={pending} data-clash-dialog={ask.id}>
      {clash ? <Body clash={clash} environmentId={ask.environmentId} onClose={onClose} pending={pending} setPending={setPending} onSettled={() => setSettled(true)} onStep={setStepping} cleared={cleared} /> : <Empty state={state} error={marks.failed} onClose={onClose} />}
    </Modal>
  );
}

/** One event's bones: its title, then its two lines. */
function EventBones() {
  return (
    <div className="flex flex-col gap-2 py-1">
      <Skeleton className="h-3.5 w-2/5" />
      <Skeleton className="h-3 w-3/5" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

/**
 * The dialog with no clash to show: the two events' bones with the hairline
 * between them while it is read; why, in words, when the read failed; and
 * nothing under the title once the two no longer clash, since the title says so.
 */
export function Empty({ state, error, onClose }: { state: "loading" | "failed" | "gone"; error?: string | undefined; onClose: () => void }) {
  return (
    <>
      {state === "loading" ? (
        <ModalBody className="gap-3">
          {/* The bones are for the eye; the wait is said once, in words, for a screen reader. */}
          <span role="status" className="sr-only">
            Reading the clash…
          </span>
          <div aria-hidden className="flex flex-col gap-3">
            <EventBones />
            <span className="h-px bg-border" />
            <EventBones />
          </div>
        </ModalBody>
      ) : null}
      {state === "failed" ? (
        <ModalBody>
          <div role="alert">
            <ErrorLine error={error || "LifeOS did not answer"} />
          </div>
        </ModalBody>
      ) : null}
      <Foot onClose={onClose} />
    </>
  );
}

/** An event's times: its start said beside the day the dialog names (bare on that day, its weekday within three days, else its date, in the row's line's words), and its end beside its own start, so a day before a range is never read to cover both ends. */
const span = (side: ClashSide, day: number) => `${timeNear(side.startsAt, day)} – ${timeNear(side.endsAt, side.startsAt)}`;
/** His calendar's own words for a place the map only has roughly; else the place as the map names it, less the country every one of them ends in. */
const placeOf = (side: ClashSide) => ((side.rough ? side.location : side.place) ?? side.location)?.replace(/, United States$/, "");

/** One event: its title, then its time and job on one muted line, then where it is. A group named for the event, so "Decline" under it says whose. */
function EventBlock({ side, day, children }: { side: ClashSide; day: number; children?: React.ReactNode }) {
  const place = placeOf(side);
  return (
    <div role="group" aria-label={side.title} className="flex min-w-0 flex-col">
      <TruncateTip text={side.title}>
        <span className="truncate font-medium text-foreground">{side.title}</span>
      </TruncateTip>
      <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs leading-5 text-muted-foreground">
        <span className="shrink-0 tabular-nums">{span(side, day)}</span>
        {/* The dot's box is the dot, so it sits 8px from the time and 8px from its job's name. */}
        <span className="inline-flex min-w-0 items-center gap-2">
          <SectorDot sector={side.sector} className="size-2" />
          <span className="truncate">{sectorName(side.sector)}</span>
        </span>
      </span>
      {place ? (
        <TruncateTip text={place}>
          <span className="truncate text-xs leading-5 text-muted-foreground">{place}</span>
        </TruncateTip>
      ) : null}
      {children}
    </div>
  );
}

function Foot({ onClose, start, busy }: { onClose: () => void; start?: React.ReactNode; busy?: boolean }) {
  const close = useModalClose();
  return (
    <DialogFooter start={start}>
      <Button data-dialog-cancel variant="secondary" disabled={busy} onClick={() => (close ? close(onClose) : onClose())}>
        Close
      </Button>
    </DialogFooter>
  );
}

function Body({
  clash,
  environmentId,
  onClose,
  pending,
  setPending,
  onSettled,
  onStep,
  cleared,
}: {
  clash: Clash;
  environmentId: string;
  onClose: () => void;
  pending: boolean;
  setPending: (p: boolean) => void;
  /** a press of his went through: the dialog is closing on what it shows */
  onSettled: () => void;
  /** a way out's step opened or closed */
  onStep: (open: boolean) => void;
  /** the two no longer clash, by something other than his press here */
  cleared: boolean;
}) {
  const close = useModalClose();
  const session = useLifeosSession(environmentId, null);
  const [step, setStepState] = useState<Step | null>(null);
  const setStep = (next: Step | null) => {
    setStepState(next);
    onStep(next !== null);
  };
  // What LifeOS said of the last Send, shown in the step until he sends again or goes back.
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState<"fine" | "late" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = registry.linkOf(environmentId);
  const done = (words: string, undo?: () => void) => {
    onSettled();
    void loadToast().then((toast) => toast(words, undo ? { action: { label: "Undo", onClick: undo } } : undefined));
    close ? close(onClose) : onClose();
  };
  const failed = (err: unknown, fallback: string) => {
    setPending(false);
    setBusy(null);
    setError(refusalWords(err) || fallback);
  };
  // Back puts focus where the step was opened from, so the keyboard never loses its place.
  const from = useRef<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step || !from.current) return;
    body.current?.querySelector<HTMLElement>(`[data-way="${from.current}"]`)?.focus();
    from.current = null;
  }, [step]);

  const fine = () => {
    setError(null);
    setPending(true);
    setBusy("fine");
    link.request("work.clashes.waive", { id: clash.id, on: true }, { lane: "ui" }).then(
      () => {
        done("Marked as fine", () => void link.request("work.clashes.waive", { id: clash.id, on: false }, { lane: "ui" }).catch(() => void loadToast().then((toast) => toast.error("Undo did not go through"))));
      },
      (err: unknown) => failed(err, "The host did not answer"),
    );
  };

  /** The people on the later event, then Mail's composer in that job's workspace with one line to them. */
  const late = () => {
    const workspaceId = clash.b.workspaceId;
    if (!workspaceId) return;
    // A session that cannot read says so: a press never ends in nothing.
    if (!session.client) return setError(sessionWaits(session) ? "LifeOS is still connecting" : sessionFailure(session.state));
    setError(null);
    setPending(true);
    setBusy("late");
    session.client.query(eventGet, { id: clash.b.eventId }).then(
      (event: { attendees?: { address: string }[] } | null) => {
        setPending(false);
        const to = (event?.attendees ?? []).map((a) => a.address).filter((a) => a.includes("@"));
        if (!to.length) return failed(null, "Nobody on this event has an address");
        openWorkView({ workspaceId, view: "mail" });
        writeMail(lateDraft(clash, to));
        close ? close(onClose) : onClose();
      },
      (err: unknown) => failed(err, "LifeOS did not answer"),
    );
  };

  if (step) {
    return (
      <StepForm
        clash={clash}
        step={step}
        pending={pending}
        refused={refused}
        cleared={cleared}
        onBack={() => {
          from.current = `${step.side}:${step.way}`;
          setRefused(null);
          setStep(null);
        }}
        onSend={(params) => {
          setRefused(null);
          setPending(true);
          link.request("work.clashes.answer", { eventId: clash[step.side].eventId, way: step.way, ...params }, { lane: "ui" }).then(
            () => {
              done(doneWords(step.way, clash[step.side].title));
            },
            (err: unknown) => {
              setPending(false);
              setRefused(refusalWords(err) || "LifeOS refused it");
            },
          );
        }}
      />
    );
  }

  return <Events clash={clash} pending={pending} busy={busy} error={error} onClose={onClose} onFine={fine} onWay={(side, way) => (setError(null), way === "late" ? late() : setStep({ side, way }))} bodyRef={body} />;
}

/** The two events in time order with the drive between them, the ways out under each, and the foot. */
export function Events({
  clash,
  pending,
  busy,
  error,
  onClose,
  onFine,
  onWay,
  bodyRef,
}: {
  clash: Clash;
  pending: boolean;
  busy: "fine" | "late" | null;
  error: string | null;
  onClose: () => void;
  onFine: () => void;
  onWay: (side: Side, way: ClashWay) => void;
  bodyRef?: React.Ref<HTMLDivElement>;
}) {
  const drive = driveLine(clash);
  const day = startOfDay(clash.b.startsAt);
  const ways = (side: Side) => {
    const event = clash[side];
    // Running late needs Mail in that job's workspace on this host.
    const can = event.can.filter((way) => way !== "late" || (side === "b" && Boolean(event.workspaceId)));
    if (!can.length) return null;
    return (
      <span className="mt-2 flex flex-wrap gap-2">
        {can.map((way) => (
          <Button key={way} data-way={`${side}:${way}`} variant="outline" size="sm" disabled={pending} onClick={() => onWay(side, way)}>
            {way === "late" ? <BusyLabel busy={busy === "late"} label={WAY_LABEL.late} /> : WAY_LABEL[way]}
          </Button>
        ))}
      </span>
    );
  };
  return (
    <>
      <ModalBody ref={bodyRef} className="gap-3">
        <EventBlock side={clash.a} day={day}>
          {ways("a")}
        </EventBlock>
        {/* The hairline between the two is where the drive is, when there is one to say. */}
        <div data-clash-drive className="flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          {drive ? <span className="text-xs leading-5 text-muted-foreground tabular-nums">{drive}</span> : null}
          {drive ? <span className="h-px flex-1 bg-border" /> : null}
        </div>
        <EventBlock side={clash.b} day={day}>
          {ways("b")}
        </EventBlock>
        <div role="alert" className="empty:hidden">
          <ErrorLine error={error} />
        </div>
      </ModalBody>
      <Foot
        onClose={onClose}
        busy={pending}
        start={
          <Button data-clash-fine variant="ghost" disabled={pending} onClick={onFine}>
            <BusyLabel busy={busy === "fine"} label="This is fine" />
          </Button>
        }
      />
    </>
  );
}

/** One way out, whole, before it goes: the event, what goes and to whom, and what he may add or set. */
export function StepForm({
  clash,
  step,
  pending,
  refused = null,
  cleared = false,
  onBack,
  onSend,
}: {
  clash: Clash;
  step: Step;
  pending: boolean;
  /** what LifeOS said of the last Send, in its own words */
  refused?: string | null;
  /** the two no longer clash: what he typed stays to read or copy, and nothing more can be sent */
  cleared?: boolean;
  onBack: () => void;
  onSend: (params: { comment?: string; start?: number; end?: number }) => void;
}) {
  const event = clash[step.side];
  // The time offered is kept as the instant it is: fields he leaves alone send that instant, whatever a clock change makes of its clock time.
  const [offered] = useState(() => freeAfter(clash, event.eventId));
  const [form, setForm] = useState<TimeForm>(() => formOf(offered));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // What was wrong with the times is said of the times as they were: an edit takes it away, and Send says it again if it still holds.
  const patch = (p: Partial<TimeForm>) => {
    setForm((f) => ({ ...f, ...p }));
    setError(null);
  };
  const bad = fieldOf(error);
  const hints = hintsOf(form, offered);
  const timed = step.way !== "decline";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (cleared) return;
    const when = timed ? whenOf(form, offered) : null;
    if (typeof when === "string") return setError(when);
    // A proposal goes to another person and a move has no Undo: neither goes to a time already gone.
    if (when && when.start < Date.now()) return setError("That time has passed");
    setError(null);
    onSend({ ...(note.trim() && step.way !== "move" ? { comment: note.trim() } : {}), ...(when ?? {}) });
  };
  return (
    <form onSubmit={submit} data-clash-step={`${step.side}:${step.way}`}>
      <ModalBody>
        <EventBlock side={event} day={startOfDay(clash.b.startsAt)} />
        {/* One place, always there: what goes and to whom, or that nothing went once the two no longer clash, read out as it turns. The first sentence keeps its lines under the second, so the fields below stay where they are. */}
        <p aria-live="polite" className="grid text-[13px] leading-5 text-muted-foreground">
          <span className={cn("col-start-1 row-start-1", cleared && "invisible")}>{wayWords(step.way, event.guests)}</span>
          {cleared ? <span className="col-start-1 row-start-1">Nothing was sent.</span> : null}
        </p>
        {timed ? (
          <div className="grid grid-cols-[minmax(0,1fr)_112px_112px] gap-2">
            <Field label="Day">
              <Input autoFocus type="date" disabled={pending} value={form.day} onChange={(e) => patch({ day: e.target.value })} />
            </Field>
            <Field label="From" hint={hints.from}>
              <Input type="time" disabled={pending} aria-invalid={bad === "from" || undefined} value={form.from} onChange={(e) => patch({ from: e.target.value })} />
            </Field>
            <Field label="To" hint={hints.to}>
              <Input type="time" disabled={pending} aria-invalid={bad === "to" || undefined} value={form.to} onChange={(e) => patch({ to: e.target.value })} />
            </Field>
          </div>
        ) : null}
        {step.way !== "move" ? (
          <Field label="Note">
            <Textarea autoFocus={!timed} disabled={pending} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </Field>
        ) : null}
        <div role="alert" className="empty:hidden">
          <ErrorLine error={error ?? refused} />
        </div>
      </ModalBody>
      <DialogFooter confirmLabel={step.way === "move" ? "Move" : "Send"} pending={pending} disabled={cleared}>
        <Button data-clash-back variant="secondary" disabled={pending} onClick={onBack}>
          Back
        </Button>
      </DialogFooter>
    </form>
  );
}
