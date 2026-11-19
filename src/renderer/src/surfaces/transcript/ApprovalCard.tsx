// A9 (notices): the approval under an action row.
import { useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { loadToast } from "../../components/ui/toaster";
import { StatusMark } from "../../components/ui/status";
import { Outbox } from "../../chrome/icons";
import { shell } from "../../stores/shell";
import type { ApprovalDecision } from "../../lib/harness";
import { cn } from "../../lib/cn";
import { type Block } from "../../lib/session";

type Approval = NonNullable<Block["approval"]>;

/** The two buttons' words: Allow and Deny, or Run now and Skip for a
 *  computer step that waited for the Mac to be free. */
export function choiceWords(approval: Approval): { allow: string; deny: string } {
  return approval.choices === "run-skip" ? { allow: "Run now", deny: "Skip" } : { allow: "Allow", deny: "Deny" };
}

/** The decided approval's one line. An automatic denial is a timeout or a
 *  person's Stop, and the event does not say which, so the line says neither. */
export function decidedLine(approval: Approval): string {
  const runSkip = approval.choices === "run-skip";
  if (approval.decided === "allow") return runSkip ? "Ran now" : "Allowed";
  if (runSkip) return approval.auto ? "Skipped automatically" : "Skipped";
  return approval.auto ? "Denied automatically" : "Denied";
}

/** A Work thread's call the host held for the owner's press ("Held as item 12: Send to Dana Lee: Re: budget. It waits…",
 *  work/outbox/words.ts): the act in his words; null for any other result. */
export function heldOf(block: Pick<Block, "tool" | "approval">): { n: number; act: string } | null {
  const text = block.tool?.detail;
  // Only a call the hold answers (an add-on's tool, the bridge's addon_call, a computer step): a shell echoing the words draws nothing.
  if (!text || block.approval || !/^(mcp__|addon_call$|computer_)/.test(block.tool?.name ?? "")) return null;
  const match = /Held as item (\d+): ([\s\S]+?)\. It waits for the owner's press\./.exec(text);
  return match ? { n: Number(match[1]), act: match[2]!.trim() } : null;
}

/**
 * The held line under a Work thread's call (docs/DESIGN.md "Held is not
 * Needs you"): the Outbox glyph in the row's glyph column, "Held" then the
 * act in his words, muted; it opens the Outbox. Never amber, never a card:
 * the turn went on.
 */
function HeldLine({ act }: { act: string }) {
  return (
    <button
      type="button"
      data-slot="held"
      onClick={() => shell.openOutbox()}
      className="flex min-h-7 in-data-[table]:min-h-8 min-w-0 items-center gap-2 in-data-[table]:px-3 text-left font-sans text-[13px] leading-5 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
    >
      <span className="flex w-3.5 shrink-0 justify-center">
        <Outbox className="size-3.5" />
      </span>
      <span className="min-w-0 truncate">
        Held <span className="text-foreground">{act}</span>
      </span>
    </button>
  );
}

/**
 * An approval, under the action row that already says what it asks (the
 * command, the path). Undecided: one 28px line, the amber mark in the row's
 * glyph column and Allow and Deny (Run now and Skip for a computer step
 * waiting for the Mac) where the row's words start. Decided: the
 * verdict, one muted line at the words, fading in when the decision lands on
 * screen (a verdict that mounts decided just shows). Not a bordered card.
 * In a table: the waiting row is 40px, 6px round the buttons, so their drop
 * clears the table's clipped frame; the mark at its 12px inset; the verdict
 * a 32px row at 34px. The amber mark is drawn here alone: the call's row
 * above keeps its tool icon while this line asks.
 * A click draws the verdict at once, before the host's decided row comes
 * back, so a second click can send nothing more; a decision the host never
 * took puts the buttons back and says so in a toast.
 */
export function ApprovalCard({
  block,
  onApproval,
}: {
  block: Block;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void | Promise<unknown>;
}) {
  const approval = block.approval;
  // Seen waiting on this mount: only then is the verdict news worth a fade.
  const sawWaiting = useRef(!!approval && !approval.decided);
  const [sent, setSent] = useState<ApprovalDecision | null>(null);
  if (!approval) {
    const held = heldOf(block);
    return held ? <HeldLine act={held.act} /> : null;
  }
  const decide = (decision: ApprovalDecision) => {
    if (sent) return;
    setSent(decision);
    const delivered = onApproval?.(approval.requestId, decision);
    void Promise.resolve(delivered).catch(() => {
      setSent(null);
      void loadToast().then((toast) => toast.error("Couldn't send the decision"));
    });
  };
  if (approval.decided || sent) {
    return (
      <div
        data-slot="approval"
        className={cn(
          "flex min-h-7 in-data-[table]:min-h-8 items-center pl-5.5 in-data-[table]:pl-8.5 font-sans text-[13px] leading-5 text-muted-foreground",
          sawWaiting.current && "animate-in fade-in-0 duration-(--dur-fast) ease-(--ease-out) motion-reduce:animate-none",
        )}
      >
        {approval.decided ? decidedLine(approval) : decidedLine({ ...approval, decided: sent ?? undefined })}
      </div>
    );
  }
  const words = choiceWords(approval);
  return (
    <div data-slot="approval" className="flex min-h-7 in-data-[table]:min-h-8 min-w-0 items-center gap-2 in-data-[table]:px-3 in-data-[table]:py-1.5 font-sans">
      <span data-approval-mark className="flex w-3.5 shrink-0 justify-center">
        <StatusMark state="waiting" word={false} />
      </span>
      <Button size="sm" onClick={() => decide("allow")}>
        {words.allow}
      </Button>
      <Button size="sm" variant="secondary" onClick={() => decide("deny")}>
        {words.deny}
      </Button>
    </div>
  );
}
