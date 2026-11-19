import { useState } from "react";
import type { RuleProposal } from "@shared/contract-work-rules";
import { Check, ChevronRight, PenLine } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, DISCLOSURE_CHEVRON } from "../../components/ui/collapsible";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { refusalWords } from "../../lib/settingsHome";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { decideProposal, removeRule, useDraftProposals } from "./data";
import { Evidence } from "./Evidence";
import { RuleDialog } from "./RuleDialog";

/**
 * Where he made the edit (docs/agents/work-rules.md, prototype rules.html
 * "Where he made the edit"): once a mail he changed is sent and the change
 * repeats one he made before, one muted 13px line under the sent mail names
 * the habit and offers the rule. Its caret opens the edits in one hairline
 * frame. Add rule… opens the dialog; Not now leaves it on the rules page;
 * once added the line says so, with Undo. Nothing shows when there is no
 * proposal.
 */

export function RuleLine({ env, draftId, className }: { env: string; draftId: string; className?: string }) {
  const load = useDraftProposals(env, draftId);
  const workspaces = useWorkspaces();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  if (load.status !== "ready" || !load.value.workspaceId) return null;
  const workspace = workspaces.find((w) => w.id === load.value.workspaceId);
  const shown = load.value.proposals.filter((p) => !hidden.has(p.id));
  if (!workspace || shown.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {shown.map((p) => (
        <Line key={p.id} env={env} proposal={p} workspace={workspace.name} onGone={() => setHidden((now) => new Set(now).add(p.id))} />
      ))}
    </div>
  );
}

function Line({ env, proposal, workspace, onGone }: { env: string; proposal: RuleProposal; workspace: string; onGone: () => void }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const failed = (what: string) => (err: unknown) => void loadToast().then((toast) => toast.error(what, { description: refusalWords(err) || undefined }));

  const undo = (rule: string): void => {
    setBusy(true);
    removeRule(env, rule, true)
      .catch(failed("Undo did not go through"))
      .finally(() => setBusy(false));
  };
  const notNow = (): void => {
    setBusy(true);
    decideProposal(env, proposal.id, "later").then(onGone, failed("The proposal was not put off")).finally(() => setBusy(false));
  };
  // The dialog stays mounted across the line's turn to Added, so its exit plays and it never comes back by itself after Undo.
  const dialog = adding ? <RuleDialog env={env} workspaceId={proposal.workspaceId} of={{ kind: "proposal", proposal }} onClose={() => setAdding(false)} /> : null;
  return (
    <>
      {proposal.state === "added" ? (
        <AddedLine workspace={workspace} busy={busy} onUndo={proposal.ruleId ? () => undo(proposal.ruleId!) : null} />
      ) : (
        <Collapsible open={open} onOpenChange={setOpen} data-rule-line={proposal.id}>
          <div className="flex min-h-7 flex-wrap items-start gap-x-2 gap-y-1 py-1 text-[13px] leading-5 text-muted-foreground">
            <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
              <PenLine className="size-3.5" />
            </span>
            <CollapsibleTrigger className="min-w-0 flex-1 basis-60 rounded-sm text-start hover:text-foreground">
              {proposal.line} Make it a rule for {workspace}?
              <ChevronRight className={cn("ms-1 inline size-3 align-[-1px]", DISCLOSURE_CHEVRON, open && "rotate-90")} />
            </CollapsibleTrigger>
            <span className="-mt-0.5 ms-auto flex shrink-0 gap-2">
              <Button variant="ghost" size="xs" disabled={busy} onClick={notNow}>
                <BusyLabel busy={busy} label="Not now" />
              </Button>
              <Button variant="secondary" size="xs" disabled={busy} onClick={() => setAdding(true)}>
                Add rule…
              </Button>
            </span>
          </div>
          <CollapsibleContent>
            <Evidence edits={proposal.edits} framed className="mt-1" />
          </CollapsibleContent>
        </Collapsible>
      )}
      {dialog}
    </>
  );
}

/** After Add: the check, what was done, and Undo, which puts the proposal back. */
function AddedLine({ workspace, busy, onUndo }: { workspace: string; busy: boolean; onUndo: (() => void) | null }) {
  return (
    <div className="flex min-h-7 items-start gap-2 py-1 text-[13px] leading-5 text-muted-foreground">
      <span className="flex h-5 w-3.5 shrink-0 items-center justify-center text-success">
        <Check className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">Added to {workspace}'s rules</span>
      {onUndo ? (
        <Button variant="ghost" size="xs" className="-mt-0.5" disabled={busy} onClick={onUndo}>
          <BusyLabel busy={busy} label="Undo" />
        </Button>
      ) : null}
    </div>
  );
}

