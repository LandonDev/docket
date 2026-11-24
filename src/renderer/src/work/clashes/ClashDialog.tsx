import { makeFunctionReference } from "convex/server";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { clashTitle, driveLine, timeNear, type Clash, type ClashAnswered, type ClashSide, type ClashWay } from "@shared/work/clashes";
import { addDays, startOfDay } from "work-kit/views/lib/agenda";
import { formatDayHeading } from "work-kit/views/lib/format";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { BusyLabel, Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { ConnectionLostError, registry, TimeoutError } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import type { MailtoDraft } from "work-kit/mail";
import { writeMail } from "../mail/mailto";
import { goTo } from "../today/open";
import { sectorName } from "../shell/actions";
import { useMinute } from "../tasks/minute";
import { sessionFailure, sessionWaits, useLifeosSession } from "../shell/lifeos";
import { useClashes } from "./mark";
import { doneWords, fieldOf, formOf, freeAfter, hintsOf, lateDraft, pairStamp, WAY_LABEL, wayWords, whenOf, type TimeForm } from "./model";
import type { ClashAsk } from "./open";
import { answered } from "./wait";

/**
 * The Clash dialog (docs/DESIGN.md "Clashes"): the two events in time order
 * with the drive between them, and under each the ways out it allows. A way
 * out swaps the body for its one step, which shows what goes before Send.
 * Decline, a proposed time and a move go as his own press through
 * `work.clashes.answer`; Running late opens Mail's composer, which holds its
 * own send; "This is fine" quiets the clash until a time or a place moves.
 */

type Side = "a" | "b";
/** A step is its event's, by id: the pair may swap order under it when one of the two moves. */
type Step = { eventId: string; way: Exclude<ClashWay, "late"> };
/** The same two events with the later first: a clash's id is the earlier event's then the later's (ids hold no hyphen), so it flips when their order does. */
const flipped = (id: string) => id.split("-").reverse().join("-");
const eventGet = makeFunctionReference<"query">("events:get");

/**
 * The draft in Mail's composer of the later event's job: the window enters that job's workspace first, as a
 * Today row's press does (today/open.ts `goTo`), and the draft is bound to that workspace's mailbox, so it is
 * never written into the Mail of the job he pressed from. Sending stays the composer's own press. False when
 * the workspace is not in this window's catalog.
 */
function lateMail(environmentId: string, workspaceId: string, draft: MailtoDraft): boolean {
  const workspace = workspaceStore.getSnapshot().workspaces.find((w) => w.id === workspaceId && w.environmentId === environmentId);
  if (!workspace) return false;
  goTo({ path: workspace.path, workspaceId }, { view: "mail" });
  writeMail(draft, workspaceId);
  return true;
}

export function ClashDialog({ ask, onClose }: { ask: ClashAsk; onClose: () => void }) {
  // The fortnight from the earlier event's day when the opener handed the clash over, else from today, as every opener reads.
  // Whole local days (a day is 23 or 25 hours when the clocks change). A fortnight, not the pair's own day or two: an event of the pair that moves to another day and still clashes must stay in the read, or the dialog would call the clash gone.
  const first = startOfDay(ask.clash ? ask.clash.a.startsAt : Date.now());
  // And through the later event's own day and the earlier one's last when those lie past the fortnight (a block of weeks, and something in its third): the read must hold the pair the opener showed, and the pair still, while the later one moves anywhere inside the block.
  const [from, to] = [first, Math.max(addDays(first, 14), ask.clash ? addDays(startOfDay(Math.max(ask.clash.b.startsAt, ask.clash.a.endsAt)), 1) : 0)];
  const marks = useClashes(ask.environmentId, from, to);
  // The pair in either order: when one of the two moves to start first and they still clash, it is the same clash under a flipped id.
  const live = [...marks.clashes.values()].flat().find((c) => c.id === ask.id || c.id === flipped(ask.id));
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
      {clash ? <Body clash={clash} environmentId={ask.environmentId} onClose={onClose} pending={pending} setPending={setPending} onSettled={() => setSettled(true)} onStep={setStepping} cleared={cleared} gone={gone} /> : <Empty state={state} error={marks.failed} onClose={onClose} />}
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
      <Foot onClose={onClose} landing={state === "gone"} />
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
      {/* A long title or place wraps, whole: a tip on a cut line is out of the keyboard's reach. */}
      <span className="break-words font-medium text-foreground">{side.title}</span>
      <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs leading-5 text-muted-foreground">
        <span className="shrink-0 tabular-nums">{span(side, day)}</span>
        {/* The dot's box is the dot, so it sits 8px from the time and 8px from its job's name. */}
        <span className="inline-flex min-w-0 items-center gap-2">
          <SectorDot sector={side.sector} className="size-2" />
          <span className="truncate">{sectorName(side.sector)}</span>
        </span>
      </span>
      {place ? <span className="break-words text-xs leading-5 text-muted-foreground">{place}</span> : null}
      {children}
    </div>
  );
}

