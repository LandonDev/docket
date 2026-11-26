import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { HostLinkLine, useHostLinkDown } from "../shell/hostLinkDown";
import { BusyLabel, Button } from "../../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { DateField } from "../../components/ui/date-field";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import { Textarea } from "../../components/ui/textarea";
import { loadToast } from "../../components/ui/toaster";
import { Tip } from "../../components/tip";
import { Attachment, AttachmentContent, AttachmentMedia, AttachmentTitle } from "../../components/ui/attachment";
import { ChevronDown, Clock, Paperclip, Pencil, Plug, SquareMousePointer } from "../../chrome/icons";
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
import { UnderItsAct } from "../acts/underItsAct";
import { Chat } from "../icons";
import { ownZone, scheduleLine } from "work-kit/mail/lib/zones";
import { itemFailWords, pressFailWords } from "./failWords";
import { applyEdits, grantFor, isAddress, isAddressList, lifeosWords, offerLine, pastOf, payloadView, timeOf, type Field as PayloadField } from "./model";
import { canEdit, changeKind, checkWords, DetailColumn, itemTitle, KeptPicture, pictureShown, pressable, splitSummary, usePicture, VerbBar } from "./parts";
import { undoResult } from "./results";
import {
  askAgain,
  cancelScheduled,
  decideMany,
  discardItem,
  editItem,
  fetchDetail,
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
import { refreshLifeos, useLifeosStatusHeard } from "../shell/lifeos";

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
function useWhole(item: HostItem): { shown: HostItem; ready: boolean; failed: boolean; error: unknown; retry(): Promise<void> } {
  const gate = item.kind === "mail.send";
  const linkDown = useHostLinkDown(item.environmentId);
  const key = JSON.stringify([item.environmentId, item.ref, item.updatedAt]);
  const [read, setRead] = useState<{ key: string; item: HostItem | null; error?: unknown } | null>(null);
  // `kept`: his Retry, which keeps the failed read (the note, its Retry spinning) until the answer replaces it. A read the
  // detail asks by itself (another item, the host's LifeOS back) draws the quote's bone meanwhile.
  const [attempt, setAttempt] = useState({ n: 0, kept: false });
  const pressing = useRef(false);
  useEffect(() => {
    let live = true;
    if (!attempt.kept) setRead(null);
    const answer = (next: { key: string; item: HostItem | null; error?: unknown }): void => {
      if (!live) return;
      pressing.current = false;
      setRead(next);
    };
    fetchDetail(item).then(
      (whole) => answer({ key, item: { ...item, ...whole, environmentId: item.environmentId } as HostItem }),
      (error: unknown) => answer({ key, item: null, error }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again for another item, a change, or a Retry
  }, [key, attempt]);
  const mine = read?.key === key ? read : null;
  const failed = gate && !!mine && !mine.item;
  // A mail's read its host's LifeOS failed is read again once that host says LifeOS is back (the note goes by itself).
  // Not while his Retry is out: that read is already asked, and its note stays until it answers.
  const status = useLifeosStatusHeard(gate ? item.environmentId : null);
  useEffect(() => {
    if (failed && status?.lifeos.state === "connected" && !pressing.current) setAttempt((a) => ({ n: a.n + 1, kept: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a fresh answer of the host, not the failure itself
  }, [status]);
  const wasDown = useRef(false);
  useEffect(() => {
    const recovered = wasDown.current && !linkDown;
    wasDown.current = !!linkDown;
    if (recovered && failed && !pressing.current) setAttempt((a) => ({ n: a.n + 1, kept: false }));
  }, [linkDown, failed]);
  // His Retry asks the host's LifeOS status first (a silence it clears, a sign-out it names), then the item.
  const env = item.environmentId;
  const retry = async (): Promise<void> => {
    pressing.current = true;
    await refreshLifeos(env).catch(() => {});
    setAttempt((a) => ({ n: a.n + 1, kept: true }));
  };
  // A kind whose read failed still shows as listed: only a mail's Send waits on it.
  return { shown: mine?.item ?? item, ready: gate ? !!mine?.item : true, failed, error: mine?.error, retry };
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

/**
 * Whether a failure may clear by itself, so trying again is the next step: a service that did not answer, timed out,
 * was busy or offline. One that will repeat as it stands (too large, refused, not allowed, an address) needs a fix.
 */
export function clearsByItself(error: string | null | undefined): boolean {
  return /did not answer|didn't answer|timed? ?out|try again|unavailable|offline|network|connection|rate limit|too many requests|busy|temporar/i.test(error ?? "");
}

/** Whether a refusal is about the files it carries (too large, a type refused): the editor cannot change those. */
export function aboutFiles(error: string | null | undefined): boolean {
  return /attach|\bfiles?\b|\.(zip|pdf|docx?|xlsx?|pptx?)\b/i.test(error ?? "");
}

/** "The thread rewrote this at 9:20 AM." / "You changed this at 9:20 AM." */
export const changedWords = (changed: NonNullable<HostItem["changed"]>, now = Date.now()): string =>
  `${changed.by === "thread" ? "The thread rewrote this" : "You changed this"} at ${heldWhen(changed.at, now)}.`;

/** "Dana Lee wrote back at 8:12 AM, after this was made: "Can we move it to 3?"" */
export const repliedWords = (replied: NonNullable<HostItem["replied"]>, now = Date.now()): string =>
  `${replied.from} wrote back at ${heldWhen(replied.at, now)}, after this was made: "${replied.line}"`;

/**
 * The thing with its changes marked where they stand (Show changes): its fields on the views' 72px column, a field
 * that moved with its old value struck before the new, then the body under its hairline with the words taken out
 * struck and the words put in tinted. It takes the thing's own slot, so the body is never drawn twice.
 */
/** The value a field was read from, by its path. */
const valueAt = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((at, key) => (at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined), value);

function ChangesInPlace({ first, now, onReady }: { first: unknown; now: unknown; onReady?: (ready: boolean) => void }) {
  const { fields: moved, body } = useMemo(() => changesOf(first, now), [first, now]);
  // In the order the thing reads, as EditInPlace: who it is from, to whom, then the rest. Its files go under the body.
  const { fields, files, view } = useMemo(() => {
    const view = payloadView(now);
    const rank = (key: string) => FIELD_ORDER.indexOf(key) + 1 || FIELD_ORDER.length + 1;
    const fields: { field: PayloadField; people: readonly { name?: string; address: string }[] | null }[] = [];
    const files: string[] = [];
    for (const field of view.fields) {
      const raw = valueAt(now, field.path);
      const named = Array.isArray(raw) && raw.length > 0 && raw.every((x) => typeof (x as { name?: unknown })?.name === "string" && !isAddress(x));
      if (named) files.push(...(raw as { name: string }[]).map((x) => x.name));
      else fields.push({ field, people: isAddress(raw) ? [raw] : isAddressList(raw) ? raw : null });
    }
    return { fields: fields.sort((a, b) => rank(a.field.key) - rank(b.field.key)), files, view };
  }, [now]);
  const was = new Map(moved.map((f) => [f.label, f.was]));
  // It shows the thing, so Send waits on it as on a kind's view (ActView's `onReady`).
  useLayoutEffect(() => {
    onReady?.(true);
    return () => onReady?.(false);
  }, [onReady]);
  return (
    <div data-slot="act-payload" data-outbox-changes className="flex min-w-0 flex-col gap-4">
      {fields.length ? (
        <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
          {fields.map(({ field: f, people }) => {
            const value = people
              ? people.map((person, i) => (
                  <span key={person.address}>
                    {i > 0 ? ", " : null}
                    {person.name?.trim() ? (
                      <>
                        {person.name} <span className="text-muted-foreground">{person.address}</span>
                      </>
                    ) : (
                      person.address
                    )}
                  </span>
                ))
              : f.value;
            return (
              <div key={f.path.join(".")} className="contents">
                <dt className="truncate text-muted-foreground">{f.label}</dt>
                <dd className="min-w-0 break-words">
                  {was.get(f.label) ? <del className="me-1 text-muted-foreground">{was.get(f.label)}</del> : null}
                  {was.has(f.label) ? <ins className="rounded-[3px] bg-accent/18 no-underline">{value}</ins> : value}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      {body ? (
        <div className={cn(view.fields.length > 0 && "border-t border-border pt-4")}>
          <Words pieces={body} />
        </div>
      ) : view.body ? (
        <div className={cn("whitespace-pre-wrap break-words text-sm leading-[22px]", view.fields.length > 0 && "border-t border-border pt-4")}>{view.body.text}</div>
      ) : null}
      {files.length ? (
        <div className="flex flex-wrap gap-2">
          {files.map((name) => (
            <Attachment key={name} size="sm">
              <AttachmentMedia>
                <Paperclip className="size-3.5" />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{name}</AttachmentTitle>
              </AttachmentContent>
            </Attachment>
          ))}
        </div>
      ) : null}
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
          <del key={i} className={cn("text-muted-foreground", pieces[i + 1]?.t === "ins" && "me-1")}>
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
  onRetry?: () => void | Promise<void>;
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
      <div key="changed">
        <Note glyph={<Pencil className="size-3.5" />}>
          {changedWords(item.changed)}
          {/* A link in the note's words, after a space: wrapped, it starts on their edge, not a button's padding in. */}
          {first !== undefined && onShowChanges ? (
            <>
              {" "}
              <Button variant="link" size="xs" className="h-auto px-0 align-baseline text-[13px]" aria-expanded={showChanges} onClick={() => onShowChanges(!showChanges)}>
                {showChanges ? "Hide changes" : "Show changes"}
              </Button>
            </>
          ) : null}
        </Note>
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
            <Button variant="ghost" size="xs" className="-my-0.5 ms-1" disabled={said.busy} onClick={said.action.run}>
              <BusyLabel busy={said.busy} label={said.action.label} />
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
 * undo."; a send he timed says when it goes, in the zone he named first and this window's after where they differ ("Goes Wed 7:04 PM Central · 8:04 PM Eastern. Sends as you."); an item out of date says nothing.
 */
export function effectWords(item: Pick<HostItem, "effect" | "state" | "kind" | "scheduledFor" | "scheduledZone">): string | null {
  // The time leads; the host's sentence then says only as whom ("Sends as you.").
  if (isScheduled(item) && item.scheduledFor != null) return `Goes ${scheduleLine(item.scheduledFor, item.scheduledZone ?? ownZone(), ownZone())}.${item.effect ? ` ${item.effect}` : ""}`;
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
        {/* Its row above already says the act in the host's words, the chat or channel of a post included. */}
        <UnderItsAct.Provider value>
          <ActView item={item} env={item.environmentId} />
        </UnderItsAct.Provider>
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
                  <span id={`${id}-${key}`} className="min-w-0 break-words ps-[11px]">
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
              <DateField required autoFocus value={day} onChange={setDay} />
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

/** A failure's fix as the primary press (Edit, or Open the thread), with Send again in its menu as Send later sits on Send's. */
function FixSplit({ label, again, busy, disabled, againOff, onFix, onAgain }: {
  label: string;
  again: string;
  busy: boolean;
  disabled: boolean;
  againOff: boolean;
  onFix: () => void;
  onAgain: () => void;
}) {
  return (
    <span className="flex items-center">
      <Tip label={label} shortcut={keyHint("mod+enter")}>
        <Button size="sm" disabled={disabled} className="rounded-e-none" onClick={onFix}>
          <BusyLabel busy={busy} label={label} />
        </Button>
      </Tip>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-sm" disabled={disabled} aria-label={`More: ${again}`} className="rounded-s-none border-s border-primary-foreground/15" />}>
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="min-w-40">
          <DropdownMenuItem disabled={againOff} onClick={onAgain}>
            {again}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
  linkLineInPage = false,
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
  linkLineInPage?: boolean;
}) {
  const linkDown = useHostLinkDown(listed.environmentId);
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
  // A failure that will not clear by itself (a file too large, a refused address) is fixed before it is tried again:
  // the fix leads (Edit where an edit can make it, else the thread that made it) and Send again steps down.
  const failedFirst = item.state === "failed" || !!refused;
  const editable = waiting && canEdit(item);
  const threadable = !!item.sessionId && !!onOpenSession;
  // The fix is the press that can change what was refused: Edit when its fields can, the thread when the refusal is
  // about its files (the editor cannot change those), Edit as the last way in.
  const fix = editable && (!aboutFiles(item.error) || !threadable) ? "edit" : threadable ? "thread" : null;
  const stuck = item.state === "failed" && !item.outcomeUnknown && !clearsByItself(item.error) && fix !== null;

  const run = async (which: Exclude<Busy, null>, work: () => Promise<void>, fail: string) => {
    setBusy(which);
    setRefused(null);
    try {
      await work();
    } catch (err) {
      sayFailed(pressFailWords(err, fail, hostInLine));
    }
    // After the catch, not in a finally: the React Compiler cannot lower one (scripts/compilerRatchet.test.ts).
    setBusy(null);
  };

  const send = (which: "send" | "again" | "grant") =>
    !linkDown && run(
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
    !linkDown && run(
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
    !linkDown && run(
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

  const sendOff = !!linkDown || !waiting || !ready || busy !== null;
  const verbs: DetailCommands = {
      primary: () => {
        if (editing) return save();
        if (stale) return void (busy === null && again());
        if (timed) return;
        if (stuck && fix === "edit" && busy === null) return setEditing(true);
        if (stuck && fix === "thread") return onOpenSession!(item.sessionId!, item.environmentId);
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
        {/* A failed item leads with its refusal: what went wrong comes before what the press would do. */}
        {failedFirst ? null : <Effect item={item} />}
        {linkDown && !linkLineInPage ? <HostLinkLine word={linkDown} retryHost={item.environmentId} /> : null}
        <ItemNotes item={item} host={host} refused={refused} unread={unread && !linkDown} unreadError={unreadError} onRetry={retry} showChanges={showChanges} onShowChanges={setShowChanges} noteRef={refusedLine} />
        {failedFirst ? (
          <div className="mt-1">
            <Effect item={item} />
          </div>
        ) : null}
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
          ) : showChanges && item.changed?.first !== undefined ? (
            <ChangesInPlace first={item.changed.first} now={item.payload} onReady={setViewLoaded} />
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
            <Button variant="secondary" size="sm" disabled={busy !== null || !!linkDown} onClick={() => void now()}>
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
          {stuck ? (
            <>
              {/* The fix is the primary press; Send again sits in its menu, one click away, so the bar fits a narrow window. */}
              {fix === "thread" && editable ? (
                <Tip label="Edit" shortcut={shortcutFor("Work", "Edit Held Item")}>
                  <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                </Tip>
              ) : null}
              <FixSplit
                label={fix === "edit" ? "Edit" : "Open the thread"}
                again={verbAgain}
                busy={busy === "send"}
                disabled={busy !== null}
                againOff={sendOff}
                onFix={() => (fix === "edit" ? setEditing(true) : onOpenSession!(item.sessionId!, item.environmentId))}
                onAgain={() => void send("send")}
              />
            </>
          ) : null}
          {!stuck && editable ? (
            <Tip label="Edit" shortcut={shortcutFor("Work", "Edit Held Item")}>
              <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setEditing(true)}>
                Edit
              </Button>
            </Tip>
          ) : null}
          {stuck ? null : item.outcomeUnknown && waiting ? (
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
              onPickTime={() => !linkDown && setPicking(true)}
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
