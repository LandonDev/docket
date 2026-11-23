import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CHAT_ROUTES, SOURCE_APP, SOURCE_NAME, type ChatDetail } from "@shared/work/messages";
import { CircleDot } from "../../chrome/icons";
import { COMPOSER_SURFACE } from "../../chrome/ComposerBar";
import { TruncateTip } from "../../components/tip";
import { BusyLabel, Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { openUrl } from "../../lib/native";
import { workOpenPort } from "../../lib/workSwitch";
import { useMessagesData, type ThreadDraft } from "./data";
import { firstName } from "./model";
import { fieldOrigin, useWaitingDrafts } from "./drafts";
import { draftSeen, fieldAsPressed, keepDraftEdit, keepFailedPress, keepPress, seeDraft, keepRefusal, keepTyped, markDraft, pendingPress, stillPressed, typedIn, usePendingPress, useFailedPress, useRefusal, useTyped, useTypedFrom, type PressedField } from "./page";
import { QUICK_ANSWERS } from "./quick";

/**
 * The composer at the conversation's foot (docs/agents/work-messages.md "The
 * composer"): a field that grows from one line to eight, and a foot row whose
 * left end is the place for one-press answers and whose right end holds the
 * one primary button. Return sends, Shift and Return makes a line.
 *
 * Its button follows what can go: Send, through the host; Copy where nothing
 * here can send, with Open in the app beside it and LifeOS's reason above;
 * and a thread's draft opens in it under the line that names the thread, a
 * held reply sent by his press on it while the route can send, else copied as
 * a copy-only one is. What he typed
 * stays with the conversation while the window lives.
 */
export function Composer({ workspaceId, detail }: { workspaceId: string; detail: ChatDetail }) {
  const data = useMessagesData();
  const chat = detail.chat;
  const chatId = chat._id;
  const text = useTyped(workspaceId, chatId);
  const setText = (next: string): void => keepTyped(workspaceId, chatId, next);
  // A Send on its way is kept with the conversation, not this mount: leaving and coming back, a Retry or the 640px
  // crossing find it pending, and nothing more goes until LifeOS answers it.
  const pending = usePendingPress(workspaceId, chatId) !== undefined;
  // The drafts still waiting: none pressed and on its way, none sent or discarded here that the list still holds.
  const drafts = useWaitingDrafts(workspaceId, chatId);
  // Whose words the field holds: the draft's (or his edit of them, started from it), or his own. It is kept beside the
  // words in page.ts, so leaving and coming back, a Retry or the 640px crossing find it as it was; and it is resolved
  // against every draft still waiting (`fieldOrigin`), so a second draft waiting never hides what the field holds.
  const fromDraft = useTypedFrom(workspaceId, chatId);
  const origin = fieldOrigin(fromDraft, drafts);
  // A press from this composer that failed (or may have gone) owns the line, with its Open in Outbox on that item, over
  // any other draft waiting: until he opens it there, or the Outbox's state for it changes (it leaves the failed list).
  const failedPress = useFailedPress(workspaceId, chatId);
  const pressFailed = failedPress ? drafts.find((d) => d.id === failedPress && d.failed !== undefined) : undefined;
  useEffect(() => {
    if (failedPress && !pressFailed) keepFailedPress(workspaceId, chatId, null);
  }, [failedPress, pressFailed, workspaceId, chatId]);
  // The line's draft: that failed press; else the one the field holds; else a held reply (his press can send it), then
  // one whose press failed, then a copy-only draft.
  const draft =
    pressFailed ?? (origin.kind !== "own" ? origin.draft : (drafts.find((d) => d.held && d.failed === undefined) ?? drafts.find((d) => d.failed !== undefined) ?? drafts[0] ?? null));
  // A held reply whose press failed is the Outbox's to send again or check: its words never come into the field.
  const failed = draft?.failed !== undefined;
  const [dropping, setDropping] = useState(false);
  // A refusal stays with the conversation until he types or sends again.
  const refused = useRefusal(workspaceId, chatId);
  const setRefused = (words: string | null): void => keepRefusal(workspaceId, chatId, words);
  const field = useRef<HTMLTextAreaElement>(null);

  // Send acts on the origin: a held draft's words press the held item, his own go as his own reply and leave the draft
  // waiting. A draft gone meanwhile (sent or discarded elsewhere) leaves its words as his own.
  // A draft arriving fills an empty field once; his own words are never written over, and a field emptied by a Send
  // still on its way waits for its answer (a refusal of his own words puts them back; a refused held press leaves the
  // field as it is and keeps an unsaved edit with the draft, for Use draft).
  // A draft already waiting when the field held other words (another draft's, or his) is no arrival: it waits behind
  // Use draft, even once the field empties.
  // Met drafts are kept with the conversation (page.ts), so a remount never refills one he pushed aside.
  useEffect(() => {
    if (pending) return;
    const fresh = drafts.filter((d) => d.failed === undefined && !draftSeen(workspaceId, chatId, d.id));
    for (const d of fresh) seeDraft(workspaceId, chatId, d.id);
    if (draft && fresh.includes(draft) && !typedIn(workspaceId, chatId).trim()) keepTyped(workspaceId, chatId, draft.text, draft.id);
  }, [drafts, draft, pending, workspaceId, chatId]);
  // Words tied to a held reply that has since failed (here or in another window) are the item's, kept in the Outbox: its
  // own words leave the field, so no Send takes them as his own; an edit he was making stays, as his own words.
  const failedOrigin = origin.kind === "failed" ? origin.draft : null;
  useEffect(() => {
    if (!failedOrigin) return;
    const now = typedIn(workspaceId, chatId);
    keepTyped(workspaceId, chatId, now.trim() === failedOrigin.text.trim() ? "" : now, null);
  }, [failedOrigin, workspaceId, chatId]);
  const drafting = (origin.kind === "held" || origin.kind === "copy") && text.trim() !== "";
  // The draft's words, put before his own on his say ("Use draft"), so neither is lost.
  const takeDraft = (d: ThreadDraft): void => {
    keepTyped(workspaceId, chatId, text.trim() ? `${d.text}\n${text}` : d.text, d.id);
    field.current?.focus();
  };

  const route = detail.route;
  const sends = CHAT_ROUTES[chat.source] === "lifeos" && route.can;
  const why = route.can ? `LifeOS can't reply in ${SOURCE_NAME[chat.source]} yet` : route.why;
  const link = detail.link && /^https?:\/\//i.test(detail.link) ? detail.link : undefined;
  // The route chooses the button. Where it says no, a held draft is copied too, and it and its id stay until the route
  // returns; a copy-only draft is copied whatever the route.
  const mode: "send" | "copy" = sends && !(drafting && origin.kind === "copy") ? "send" : "copy";
  const words = text.trim();
  const placeholder = chat.kind === "direct" ? `Reply to ${firstName(chat.name)}` : `Message ${chat.name}`;

  const refusalOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const drop = async (act: () => Promise<void>): Promise<void> => {
    setDropping(true);
    setRefused(null);
    try {
      await act();
    } catch (err) {
      setRefused(refusalOf(err));
    } finally {
      setDropping(false);
    }
  };
  /**
   * After a discard or a copied draft, the field empties only if it is the very field of the press (`fieldAsPressed`,
   * taken before the step awaited): its revision moves on every change, so words cleared and typed again (the same
   * words, his own now) are not taken.
   */
  const settle = (pressed: PressedField): void => {
    if (stillPressed(workspaceId, chatId, pressed)) keepTyped(workspaceId, chatId, "", null);
  };
  /**
   * The field empties at the press; the pressed words (and the held draft's id when a draft was pressed) wait aside in
   * page.ts until LifeOS answers. Sent words never sit in the field, so nothing goes twice. What a refusal does depends
   * on what was pressed: his own words come back in front of whatever he typed since, a line between, as his own; a
   * held draft's do not come back into the field at all (the item keeps them, his unsaved revision kept beside it, and
   * Use draft brings them back), the field left as he has it; a held draft whose item failed shows its failed line.
   */
  const send = async (): Promise<void> => {
    const pressed = fieldAsPressed(workspaceId, chatId);
    const sent = pressed.text.trim();
    if (!sent || pendingPress(workspaceId, chatId)) return;
    // The same origin the line reads: a failed item's words are never sent as his own (the cleanup takes them).
    const at = fieldOrigin(pressed.from, drafts);
    if (at.kind === "failed") return;
    const pressing = at.kind === "held" ? at.draft : null;
    keepPress(workspaceId, chatId, { text: sent, draft: pressing?.id ?? null });
    keepTyped(workspaceId, chatId, "", null);
    setRefused(null);
    field.current?.focus();
    try {
      if (pressing) {
        await data.sendDraft(pressing, sent);
        // Pressed and gone: never offered again here, whatever the Outbox's list still says for a moment.
        markDraft(workspaceId, chatId, pressing.id, { settled: true });
      } else await data.send(chatId, sent);
    } catch (err) {
      if (pressing && (err as { failed?: boolean }).failed) {
        // The item failed and stays in the Outbox with these words, for Send again or Check Sent first there. Its line
        // says so; the words are its own, so they do not come back into the field.
        markDraft(workspaceId, chatId, pressing.id, { failed: refusalOf(err), ...((err as { unknown?: boolean }).unknown ? { unknown: true } : {}) });
        keepFailedPress(workspaceId, chatId, pressing.id);
      } else if (pressing) {
        // Refused, the item stays held: the pressed words come back only through Use draft. An edit the Outbox may not
        // have saved (a refused save, a reply over LifeOS's length) is kept under the draft's id until a save of it goes
        // through, so Use draft brings back his revision, not the item's old words. Whatever the field holds now (a
        // reply his Undo put back, words typed since) stays his own, untouched.
        if (sent !== pressing.text || pressing.unsaved) keepDraftEdit(workspaceId, chatId, pressing.id, sent);
        keepRefusal(workspaceId, chatId, refusalOf(err));
      } else {
        const now = typedIn(workspaceId, chatId);
        keepTyped(workspaceId, chatId, now.trim() ? `${sent}\n${now}` : sent, null);
        keepRefusal(workspaceId, chatId, refusalOf(err));
      }
    } finally {
      keepPress(workspaceId, chatId, null);
    }
  };
  const copy = async (): Promise<void> => {
    // Taken before the clipboard is written: the cleanup judges the field by this, not by what it holds by then.
    const pressed = fieldAsPressed(workspaceId, chatId);
    const at = fieldOrigin(pressed.from, drafts);
    try {
      await navigator.clipboard.writeText(pressed.text.trim());
    } catch {
      void loadToast().then((toast) => toast.error("Couldn't copy"));
      return;
    }
    void loadToast().then((toast) => toast("Copied"));
    // A copied copy-only draft has done its work: it goes, and its words with it. His own words stay, for him to paste
    // again, and so does a held draft copied while the route says no: it waits for the route to return.
    if (at.kind === "copy" && pressed.text.trim()) {
      const done = at.draft;
      await drop(async () => {
        await data.dropDraft(done);
        markDraft(workspaceId, chatId, done.id, { settled: true });
        settle(pressed);
      });
    }
  };
  const discard = (d: ThreadDraft): Promise<void> => {
    // The field empties if and only if its words are that draft's (edited or not) at the press and unchanged since.
    const pressed = fieldAsPressed(workspaceId, chatId);
    return drop(async () => {
      await data.dropDraft(d);
      markDraft(workspaceId, chatId, d.id, { settled: true });
      if (pressed.from === d.id) settle(pressed);
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (mode === "send" && words && !pending && !dropping) void send();
  };

  // A refusal says itself above the line, never in its place: a draft he may want back stays offered under it.
  const alert = refused ? (
    <p role="alert" className="text-xs text-destructive">
      {refused}
    </p>
  ) : null;
  const note = draft && failed ? (
    <FailedLine
      draft={draft}
      why={mode === "copy" ? why : undefined}
      onOpen={() => {
        keepFailedPress(workspaceId, chatId, null);
        data.openOutbox(draft);
      }}
    />
  ) : draft ? (
    // A draft's line ends with why its button is Copy, while it is; a draft he is not using offers itself.
    <DraftLine draft={draft} why={draft.held && sends ? undefined : why} onUse={drafting ? undefined : () => takeDraft(draft)} />
  ) : mode === "copy" ? (
    <p className="text-xs text-muted-foreground">{why}</p>
  ) : null;

  return (
    // The column above keeps its scrollbar's strip; the composer keeps the same, so the two share one measure.
    <div className="shrink-0 overflow-hidden [scrollbar-gutter:stable]">
      <div data-composer className="mx-auto w-full max-w-[728px] px-6 pb-4">
        {alert ? <div className="flex min-h-6 items-center px-3 pb-1">{alert}</div> : null}
        {note ? <div className="flex min-h-6 items-center px-3 pb-1">{note}</div> : null}
        {/* The field focus standard at the composer's outer edge (`focus-field`: the ring inside the border), for focus in
            the field alone: the foot row's buttons keep their own rings, and the edge stays at rest while one holds them. */}
        <div
          data-composer-box
          className={cn("focus-field rounded-xl [&:focus-within:not(:has(textarea:focus))]:border-border [&:focus-within:not(:has(textarea:focus))]:shadow-none", COMPOSER_SURFACE)}
        >
          <textarea
            ref={field}
            rows={1}
            aria-label={placeholder}
            placeholder={placeholder}
            value={text}
            onChange={(event) => {
              const next = event.currentTarget.value;
              // An edit keeps whose words they are; emptied, the field's next words are his own.
              keepTyped(workspaceId, chatId, next.trim() ? next : "", next.trim() ? undefined : null);
              if (refused) setRefused(null);
            }}
            onKeyDown={onKeyDown}
            className="text-message block max-h-[190px] min-h-9 w-full resize-none overflow-x-hidden overflow-y-auto bg-transparent px-3 pt-2.5 pb-1 text-foreground outline-none field-sizing-content placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            {QUICK_ANSWERS.length ? (
              <div className="flex min-w-0 items-center gap-1">
                {QUICK_ANSWERS.map((answer) => (
                  <Button key={answer.id} variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setText(text ? `${text} ${answer.text}` : answer.text)}>
                    {answer.label}
                  </Button>
                ))}
              </div>
            ) : null}
            <span className="flex-1" />
            {draft && !failed ? (
              <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={dropping || pending} onClick={() => void discard(draft)}>
                <BusyLabel busy={dropping} label="Discard" />
              </Button>
            ) : null}
            {mode === "copy" && link ? (
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void openUrl(link)}>
                Open in {SOURCE_APP[chat.source]}
              </Button>
            ) : null}
            {mode === "send" ? (
              <Button size="sm" disabled={!words || pending || dropping} onClick={() => void send()}>
                <BusyLabel busy={pending} label="Send" />
              </Button>
            ) : (
              <Button size="sm" disabled={!words || dropping} onClick={() => void copy()}>
                Copy
              </Button>
            )}
          </div>
        </div>
        {/* One status region, always mounted, so a screen reader speaks what became of his press as it changes. */}
        <span role="status" data-press-status className="sr-only">
          {draft && failed ? spokenFailure(draft) : ""}
        </span>
      </div>
    </div>
  );
}

