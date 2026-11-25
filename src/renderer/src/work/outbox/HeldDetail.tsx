import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import { Textarea } from "../../components/ui/textarea";
import { loadToast } from "../../components/ui/toaster";
import { Tip } from "../../components/tip";
import { ChevronDown, Clock, Pencil, Plug, SquareMousePointer } from "../../chrome/icons";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody } from "../../chrome/Modal";
import { cn } from "../../lib/cn";
import { keyHint, modKey } from "../../lib/keys";
import { shortcutFor } from "../../lib/settings";
import { useLinkMay } from "../../lib/linkMay";
import { nameInLine } from "../../lib/hostWords";
import { storeTitleOf } from "../../lib/threadMentions";
import { workErrorWords } from "../../lib/workErrorWords";
import { Facts } from "../../surfaces/settings/hosts/Facts";
import { ActView } from "../acts/ActView";
import { kindHeading } from "../acts/kindRows";
import { Chat } from "../icons";
import { ownZone, scheduleLine } from "work-kit/mail/lib/zones";
import { itemFailWords, pressFailWords } from "./failWords";
import { applyEdits, grantFor, lifeosWords, offerLine, pastOf, payloadView, timeOf } from "./model";
import { canEdit, changeKind, checkWords, DetailColumn, itemTitle, KeptPicture, pictureShown, pressable, splitSummary, usePicture, VerbBar } from "./parts";
import { undoResult } from "./results";
import {
  askAgain,
  cancelScheduled,
  decideMany,
  discardItem,
  editItem,
  fetchItem,
  grantAndSend,
  mayUndoSend,
  notSentWords,
  offerAfterPress,
  resultOf,
  sendItem,
  sendNow,
  undoSend,
  wentOut,
  type HostItem,
  type HostOffer,
  type PressVia,
} from "./store";
import { aheadTime, changesOf, isScheduled, laterChoices, type Piece } from "./waiting";
import { heldWhen } from "./when";
import { unreadDown, useMailUnread } from "./MailUnread";
import { useLifeosStatusHeard } from "../shell/lifeos";

/**
 * A held item whole, with its verbs (docs/DESIGN.md "The Outbox"): what the
 * Outbox shows beside its list, and what Today shows in a sheet over its page
 * (work/today/HeldSheet.tsx), so there is one Send and one rule for it. The
 * facts line, the act as the title, one sentence of what the press does, the
 * notes that apply, then the thing exactly as it will arrive; Edit turns it
 * into fields where it stands. It fills a flex column: the thing scrolls, the
 * verb bar stays at the foot.
 */

const toast = (line: string) => void loadToast().then((t) => t(line));
const toastError = (line: string) => void loadToast().then((t) => t.error(line));
const toastUndo = (line: string, undo: () => void) => void loadToast().then((t) => t(line, { action: { label: "Undo", onClick: undo } }));
/** What a press says when it completed a run: the line of the grant it earned, with Review, which opens the item in Done. */
const toastEarned = (line: string, offer: HostOffer, review: () => void) =>
  void loadToast().then((t) => t(line, { description: offerLine(offer), action: { label: "Review", onClick: review } }));

/** The verbs a key reaches on the page (OutboxView's keys): each is a no-op where its button is not on screen. */
export type DetailCommands = { primary(): void; edit(): void; discard(): void; later(): void; editing(): boolean; cancelEdit(): void };

type OpenSession = (sessionId: string, environmentId: string) => void;

/** Hands the page the verbs a detail has on screen, after each commit; takes them back when the detail goes. */
export function useKeyVerbs(commands: RefObject<DetailCommands | null> | undefined, verbs: DetailCommands): void {
  const latest = useRef(verbs);
  useLayoutEffect(() => {
    latest.current = verbs;
  });
  useLayoutEffect(() => {
    if (!commands) return;
    const mine: DetailCommands = {
      primary: () => latest.current.primary(),
      edit: () => latest.current.edit(),
      discard: () => latest.current.discard(),
      later: () => latest.current.later(),
      editing: () => latest.current.editing(),
      cancelEdit: () => latest.current.cancelEdit(),
    };
    commands.current = mine;
    return () => {
      if (commands.current === mine) commands.current = null;
    };
  }, [commands]);
}