function Foot({ onClose, start, busy, landing }: { onClose: () => void; start?: React.ReactNode; busy?: boolean; /** Close takes the focus when it has nowhere of its own: the control that held it went with the clash */ landing?: boolean }) {
  const close = useModalClose();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!landing) return;
    const dialog = button.current?.closest("[role=dialog]");
    const active = document.activeElement;
    // Only then: on the page, or on the dialog's own box. A control he is on keeps it.
    if (!dialog || active === dialog || !dialog.contains(active)) button.current?.focus();
  }, [landing]);
  return (
    <DialogFooter start={start}>
      <Button ref={button} data-dialog-cancel variant="secondary" disabled={busy} onClick={() => (close ? close(onClose) : onClose())}>
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
  gone,
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
  /** the live read says the two no longer clash, though the dialog may still show them while a press of his is out */
  gone: boolean;
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
  // The last Send got no answer from the host, which may have handed the act on all the same: the step sends no second one.
  const [lost, setLost] = useState(false);
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
  // The pair as the last render had it, for a press whose answer comes later.
  const latest = useRef(clash);
  latest.current = clash;
  const left = useRef(gone);
  left.current = gone;
  // Back puts focus where the step was opened from, so the keyboard never loses its place.
  const from = useRef<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step || !from.current) return;
    // The way he came from, or the foot's Close when that way is gone (its event ended while the step was open).
    const close = body.current?.closest("[role=dialog]")?.querySelector<HTMLElement>("[data-dialog-cancel]");
    (body.current?.querySelector<HTMLElement>(`[data-way="${from.current}"]`) ?? close)?.focus();
    from.current = null;
  }, [step]);

  const fine = () => {
    setError(null);
    setPending(true);
    setBusy("fine");
    // The pair as he sees it goes with the press: LifeOS refuses when a calendar changed it a moment before, and the dialog then shows the pair as it is.
    const seen = [clash.a, clash.b].map(({ eventId, startsAt, endsAt, location }) => ({ eventId, startsAt, endsAt, ...(location !== undefined ? { location } : {}) }));
    link.request("work.clashes.waive", { id: clash.id, on: true, seen }, { lane: "ui" }).then(
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
    // The pair's times and drive, and the later event's job and workspace: the draft is for these, in that job's Mail.
    const stampOf = (c: Clash) => `${pairStamp(c)}|${c.b.eventId}|${c.b.sector}|${c.b.workspaceId ?? ""}`;
    const pressed = stampOf(clash);
    answered(session.client.query(eventGet, { id: clash.b.eventId })).then(
      (event: { sector?: string; startsAt?: number; endsAt?: number; attendees?: { address: string }[] } | null) => {
        setPending(false);
        // The reply may know of a change the screen has not drawn yet: the event's job and times are read from it too, so a move the live read has yet to bring drafts no old minutes.
        const b = latest.current.b;
        if ((event?.sector !== undefined && event.sector !== clash.b.sector) || (event?.startsAt !== undefined && event.startsAt !== b.startsAt) || (event?.endsAt !== undefined && event.endsAt !== b.endsAt)) return setBusy(null);
        // The pair changed while the people were read (its times, its drive, or the later event's job), or stopped being a clash: the minutes he pressed for are no longer the minutes, or the Mail no longer the job's. The dialog shows the pair as it is, or that it is gone, and the press is his again.
        // Nor is a line drafted for an event that ended in the wait: its Running late is gone from the dialog by then.
        if (left.current || latest.current.b.endsAt <= Date.now() || stampOf(latest.current) !== pressed) return setBusy(null);
        const to = (event?.attendees ?? []).map((a) => a.address).filter((a) => a.includes("@"));
        if (!to.length) return failed(null, "Nobody on this event has an address");
        if (!lateMail(environmentId, workspaceId, lateDraft(latest.current, to, Date.now()))) return failed(null, "This job's workspace is not on this host");
        close ? close(onClose) : onClose();
      },
      (err: unknown) => failed(err, "LifeOS did not answer"),
    );
  };

  if (step) {
    const side: Side = clash.a.eventId === step.eventId ? "a" : "b";
    return (
      <StepForm
        clash={clash}
        step={{ side, way: step.way }}
        pending={pending}
        refused={refused}
        cleared={cleared}
        lost={lost}
        onBack={() => {
          from.current = `${side}:${step.way}`;
          setRefused(null);
          setLost(false);
          setStep(null);
        }}
        onSend={(params) => {
          setRefused(null);
          setPending(true);
          // A time goes with the pair it was offered from (the step holds Send once the pair on screen changes): the host reads both again and refuses a pair a calendar changed that has not reached the window yet.
          const seen = params.start !== undefined ? { seen: [clash.a, clash.b].map(({ eventId, startsAt, endsAt }) => ({ eventId, startsAt, endsAt })) } : {};
          link.request("work.clashes.answer", { eventId: step.eventId, way: step.way, ...params, ...seen }, { lane: "ui" }).then(
            (reply: unknown) => {
              done(doneWords(step.way, clash[side].title, (reply as ClashAnswered | null)?.queued ?? true));
            },
            (err: unknown) => {
              setPending(false);
              // A request that never left ("not connected") sent nothing. One that left and got no answer may have been queued by the host: a second press could send the act twice.
              if (err instanceof TimeoutError || (err instanceof ConnectionLostError && err.message !== "not connected")) {
                setLost(true);
                return setRefused("The host did not confirm the send. Check the calendar before trying again.");
              }
              setRefused(refusalWords(err) || "LifeOS refused it");
            },
          );
        }}
      />
    );
  }

  return <Events clash={clash} pending={pending} busy={busy} error={error} onClose={onClose} onFine={fine} onWay={(side, way) => (setError(null), way === "late" ? late() : setStep({ eventId: clash[side].eventId, way }))} bodyRef={body} />;
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
  const now = useMinute();
  const ways = (side: Side) => {
    const event = clash[side];
    // An event that is over allows none: a decline of a game he has just refereed helps no one. Running late is the later event's, which is not over while its clash shows.
    if (event.endsAt <= now) return null;
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
  lost = false,
  onBack,
  onSend,
}: {
  clash: Clash;
  step: { side: Side; way: Step["way"] };
  pending: boolean;
  /** what LifeOS said of the last Send, in its own words */
  refused?: string | null;
  /** the two no longer clash: what he typed stays to read or copy, and nothing more can be sent */
  cleared?: boolean;
  /** the last Send left and got no answer: it may have gone, so Send is off; Back gives the step afresh once he has looked */
  lost?: boolean;
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
  // The offer was worked out from the pair as it was when the step opened. If either event's time or the drive has changed since, a time he has not looked at again may clash anew: the step holds Send and points back, where a fresh offer is made.
  const [opened] = useState(() => pairStamp(clash));
  // Never under his own press: a move that goes through changes the pair, and the step is closing on what he sent.
  const stale = timed && !cleared && !pending && pairStamp(clash) !== opened;
  // The event ended while the step was open: as in the list, an event that is over has no way out.
  const now = useMinute();
  const over = !cleared && !pending && event.endsAt <= now;
  // "Nothing was sent." is said only when that is known: after a Send of his that got no answer, the clash may be gone because the act went.
  const held = cleared && !lost ? "Nothing was sent." : over ? "This event is over." : stale ? "These events changed. Go back for a new time." : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    // Asked of the clock again at the press, since the minute's tick may be behind it.
    if (held || lost || event.endsAt <= Date.now()) return;
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
          <span className={cn("col-start-1 row-start-1", held && "invisible")}>{wayWords(step.way, event.guests)}</span>
          {held ? <span className="col-start-1 row-start-1">{held}</span> : null}
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
      <DialogFooter confirmLabel={step.way === "move" ? "Move" : "Send"} pending={pending} disabled={held !== null || lost}>
        <Button data-clash-back variant="secondary" disabled={pending} onClick={onBack}>
          Back
        </Button>
      </DialogFooter>
    </form>
  );
}
