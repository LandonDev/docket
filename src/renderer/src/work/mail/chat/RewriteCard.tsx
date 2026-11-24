import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useMailClient } from "work-kit/mail";
import { Button } from "../../../components/ui/button";
import { loadToast } from "../../../components/ui/toaster";
import { refusalWords } from "../../../lib/settingsHome";
import { useSessionActions } from "../../../surfaces/threadChat";
import { Runs } from "../MailCanvas";
import { pageOf, patch } from "../page";
import { proposalDiff, type Proposal } from "../proposal";
import { CARD, CardBones, FOOT, HEAD } from "./cardParts";
import type { OfferAt } from "./OfferCard";

const getDraft = makeFunctionReference<"query", { id: string }, { row: { proposed?: Proposal } } | null>("compose:get");
const settleProposal = makeFunctionReference<"mutation", { id: string; take: boolean }, boolean>("compose:settleProposal");

/** What he says when his reply changed under a rewrite: the chat reads it again. */
export const ASK_AGAIN = "My reply changed since your rewrite. Read it as it is now and propose the rewrite again.";

/**
 * The chat's rewrite of his own reply, as words taken out and put in. Take puts it in the reply (the composer closes,
 * LifeOS settles it, the composer opens again on the row, as the mail item beside a thread does); Leave drops it. A
 * reply that changed since is refused by LifeOS, and the card says so with Ask again.
 */
export function RewriteCard({ draftId, at }: { draftId: string; at: OfferAt }) {
  const client = useMailClient();
  const doc = client.useComposeDoc(draftId);
  const row = useQuery(getDraft, { id: draftId });
  const settle = useMutation(settleProposal);
  const actions = useSessionActions();
  const [done, setDone] = useState<"took" | "left" | "changed" | null>(null);
  const [busy, setBusy] = useState(false);
  if (doc === undefined || row === undefined) return <CardBones />;
  const proposed = row?.row.proposed;
  const message = doc?.message;
  const diff = message && proposed ? proposalDiff({ subject: message.subject, text: message.text }, proposed) : null;
  const to = message?.to[0] ? message.to[0].name?.trim() || message.to[0].address : null;
  const state = done === "took" ? "Taken" : done === "left" ? "Left" : done === "changed" ? "Changed since" : proposed ? "Rewrite" : "Settled";

  const decide = (take: boolean): void => {
    // His reply open on this row closes while LifeOS settles, and opens again on what was decided.
    const page = pageOf(at.workspaceId);
    const open = page.compose && (page.compose.open as { kind?: string; id?: string }).kind === "row" && (page.compose.open as { id?: string }).id === draftId ? page.compose : null;
    if (open) patch(at.workspaceId, { compose: null });
    setBusy(true);
    settle({ id: draftId, take }).then(
      (ok) => {
        setBusy(false);
        setDone(ok ? (take ? "took" : "left") : null);
        if (open) patch(at.workspaceId, { compose: { ...open, key: open.key + 1 } });
      },
      (err: unknown) => {
        setBusy(false);
        if (open) patch(at.workspaceId, { compose: open });
        if (/changed|edited|version/i.test(refusalWords(err))) setDone("changed");
        else void loadToast().then((toast) => toast.error("Couldn't settle the rewrite", { description: refusalWords(err) || undefined }));
      },
    );
  };

  return (
    <div data-mail-offer="rewrite" className={CARD}>
      <div className={HEAD}>
        <h4 className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium text-foreground">{to ? `Your reply to ${to}` : "Your reply"}</h4>
        <span className="shrink-0 text-xs text-muted-foreground">{state}</span>
      </div>
      {done === "changed" ? (
        <div className="flex items-center gap-2 px-3 pb-3">
          <p className="min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">Your reply changed since this was written</p>
          <Button variant="secondary" size="sm" onClick={() => actions.onSubmit(at.sessionId, ASK_AGAIN, [])}>
            Ask again
          </Button>
        </div>
      ) : diff ? (
        <div className="px-3 pb-3 text-[13px] leading-5 break-words whitespace-pre-wrap text-foreground select-text">
          {diff.subject ? (
            <p className="mb-2 font-medium">
              <Runs ops={diff.subject} />
            </p>
          ) : null}
          {diff.body ? <Runs ops={diff.body} /> : message?.text}
        </div>
      ) : null}
      {proposed && !done ? (
        <div className={FOOT}>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => decide(true)}>
            Take
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => decide(false)}>
            Leave
          </Button>
        </div>
      ) : null}
    </div>
  );
}