/** The thread an item came from, as its facts line says it: "from Nationals roster", "from the routine Morning sweep". */
export function fromWords(item: Pick<HostItem, "sessionId" | "routineRunId">): { lead: string; title: string } | null {
  const title = item.sessionId ? storeTitleOf(item.sessionId) : null;
  return title ? { lead: item.routineRunId ? "from the routine" : "from", title } : null;
}

/** Where, from what and when, over the act's name: the job's dot and name lead at every width. */
export function DetailFacts({ item, job, when, onOpenSession, extra }: { item: HostItem; job: string; when: string; onOpenSession?: OpenSession; extra?: ReactNode }) {
  const from = fromWords(item);
  const link =
    from && item.sessionId && onOpenSession ? (
      <span>
        {from.lead}{" "}
        <button
          type="button"
          data-outbox-thread
          className="focus-ring rounded-sm underline decoration-current/40 underline-offset-3 hover:text-foreground"
          onClick={() => onOpenSession(item.sessionId!, item.environmentId)}
        >
          {from.title}
        </button>
      </span>
    ) : from ? (
      `${from.lead} ${from.title}`
    ) : null;
  return (
    <div className="flex min-h-7 items-center gap-1 text-xs text-muted-foreground">
      <SectorDot sector={item.sector} className="-ms-1 size-4 shrink-0" />
      <Facts parts={[job, link, when, extra]} className="min-w-0" />
    </div>
  );
}

/**
 * A LifeOS mail is read whole before it may go: the list leaves out the quote LifeOS sends under a reply, and his
 * press approves what he read (the hold review's finding 28). Every other kind is read whole too, for what only `get`
 * says (the thread's first words for Show changes, a reply that came in), but its Send never waits on that read.
 */
