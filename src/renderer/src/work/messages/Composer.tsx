import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CHAT_ROUTES, SOURCE_APP, SOURCE_NAME, type ChatDetail } from "@shared/work/messages";
import { CircleDot } from "../../chrome/icons";
import { COMPOSER_SURFACE } from "../../chrome/ComposerBar";
import { BusyLabel, Button } from "../../components/ui/button";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { openUrl } from "../../lib/native";
import { workOpenPort } from "../../lib/workSwitch";
import { useMessagesData, type ThreadDraft } from "./data";
import { firstName } from "./model";
import { keepRefusal, keepTyped, typedIn, useRefusal, useTyped, useTypedFrom } from "./page";
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
 * held reply sent by his press on it, a copy-only one copied. What he typed
 * stays with the conversation while the window lives.
 */
export function Composer({ workspaceId, detail }: { workspaceId: string; detail: ChatDetail }) {
  const data = useMessagesData();
  const chat = detail.chat;
  const chatId = chat._id;
  const text = useTyped(workspaceId, chatId);
  const setText = (next: string): void => keepTyped(workspaceId, chatId, next);
  const drafts = data.useDrafts(chatId);
  // A held reply first: his press can send it. A copy-only draft when nothing here can.
  const draft = drafts.find((d) => d.held) ?? drafts[0] ?? null;
  const [busy, setBusy] = useState<"send" | "drop" | null>(null);
  // A refusal stays with the conversation until he types or sends again.
  const refused = useRefusal(workspaceId, chatId);
  const setRefused = (words: string | null): void => keepRefusal(workspaceId, chatId, words);
  const field = useRef<HTMLTextAreaElement>(null);

  // Whose words the field holds: the draft's (or his edit of them, started from it), or his own. It is kept beside the
  // words in page.ts, so leaving and coming back, a Retry or the 640px crossing find it as it was. Send acts on that: a
  // draft's words press the held item, his own go as his own reply and leave the draft waiting. A draft gone meanwhile
  // (sent or discarded elsewhere) leaves its words as his own: only a fresh choice ties them to another.
  const fromDraft = useTypedFrom(workspaceId, chatId);
  // A draft arriving fills an empty field once; his own words are never written over.
  const filled = useRef<string | null>(null);
  useEffect(() => {
    if (!draft || filled.current === draft.id) return;
    filled.current = draft.id;
    if (!typedIn(workspaceId, chatId).trim()) keepTyped(workspaceId, chatId, draft.text, draft.id);
  }, [draft, workspaceId, chatId]);
  const drafting = draft !== null && fromDraft === draft.id && text.trim() !== "";
  // The draft's words, put before his own on his say ("Use draft"), so neither is lost.
  const takeDraft = (d: ThreadDraft): void => {
    keepTyped(workspaceId, chatId, text.trim() ? `${d.text}\n${text}` : d.text, d.id);
    field.current?.focus();
  };

  const route = detail.route;
  const sends = CHAT_ROUTES[chat.source] === "lifeos" && route.can;
  const why = route.can ? `LifeOS can't reply in ${SOURCE_NAME[chat.source]} yet` : route.why;
  const link = detail.link && /^https?:\/\//i.test(detail.link) ? detail.link : undefined;
  // A held draft goes by his press whatever the route says now: the hold reads the route again at the press.
  const mode: "send" | "copy" = drafting && draft ? (draft.held ? "send" : "copy") : sends ? "send" : "copy";
  const words = text.trim();
  const placeholder = chat.kind === "direct" ? `Reply to ${firstName(chat.name)}` : `Message ${chat.name}`;

  const run = async (what: "send" | "drop", act: () => Promise<void>): Promise<void> => {
    setBusy(what);
    setRefused(null);
    try {
      await act();
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  /**
   * After a send or a discard, the field empties only if it still holds exactly what it held at the press: anything he
   * typed, changed or replaced while it went stays as he left it.
   */
  const settle = (pressed: string): void => {
    if (typedIn(workspaceId, chatId) === pressed) keepTyped(workspaceId, chatId, "", null);
  };
  const send = (): Promise<void> => {
    const sent = text;
    const pressing = drafting && draft?.held ? draft : null;
    return run("send", async () => {
      if (pressing) await data.sendDraft(pressing, sent.trim());
      else await data.send(chatId, sent.trim());
      settle(sent);
      field.current?.focus();
    });
  };
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(words);
    } catch {
      void loadToast().then((toast) => toast.error("Couldn't copy"));
      return;
    }
    void loadToast().then((toast) => toast("Copied"));
    // A copied draft has done its work: it goes, and its words with it. His own words stay, for him to paste again.
    if (drafting && draft && !draft.held) {
      const done = draft;
      settle(text);
      await run("drop", () => data.dropDraft(done));
    }
  };
  const discard = (d: ThreadDraft): Promise<void> => {
    // The field empties only if it still holds the discarded draft's words as they were at the press.
    const pressed = fromDraft === d.id && text === d.text ? text : null;
    return run("drop", async () => {
      await data.dropDraft(d);
      if (pressed !== null) settle(pressed);
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (mode === "send" && words && !busy) void send();
  };

  const note = refused ? (
    <p role="alert" className="text-xs text-destructive">
      {refused}
    </p>
  ) : draft ? (
    // A copy-only draft's line ends with why its button is Copy; a draft he is not using offers itself.
    <DraftLine draft={draft} why={draft.held ? undefined : why} onUse={drafting ? undefined : () => takeDraft(draft)} />
  ) : mode === "copy" ? (
    <p className="text-xs text-muted-foreground">{why}</p>
  ) : null;

  return (
    // The column above keeps its scrollbar's strip; the composer keeps the same, so the two share one measure.
    <div className="shrink-0 overflow-hidden [scrollbar-gutter:stable]">
      <div data-composer className="mx-auto w-full max-w-[728px] px-6 pb-4">
        {note ? <div className="flex min-h-6 items-center px-3 pb-1">{note}</div> : null}
        <div className={cn("rounded-xl transition-[border-color] duration-(--dur-fast) ease-(--ease-out) has-focus:border-input motion-reduce:transition-none", COMPOSER_SURFACE)}>
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
            {draft ? (
              <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={busy !== null} onClick={() => void discard(draft)}>
                <BusyLabel busy={busy === "drop"} label="Discard" />
              </Button>
            ) : null}
            {mode === "copy" && link ? (
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void openUrl(link)}>
                Open in {SOURCE_APP[chat.source]}
              </Button>
            ) : null}
            {mode === "send" ? (
              <Button size="sm" disabled={!words || busy !== null} onClick={() => void send()}>
                <BusyLabel busy={busy === "send"} label="Send" />
              </Button>
            ) : (
              <Button size="sm" disabled={!words || busy !== null} onClick={() => void copy()}>
                Copy
              </Button>
            )}
          </div>
        </div>
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
    <span className="flex min-w-0 items-center gap-1.5 text-xs">
      <CircleDot aria-hidden className="size-3.5 shrink-0 text-warning" />
      <span className="shrink-0 text-muted-foreground">{draft.thread ? "Drafted in" : "Drafted in a thread"}</span>
      {draft.thread ? <span className="min-w-0 truncate font-medium text-foreground">{draft.thread}</span> : null}
      {why ? <span className="ms-1 min-w-0 truncate text-muted-foreground">{why}</span> : null}
      {onUse ? (
        <Button variant="ghost" size="xs" className="-my-1 ms-1 shrink-0 text-muted-foreground" onClick={onUse}>
          Use draft
        </Button>
      ) : null}
      {open ? (
        <Button variant="ghost" size="xs" className={cn("-my-1 shrink-0 text-muted-foreground", onUse ? null : "ms-1")} onClick={open}>
          Open thread
        </Button>
      ) : null}
    </span>
  );
}