/**
 * Whose draft this is: the amber mark, "Drafted in" and the thread's name, for a
 * copy-only draft why nothing here can send it, then its controls (Use draft
 * while the field holds his own words, Open thread), so the line ends with
 * what it offers.
 */
function DraftLine({ draft, why, onUse }: { draft: ThreadDraft; why?: string; onUse?: () => void }) {
  const open = draft.threadId ? () => workOpenPort.get()?.(draft.threadId!) : undefined;
  return (
    // The name and the reason take the room; the controls stand at the line's far end, apart from the thread's name. Where
    // room runs short the line wraps: the reason (why the button is Copy) is read whole, and only the title takes "…".
    <span data-draft-line className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">
      {/* The mark, "Drafted in" and the name hold together; the reason is 10px on by the line's gap, so a wrapped row
          starts flush with the mark. */}
      <span className="flex min-w-0 max-w-full items-center gap-1.5">
        <CircleDot aria-hidden className="size-3.5 shrink-0 text-warning" />
        <span className="shrink-0 text-muted-foreground">{draft.thread ? "Drafted in" : "Drafted in a thread"}</span>
        {draft.thread ? (
          <TruncateTip text={draft.thread}>
            <span className="min-w-0 truncate font-medium text-foreground">{draft.thread}</span>
          </TruncateTip>
        ) : null}
      </span>
      {why ? <span className="min-w-0 text-muted-foreground">{why}</span> : null}
      {onUse ? (
        <Button variant="ghost" size="xs" className="-my-1 ms-auto shrink-0" onClick={onUse}>
          Use draft
        </Button>
      ) : null}
      {open ? (
        <Button variant="ghost" size="xs" className={cn("-my-1 shrink-0", onUse ? null : "ms-auto")} onClick={open}>
          Open thread
        </Button>
      ) : null}
    </span>
  );
}

