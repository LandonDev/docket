import { useState } from "react";
import { useMailClient } from "work-kit/mail";
import { Tip } from "../../../components/tip";
import { Button } from "../../../components/ui/button";
import { loadToast } from "../../../components/ui/toaster";
import { refusalWords } from "../../../lib/settingsHome";
import { openWorkView } from "../../../lib/workSwitch";
import { Trash2 as Trash } from "../../../chrome/icons";
import { patch, putInReply, usePage } from "../page";
import { CARD, CardBones, FOOT, HEAD } from "./cardParts";
import type { OfferAt } from "./OfferCard";

/** Lines of a draft shown before "Show all". */
const LINES = 12;

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const nameOf = (to: readonly { name?: string | undefined; address: string }[]): string => (to[0] ? to[0].name?.trim() || to[0].address : "no one yet") + (to.length > 1 ? ` and ${to.length - 1} more` : "");

/**
 * A draft the chat wrote, as he will send it: whom it goes to, its words, and where it stands, read live from
 * LifeOS. Put in reply opens it in Mail's reply box under the mail it answers; Send stays the composer's, through
 * the hold. Discard drops it, with Undo.
 */
export function DraftCard({ draftId, at }: { draftId: string; at: OfferAt }) {
  const client = useMailClient();
  // Discard's Undo saves the words again as a new draft: the card follows it.
  const [restored, setRestored] = useState<string | null>(null);
  const shownId = restored ?? draftId;
  const doc = client.useComposeDoc(shownId);
  const outbox = client.useOutboxActions();
  const page = usePage(at.workspaceId);
  const [all, setAll] = useState(false);
  const [gone, setGone] = useState(false);
  if (doc === undefined) return <CardBones />;
  const message = doc?.message;
  const inReply = page.compose && "open" in page.compose && (page.compose.open as { kind?: string; id?: string }).kind === "row" && (page.compose.open as { id?: string }).id === shownId;
  const state = gone || !doc ? "Discarded" : doc.status === "sent" ? `Sent ${clock(doc.editedAt)}` : doc.status === "failed" ? "Not sent" : doc.status === "queued" || doc.status === "sending" ? "Sending" : inReply ? "In your reply" : "Draft";
  const reply = message?.mode === "reply" || message?.mode === "replyAll";
  const title = message ? `${reply ? "Reply to" : message.mode === "forward" ? "Forward to" : "New mail to"} ${nameOf(message.to)}` : "A draft";
  const lines = (message?.text ?? "").trimEnd().split("\n");
  const long = lines.length > LINES;
  const open = !gone && !!doc && doc.status === "draft";

  const put = (): void => {
    const before = putInReply(at.workspaceId, { id: shownId, threadId: message?.threadId ?? null });
    openWorkView({ workspaceId: at.workspaceId, view: "mail" });
    // His own reply that was open stays saved in Drafts; Undo puts it back, in the mail it was in.
    const his = before;
    if (his) void loadToast().then((toast) => toast("Your reply is kept in Drafts", { action: { label: "Undo", onClick: () => patch(at.workspaceId, his) } }));
  };
  const discard = (): void => {
    if (!message) return;
    setGone(true);
    outbox.discard(shownId).then(
      (quote) =>
        void loadToast().then((toast) =>
          toast("Draft discarded", {
            action: {
              label: "Undo",
              onClick: () =>
                void outbox.save({ message, quote }).then(
                  (id) => {
                    setRestored(id);
                    setGone(false);
                  },
                  async (err: unknown) => (await loadToast()).error("Couldn't bring the draft back", { description: refusalWords(err) || undefined }),
                ),
            },
          }),
        ),
      async (err: unknown) => {
        setGone(false);
        (await loadToast()).error("Couldn't discard the draft", { description: refusalWords(err) || undefined });
      },
    );
  };

  return (
    <div data-mail-offer="draft" className={CARD}>
      <div className={HEAD}>
        <h4 className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium text-foreground">{title}</h4>
        <span data-draft-state className="shrink-0 text-xs text-muted-foreground">
          {state}
        </span>
      </div>
      {message ? (
        <div className="px-3 pb-3">
          <p className={`text-[13px] leading-5 break-words whitespace-pre-wrap text-foreground select-text ${all || !long ? "" : "line-clamp-12"}`}>{message.text.trimEnd()}</p>
          {long && !all ? (
            <button type="button" className="mt-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground" onClick={() => setAll(true)}>
              Show all
            </button>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div className={FOOT}>
          <Button variant="secondary" size="sm" onClick={put} disabled={!!inReply}>
            Put in reply
          </Button>
          <span className="flex-1" />
          <Tip label="Discard draft">
            <Button variant="ghost" size="icon-sm" aria-label="Discard draft" className="text-muted-foreground" onClick={discard}>
              <Trash />
            </Button>
          </Tip>
        </div>
      ) : null}
    </div>
  );
}