function useWhole(item: HostItem): { shown: HostItem; ready: boolean; failed: boolean; error: unknown; retry(): void } {
  const gate = item.kind === "mail.send";
  const key = JSON.stringify([item.environmentId, item.ref, item.updatedAt]);
  const [read, setRead] = useState<{ key: string; item: HostItem | null; error?: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setRead(null);
    fetchItem(item.environmentId, item.ref).then(
      (whole) => live && setRead({ key, item: { ...item, ...whole, environmentId: item.environmentId } as HostItem }),
      (error: unknown) => live && setRead({ key, item: null, error }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again for another item, a change, or a Retry
  }, [key, attempt]);
  const mine = read?.key === key ? read : null;
  const failed = gate && !!mine && !mine.item;
  // A mail's read its host's LifeOS failed is read again once that host says LifeOS is back (the note goes by itself).
  const status = useLifeosStatusHeard(gate ? item.environmentId : null);
  useEffect(() => {
    if (failed && status?.lifeos.state === "connected") setAttempt((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a fresh answer of the host, not the failure itself
  }, [status]);
  // A kind whose read failed still shows as listed: only a mail's Send waits on it.
  return { shown: mine?.item ?? item, ready: gate ? !!mine?.item : true, failed, error: mine?.error, retry: () => setAttempt((n) => n + 1) };
}

/** A note under the sentence: one line, its 14px glyph in the column the title's text starts on. */
function Note({ glyph, children, alert = false, noteRef }: { glyph: ReactNode; children: ReactNode; alert?: boolean; noteRef?: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={noteRef} role={alert ? "alert" : undefined} data-outbox-note className="flex max-w-[60ch] items-start gap-2 text-[13px] leading-5 text-muted-foreground">
      <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">{glyph}</span>
      <span className={cn("min-w-0 flex-1", alert && "text-foreground")}>{children}</span>
    </div>
  );
}

/** "The thread rewrote this at 9:20 AM." / "You changed this at 9:20 AM." */
export const changedWords = (changed: NonNullable<HostItem["changed"]>, now = Date.now()): string =>
  `${changed.by === "thread" ? "The thread rewrote this" : "You changed this"} at ${heldWhen(changed.at, now)}.`;

/** "Dana Lee wrote back at 8:12 AM, after this was made: "Can we move it to 3?"" */
export const repliedWords = (replied: NonNullable<HostItem["replied"]>, now = Date.now()): string =>
  `${replied.from} wrote back at ${heldWhen(replied.at, now)}, after this was made: "${replied.line}"`;

/** What differs from the thread's first words: each field that moved, then the body's words in and out. */
function Changes({ first, now }: { first: unknown; now: unknown }) {
  const { fields, body } = useMemo(() => changesOf(first, now), [first, now]);
  if (!fields.length && !body) return <p className="text-[13px] leading-5 text-muted-foreground">Nothing you read differs.</p>;
  return (
    <div data-outbox-changes className="flex flex-col gap-2 text-[13px] leading-5">
      {fields.map((f) => (
        <div key={f.label} className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3">
          <span className="text-muted-foreground">{f.label}</span>
          <span className="min-w-0 break-words">
            {f.was ? <del className="text-muted-foreground">{f.was}</del> : null}
            {f.was && f.now ? " " : null}
            {f.now ? <ins className="no-underline">{f.now}</ins> : null}
          </span>
        </div>
      ))}
      {body ? <Words pieces={body} /> : null}
    </div>
  );
}

/** A body's difference: what both hold in plain words, what was taken out muted and struck, what came in tinted. */
function Words({ pieces }: { pieces: readonly Piece[] }) {
  return (
    <p className="max-w-[66ch] whitespace-pre-wrap break-words text-sm leading-[22px]">
      {pieces.map((p, i) =>
        p.t === "same" ? (
          <span key={i}>{p.s}</span>
        ) : p.t === "del" ? (
          <del key={i} className="text-muted-foreground">
            {p.s}
          </del>
        ) : (
          <ins key={i} className="rounded-[3px] bg-accent/18 no-underline">
            {p.s}
          </ins>
        ),
      )}
    </p>
  );
}

/**
 * The notes that apply, one line each, in order: not sent (or a refused press), out of date, rewritten (with Show
 * changes), a reply that came in, the time it goes, a computer act's screen, a mail that did not load.
 */
export function ItemNotes({ item, host, refused, unread, unreadError, onRetry, showChanges, onShowChanges, noteRef }: {
  item: HostItem;
  host?: string;
  refused?: string | null;
  unread?: boolean;
  /** why the mail's read failed: its cause is said by the LifeOS rule (`useMailUnread`) */
  unreadError?: unknown;
  onRetry?: () => void;
  showChanges?: boolean;
  onShowChanges?: (on: boolean) => void;
  noteRef?: RefObject<HTMLDivElement | null>;
}) {
  const hostInLine = host && host !== "A host" ? nameInLine(host) : undefined;
  const first = item.changed?.first;
  const said = useMailUnread(unreadError, !!unread, item.environmentId, onRetry ?? (() => {}));
  const notes: ReactNode[] = [];
  if (refused || item.state === "failed")
    notes.push(
      <Note key="failed" alert glyph={<StatusMark state="failed" word={false} />} noteRef={noteRef}>
        {refused ?? `Not sent. ${itemFailWords(item, hostInLine)}`}
      </Note>,
    );
  if (item.state === "stale")
    notes.push(
      <Note key="stale" glyph={<Clock className="size-3.5" />}>
        Out of date. {workErrorWords(item.error ?? "") || "It changed after it was made."}
      </Note>,
    );
  if (item.changed && item.state !== "stale")
    notes.push(
      <div key="changed" className="flex flex-col gap-3">
        <Note glyph={<Pencil className="size-3.5" />}>
          {changedWords(item.changed)}
          {first !== undefined && onShowChanges ? (
            <Button variant="ghost" size="xs" className="-my-0.5 ms-1 align-baseline" aria-expanded={showChanges} onClick={() => onShowChanges(!showChanges)}>
              {showChanges ? "Hide changes" : "Show changes"}
            </Button>
          ) : null}
        </Note>
        {showChanges && first !== undefined ? (
          <div className="ps-[22px]">
            <Changes first={first} now={item.payload} />
          </div>
        ) : null}
      </div>,
    );
  if (item.replied)
    notes.push(
      <Note key="replied" glyph={<Chat className="size-3.5" />}>
        {repliedWords(item.replied)}
      </Note>,
    );
  if (item.kind === "computer.act")
    notes.push(
      <Note key="screen" glyph={<SquareMousePointer className="size-3.5" />}>
        Takes {host ?? "the computer"}'s screen for a moment.
      </Note>,
    );
  if (said)
    notes.push(
      <Note key="unread" alert={said.red} glyph={said.red ? <StatusMark state="failed" word={false} /> : <Plug className="size-3.5" />}>
        <span data-mail-unread={said.cause ?? "failed"}>
          {said.words}
          {said.action ? (
            <Button variant="ghost" size="xs" className="-my-0.5 ms-1" onClick={said.action.run}>
              {said.action.label}
            </Button>
          ) : null}
          {said.elsewhere ? <span className="block">{said.elsewhere}</span> : null}
        </span>
        {said.dialog}
      </Note>,
    );
  return notes.length ? <div className="mt-3 flex flex-col gap-2">{notes}</div> : null;
}

/** One sentence of what the press does, from the host (`effect`); none for an item that went out of date. */
export function Effect({ item, compact = false }: { item: Pick<HostItem, "effect" | "state" | "kind" | "scheduledFor" | "scheduledZone">; compact?: boolean }) {
  const words = effectWords(item);
  if (!words) return null;
  return <p className={cn("max-w-[60ch] text-pretty tabular-nums", compact ? "text-[13px] leading-5 text-muted-foreground" : "mt-2 text-sm leading-[22px]")}>{words}</p>;
}

/** The kinds whose view draws From and To: their sentence leaves those out and says what the fields cannot. */
const FIELDS_SHOW_WHO = new Set<string>(["mail.send", "office.mail.send"]);

/**
 * The one sentence of what the press does, saying only what the thing below does not: a mail's From and To are in
 * its fields, so "Goes from landon@purdue.edu to Dana Lee after your 30-second undo." reads "Goes after your 30-second
 * undo."; a send he timed says when it goes, once ("Goes Wed 8:00 AM"); an item out of date says nothing.
 */
export function effectWords(item: Pick<HostItem, "effect" | "state" | "kind" | "scheduledFor" | "scheduledZone">): string | null {
  if (isScheduled(item) && item.scheduledFor != null) return `Goes ${scheduleLine(item.scheduledFor, ownZone(), item.scheduledZone)}`;
  if (!item.effect || item.state === "stale") return null;
  if (FIELDS_SHOW_WHO.has(item.kind)) {
    const said = /^Goes from \S+ to .+? (after .+)$/.exec(item.effect);
    if (said) return `Goes ${said[1]}`;
  }
  return item.effect;
}

/**
 * An item opened in place (the summary list's chevron, a thread's request): its sentence, its notes and the thing,
 * with no head and no border around it.
 */
export function ItemInPlace({ item: listed, host }: { item: HostItem; host?: string }) {
  const { shown: item } = useWhole(listed);
  return (
    <div className="flex flex-col">
      <Effect item={item} compact />
      <ItemNotes item={item} host={host} />
      <div className="mt-3">
        <ActView item={item} env={item.environmentId} />
      </div>
    </div>
  );
}

const FIELD_ORDER = ["account", "from", "to", "cc", "bcc", "subject", "channel"];

/** Fields and body as inputs where they stand, on the payload views' own 72px label column. */
function EditInPlace({ item, values, onChange }: { item: HostItem; values: ReadonlyMap<string, string>; onChange: (key: string, value: string) => void }) {
  // In the order the thing reads: who it is from, to whom, then the rest.
  const view = useMemo(() => {
    const v = payloadView(item.payload);
    const rank = (key: string) => FIELD_ORDER.indexOf(key) + 1 || FIELD_ORDER.length + 1;
    return { ...v, fields: [...v.fields].sort((a, b) => rank(a.key) - rank(b.key)) };
  }, [item.payload]);
  const id = useId();
  return (
    <div data-outbox-editing className="flex min-w-0 flex-col gap-4">
      {view.fields.length ? (
        <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-[13px] leading-5">
          {view.fields.map((field) => {
            const key = field.path.join(".");
            return (
              <div key={key} className="contents">
                <label htmlFor={`${id}-${key}`} className="truncate text-muted-foreground">
                  {field.label}
                </label>
                {field.edit ? (
                  <Input id={`${id}-${key}`} value={values.get(key) ?? field.value} onChange={(e) => onChange(key, e.target.value)} spellCheck={field.edit === "text"} className="h-7" />
                ) : (
                  <span id={`${id}-${key}`} className="min-w-0 break-words">
                    {field.value}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      {view.body && !view.body.readOnly ? (
        <Textarea
          aria-label="Message"
          rows={10}
          value={values.get(view.body.path.join(".")) ?? view.body.text}
          onChange={(e) => onChange(view.body!.path.join("."), e.target.value)}
          className="min-h-48 text-sm leading-[22px]"
        />
      ) : view.body ? (
        <div className="whitespace-pre-wrap break-words border-t border-border pt-4 text-sm leading-[22px]">{view.body.text}</div>
      ) : null}
    </div>
  );
}

/** Pick a time…: a day and a time in his zone, the line under them saying when it goes. */
export function PickTime({ onPick, onClose }: { onPick: (at: number) => void; onClose: () => void }) {
  const morning = laterChoices().at(-1)!.at;
  const pad = (n: number) => String(n).padStart(2, "0");
  const d0 = new Date(morning);
  const [day, setDay] = useState(`${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}`);
  const [time, setTime] = useState("08:00");
  const at = new Date(`${day}T${time}`).getTime();
  const open = Number.isFinite(at) && at > Date.now();
  return (
    <Modal onClose={onClose} title="Send later" size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (open) onPick(at);
        }}
      >
        <ModalBody>
          <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-2">
            <Field label="Day">
              <Input type="date" autoFocus value={day} onChange={(e) => setDay(e.target.value)} className="tabular-nums" />
            </Field>
            <Field label="Time">
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="tabular-nums" />
            </Field>
          </div>
          <p aria-live="polite" className="min-h-4 text-xs tabular-nums text-muted-foreground">
            {open ? scheduleLine(at, ownZone()) : "That time has passed"}
          </p>
        </ModalBody>
        <DialogFooter onCancel={onClose} confirmLabel="Send later" disabled={!open} />
      </form>
    </Modal>
  );
}

/**
 * Discard, with one optional line for the thread. A popover over its button; ⌘↩ in the field discards. Its button
 * is the start of the bar. `count` > 1 reads "Discard 3" (the summary list's).
 */
export function DiscardButton({ busy, disabled, open, instant = false, onOpenChange, onDiscard, label = "Discard" }: {
  busy: boolean;
  disabled: boolean;
  open: boolean;
  /** opened by a key: no motion */
  instant?: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscard: (reason: string) => void;
  label?: string;
}) {
  const [reason, setReason] = useState("");
  const go = () => {
    onOpenChange(false);
    onDiscard(reason);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tip label={label} shortcut={shortcutFor("Work", "Discard Held Item")}>
        <PopoverTrigger render={<Button variant="ghost" size="sm" disabled={disabled} />}>
          <BusyLabel busy={busy} label={label} />
        </PopoverTrigger>
      </Tip>
      <PopoverContent side="top" align="start" className={cn("w-80", instant && "transition-none")}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <Textarea
            autoFocus
            aria-label="Why, for the thread"
            placeholder="Why, for the thread"
            maxLength={500}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && modKey(e.nativeEvent)) {
                e.preventDefault();
                go();
              }
            }}
            className="min-h-18 text-[13px] leading-5"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="secondary" size="sm">
              {label}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The primary verb joined to its menu: Send later's times (kinds that may be sent later), then the grant ("Send and
 * stop holding › Mail to Dana Lee") where the key may make one. No menu when neither applies.
 */
export function SendSplit({ label, busy, disabled, later, grant, verb, open, instant = false, onOpenChange, onPress, onLater, onPickTime, onGrant, tip }: {
  label: string;
  busy: boolean;
  disabled: boolean;
  later: boolean;
  grant: { label: string } | null;
  verb: string;
  open: boolean;
  /** opened by a key: no motion */
  instant?: boolean;
  onOpenChange: (open: boolean) => void;
  onPress: () => void;
  onLater: (at: number) => void;
  onPickTime: () => void;
  onGrant?: () => void;
  tip?: string;
}) {
  const menu = later || grant !== null;
  const choices = later && open ? laterChoices() : [];
  return (
    <span className="flex items-center">
      <Tip label={tip ?? label} shortcut={keyHint("mod+enter")}>
        <Button size="sm" disabled={disabled} className={cn(menu && "rounded-e-none")} onClick={onPress}>
          <BusyLabel busy={busy} label={label} />
        </Button>
      </Tip>
      {menu ? (
        <DropdownMenu open={open} onOpenChange={onOpenChange}>
          <DropdownMenuTrigger render={<Button size="icon-sm" disabled={disabled} aria-label={`More ways to ${verb.toLowerCase()}`} className="rounded-s-none border-s border-primary-foreground/15" />}>
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className={cn("min-w-56", instant && "transition-none")}>
            {later ? (
              <DropdownMenuGroup>
                <DropdownMenuLabel>{verb} later</DropdownMenuLabel>
                {choices.map((c) => (
                  <DropdownMenuItem key={c.label} onClick={() => onLater(c.at)}>
                    {c.label}
                    <DropdownMenuShortcut className="tabular-nums">{aheadTime(c.at)}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem onClick={onPickTime}>Pick a time…</DropdownMenuItem>
              </DropdownMenuGroup>
            ) : null}
            {later && grant ? <DropdownMenuSeparator /> : null}
            {grant ? (
              <DropdownMenuGroup>
                <DropdownMenuLabel>{verb} and stop holding</DropdownMenuLabel>
                <DropdownMenuItem onClick={onGrant}>{grant.label}</DropdownMenuItem>
              </DropdownMenuGroup>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </span>
  );
}

type Busy = "send" | "discard" | "grant" | "later" | "again" | "cancel" | "now" | "save" | null;

export function HeldDetail({
  item: listed,
  workspace,
  host,
  alone = false,
  via = alone ? "today" : "outbox",
  onOpenSession,
  onPressed,
  onReview,
  commands,
}: {
  item: HostItem;
  workspace: string;
  host: string;
  /** In Today's sheet: the time is said as the row that opened it says it, and a refusal in the detail itself. */
  alone?: boolean;
  via?: PressVia;
  onOpenSession?: OpenSession;
  onPressed: (item: HostItem) => void;
  onReview: (item: HostItem) => void;
  /** Filled with the verbs the page's keys reach. */
  commands?: RefObject<DetailCommands | null>;
}) {
  const { shown: item, ready: read, failed: unread, error: unreadError, retry } = useWhole(listed);
  const hostInLine = host && host !== "A host" ? nameInLine(host) : undefined;
  const picture = usePicture(listed);
  // Send waits until all he approves is on screen: the act's own view loaded, the mail read whole, the act's kept
  // picture drawn (the hold review). The act's own view says when its payload is on screen.
  const [viewLoaded, setViewLoaded] = useState(false);
  const ready = read && pictureShown(picture) && viewLoaded;
  const [busy, setBusy] = useState<Busy>(null);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Map<string, string>>(() => new Map());
  const [editError, setEditError] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // A popover or menu a key opened shows at once: nothing moves on a key.
  const [byKey, setByKey] = useState(false);
  const openByKey = (which: "discard" | "later") => {
    setByKey(true);
    if (which === "discard") setDiscardOpen(true);
    else setMenuOpen(true);
  };
  const [picking, setPicking] = useState(false);
  // Alone in a sheet, a press that did not go through is said in the detail itself: a sheet lies over the toasts.
  const [refused, setRefused] = useState<string | null>(null);
  const sayFailed = (line: string): void => (alone ? setRefused(line) : toastError(line));
  const refusedLine = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (refused) refusedLine.current?.scrollIntoView?.({ block: "nearest" });
  }, [refused]);
  // A grant is made on the host's admin rule: a key that may only approve sends is never offered "stop holding".
  const grant = useLinkMay(item.environmentId, "work.outbox.grant") ? grantFor(item) : null;
  const mayTakeOffer = useLinkMay(item.environmentId, "work.outbox.takeOffer");
  const { about } = splitSummary(item.summary);
  const waiting = pressable(item);
  const stale = item.state === "stale";
  const timed = isScheduled(item);
  const later = item.later === true && waiting && !item.outcomeUnknown;
  const verbAgain = changeKind(item.kind) ? "Try again" : `${item.verb} again`;

  const run = async (which: Exclude<Busy, null>, work: () => Promise<void>, fail: string) => {
    setBusy(which);
    setRefused(null);
    try {
      await work();
    } catch (err) {
      sayFailed(pressFailWords(err, fail, hostInLine));
    } finally {
      setBusy(null);
    }
  };

  const send = (which: "send" | "again" | "grant") =>
    run(
      which,
      async () => {
        const after = which === "grant" ? await grantAndSend(item, grant!) : await sendItem(item, { again: which === "again", via });
        if (!wentOut(after)) return void sayFailed(notSentWords(after));
        onPressed(item);
        // A held file change names its file ("Changed Brief.docx"); one LifeOS took and holds queued says so, as its row does.
        const queued = lifeosWords(after);
        const done = queued ? `${queued.word}${about ? `: ${about}` : ""}` : ((changeKind(item.kind) ? kindHeading(item.kind, item.payload, true) : null) ?? `${pastOf(item.verb, item.kind)}${about ? `: ${about}` : ""}`);
        const earned = mayTakeOffer && which !== "grant" ? await offerAfterPress(item) : null;
        if (earned) return void toastEarned(done, earned, () => onReview(item));
        if (which === "grant") {
          toast(done);
          return void toast(`Grant made: ${grant!.label}`);
        }
        // Where the act allows it, the toast takes it back: a LifeOS mail while LifeOS still holds it, a kind whose Result keeps a way back.
        if (mayUndoSend(item, after))
          return void toastUndo(done, () =>
            void undoSend(item).then(
              (back) => toast(back ? "Back in Waiting" : "It already went"),
              (err) => toastError(pressFailWords(err, "It was not taken back")),
            ),
          );
        const result = await resultOf(item);
        if (result?.undo)
          return void toastUndo(done, () =>
            void undoResult(result).then(
              () => toast(`${result.undo?.label ?? "Undone"}${about ? `: ${about}` : ""}`),
              (err) => toastError(pressFailWords(err, "It was not taken back")),
            ),
          );
        toast(done);
      },
      "It couldn't be sent",
    );

  const discard = (reason: string) =>
    run(
      "discard",
      async () => {
        await discardItem(item, { reason, via });
        onPressed(item);
        toast("Discarded");
      },
      "It was not discarded",
    );

  const sendLater = (at: number) =>
    run(
      "later",
      async () => {
        const [result] = [...(await decideMany([item], { do: "later", at, zone: ownZone() }, { via })).values()];
        if (!result?.ok) return void sayFailed(workErrorWords(result?.error ?? "") || "It was not scheduled");
        onPressed(item);
        toast(`Goes ${scheduleLine(at, ownZone())}`);
      },
      "It was not scheduled",
    );

  const again = () =>
    run(
      "again",
      async () => {
        await askAgain(item);
        onPressed(item);
        toast("Asked the thread again");
      },
      "The thread was not asked",
    );

  const cancel = () =>
    run(
      "cancel",
      async () => {
        const back = await cancelScheduled(item);
        toast(back ? (item.state === "scheduled" ? "Back in Waiting" : "Back in drafts") : "Already sent");
      },
      "The send was not cancelled",
    );

  const now = () =>
    run(
      "now",
      async () => {
        const after = await sendNow(item);
        if (!wentOut(after)) return void sayFailed(notSentWords(after));
        onPressed(item);
        toast(lifeosWords(after)?.word ?? `${pastOf(item.verb, item.kind)}${about ? `: ${about}` : ""}`);
      },
      "It couldn't be sent",
    );

  const save = () => {
    const next = applyEdits(item.payload, edits);
    if (next.error) return setEditError(next.error);
    void run(
      "save",
      async () => {
        await editItem(item, next.payload);
        setEditing(false);
        setEdits(new Map());
        setEditError(null);
      },
      "The change was not saved",
    );
  };
  const cancelEdit = () => {
    setEditing(false);
    setEdits(new Map());
    setEditError(null);
  };

  const sendOff = !waiting || !ready || busy !== null;
  const editable = waiting && canEdit(item);
  const verbs: DetailCommands = {
      primary: () => {
        if (editing) return save();
        if (stale) return void (busy === null && again());
        if (timed) return;
        if (!sendOff) void send(item.outcomeUnknown ? "again" : "send");
      },
      edit: () => editable && !editing && busy === null && setEditing(true),
      discard: () => {
        if ((waiting || stale) && !timed && !editing && busy === null) openByKey("discard");
      },
      later: () => {
        if (later && !editing && !sendOff) openByKey("later");
      },
      editing: () => editing,
      cancelEdit,
  };
  // The keys reach exactly the buttons on screen: set after each commit, let go when the detail goes.
  useKeyVerbs(commands, verbs);

  return (
    <>
      <DetailColumn>
        <header className="flex flex-col">
          <DetailFacts item={item} job={workspace} when={alone ? heldWhen(item.createdAt) : timeOf(item.createdAt)} onOpenSession={onOpenSession} />
          <h1 className="mt-1 text-base font-semibold leading-6 tracking-[-0.01em] text-balance">{itemTitle(item, false)}</h1>
        </header>
        <Effect item={item} />
        <ItemNotes item={item} host={host} refused={refused} unread={unread} unreadError={unreadError} onRetry={retry} showChanges={showChanges} onShowChanges={setShowChanges} noteRef={refusedLine} />
        <div
          className="mt-5 flex flex-col gap-4"
          onKeyDown={(e) => {
            if (editing && e.key.toLowerCase() === "s" && modKey(e.nativeEvent)) {
              e.preventDefault();
              save();
            }
          }}
        >
          {editing ? (
            <>
              <EditInPlace item={item} values={edits} onChange={(key, value) => setEdits((prev) => new Map(prev).set(key, value))} />
              <ErrorLine error={editError} />
            </>
          ) : (
            <ActView item={item} env={item.environmentId} onReady={setViewLoaded} />
          )}
          {/* While the mail is read whole, a bone where its quote may land: Send waits on it. */}
          {item.kind === "mail.send" && !read && (!unread || unreadDown(unreadError) === "wait") ? <Skeleton data-mail-quote-bone className="h-4 w-2/3 rounded" /> : null}
          {item.kind === "computer.act" ? <KeptPicture item={item} picture={picture} /> : null}
        </div>
      </DetailColumn>
      {editing ? (
        <VerbBar>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={cancelEdit}>
            Cancel
          </Button>
          <Tip label="Save" shortcut={keyHint("mod+S")}>
            <Button size="sm" disabled={busy !== null || edits.size === 0} onClick={save}>
              <BusyLabel busy={busy === "save"} label="Save" />
            </Button>
          </Tip>
        </VerbBar>
      ) : timed ? (
        // His press already timed it: the verbs left are to take it back, or to send it now.
        <VerbBar>
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void cancel()}>
            <BusyLabel busy={busy === "cancel"} label="Cancel send" />
          </Button>
          <span className="flex-1" />
          {item.state === "scheduled" ? (
            <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void now()}>
              <BusyLabel busy={busy === "now"} label={`${item.verb} now`} />
            </Button>
          ) : null}
        </VerbBar>
      ) : stale ? (
        <VerbBar>
          <DiscardButton busy={busy === "discard"} disabled={busy !== null} open={discardOpen} instant={byKey} onOpenChange={(o) => (setDiscardOpen(o), o || setByKey(false))} onDiscard={(r) => void discard(r)} />
          <span className="flex-1" />
          <Tip label="Ask the thread again" shortcut={keyHint("mod+enter")}>
            <Button size="sm" disabled={busy !== null} onClick={() => void again()}>
              <BusyLabel busy={busy === "again"} label="Ask the thread again" />
            </Button>
          </Tip>
        </VerbBar>
      ) : (
        <VerbBar>
          <DiscardButton busy={busy === "discard"} disabled={!waiting || busy !== null} open={discardOpen} instant={byKey} onOpenChange={(o) => (setDiscardOpen(o), o || setByKey(false))} onDiscard={(r) => void discard(r)} />
          <span className="flex-1" />
          {/* A send that may have gone: no plain Send, only his own Send again once he has looked. */}
          {item.outcomeUnknown && waiting ? <span className="text-[13px] leading-5 text-muted-foreground">{checkWords(item)}</span> : null}
          {editable ? (
            <Tip label="Edit" shortcut={shortcutFor("Work", "Edit Held Item")}>
              <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setEditing(true)}>
                Edit
              </Button>
            </Tip>
          ) : null}
          {item.outcomeUnknown && waiting ? (
            <Tip label={verbAgain} shortcut={keyHint("mod+enter")}>
              <Button variant="secondary" size="sm" disabled={sendOff} onClick={() => void send("again")}>
                <BusyLabel busy={busy === "again"} label={verbAgain} />
              </Button>
            </Tip>
          ) : (
            <SendSplit
              label={item.state === "failed" ? verbAgain : item.verb}
              verb={item.verb}
              busy={busy === "send" || busy === "grant" || busy === "later"}
              disabled={sendOff}
              later={later}
              grant={grant}
              open={menuOpen}
              instant={byKey}
              onOpenChange={(o) => (setMenuOpen(o), o || setByKey(false))}
              onPress={() => void send("send")}
              onLater={(at) => void sendLater(at)}
              onPickTime={() => setPicking(true)}
              onGrant={() => void send("grant")}
            />
          )}
        </VerbBar>
      )}
      {picking ? (
        <PickTime
          onClose={() => setPicking(false)}
          onPick={(at) => {
            setPicking(false);
            void sendLater(at);
          }}
        />
      ) : null}
    </>
  );
}