/** A failed press's reason: LifeOS's words, or the Outbox's own when it cannot know whether the reply went. */
const failedReason = (draft: ThreadDraft): string => (draft.unknown ? "Check whether it went first" : (draft.failed ?? ""));
/** Parts read as sentences, each ending once: a part already ending in a stop gets no second one. */
const sentences = (parts: readonly (string | undefined)[]): string =>
  parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .map((part) => (/[.!?…]$/.test(part) ? part : `${part}.`))
    .join(" ");
/** What the composer's status region says of a failed press: the word, the thread and why, as the line shows them. */
const spokenFailure = (draft: ThreadDraft): string => sentences([draft.unknown ? "May have gone." : "Not sent.", draft.thread, failedReason(draft)]);

/**
 * A thread's held reply whose press failed: the word ("Not sent.", or "May have gone." when the Outbox cannot know
 * whether it went) and the thread's name in ink, held together; then 10px on, muted, LifeOS's reason (or the Outbox's own
 * "Check whether it went first"), the route's reason while the button is Copy, and the one way on: Open in Outbox, on
 * that very item. The line wraps rather than cutting its reasons, a wrapped row flush with the mark (the 10px is the
 * line's gap, not a margin that travels); only the thread's name may be cut, its whole shown on hover while it is. The
 * composer's status region speaks it.
 */
function FailedLine({ draft, why, onOpen }: { draft: ThreadDraft; why?: string; onOpen: () => void }) {
  const unknown = draft.unknown === true;
  return (
    <span data-draft-failed={unknown ? "unknown" : "failed"} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">
      <span className="flex min-w-0 max-w-full items-center gap-1.5">
        <StatusMark state={unknown ? "waiting" : "failed"} word={unknown ? "May have gone." : "Not sent."} className="shrink-0" />
        {draft.thread ? (
          <TruncateTip text={draft.thread}>
            <span className="min-w-0 truncate font-medium text-foreground">{draft.thread}</span>
          </TruncateTip>
        ) : null}
      </span>
      <span className="min-w-0 text-muted-foreground">{failedReason(draft)}</span>
      {why ? <span className="min-w-0 text-muted-foreground">{why}</span> : null}
      <Button variant="ghost" size="xs" className="-my-1 ms-auto shrink-0" onClick={onOpen}>
        Open in Outbox
      </Button>
    </span>
  );
}
