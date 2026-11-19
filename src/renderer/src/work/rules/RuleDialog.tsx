import { useState, type FormEvent } from "react";
import { RULE_TEXT_MAX, type HouseRule, type RuleProposal } from "@shared/contract-work-rules";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Field, FieldRow } from "../../chrome/DialogField";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { BusyLabel, Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { refusalWords } from "../../lib/settingsHome";
import { addRule, editRule, removeRule } from "./data";
import { Evidence } from "./Evidence";

/**
 * Adding, rewording or deleting a rule (docs/agents/work-rules.md): one
 * field, the sentence a thread is told. From a proposal it opens on the
 * proposed sentence with the edits it came from under it, 14px; Add rule
 * settles the proposal. Only his press writes a rule. An existing rule's
 * dialog also moves it up or down the list, the same reorder the grip makes,
 * so the order is not the pointer's alone; a move is written at once.
 */

/** Where the rule sits, and the moves the list allows from there; a move resolves once the host has the new order. */
export type RuleMoves = { at: number; of: number; move(by: -1 | 1): Promise<void> };

export type RuleDialogOf = { kind: "new" } | { kind: "rule"; rule: HouseRule } | { kind: "proposal"; proposal: RuleProposal };

export function RuleDialog({
  env,
  workspaceId,
  of,
  onClose,
  onAdded,
  moves,
}: {
  env: string;
  workspaceId: string;
  of: RuleDialogOf;
  onClose: () => void;
  onAdded?: (rule: HouseRule) => void;
  moves?: RuleMoves | null;
}) {
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const title = of.kind === "rule" ? "Edit rule" : "Add a rule";
  return (
    <Modal onClose={onClose} busy={pending !== null} title={title} size={of.kind === "proposal" ? "md" : "sm"}>
      <Body env={env} workspaceId={workspaceId} of={of} pending={pending} setPending={setPending} onClose={onClose} onAdded={onAdded} moves={moves ?? null} />
    </Modal>
  );
}

function Body({
  env,
  workspaceId,
  of,
  pending,
  setPending,
  onClose,
  onAdded,
  moves,
}: {
  env: string;
  workspaceId: string;
  of: RuleDialogOf;
  pending: "save" | "delete" | null;
  setPending: (p: "save" | "delete" | null) => void;
  onClose: () => void;
  onAdded?: (rule: HouseRule) => void;
  moves: RuleMoves | null;
}) {
  const [moving, setMoving] = useState<-1 | 1 | null>(null);
  const move = (by: -1 | 1): void => {
    if (!moves) return;
    setMoving(by);
    void moves.move(by).finally(() => setMoving(null));
  };
  const close = useModalClose();
  const [text, setText] = useState(of.kind === "rule" ? of.rule.text : of.kind === "proposal" ? of.proposal.text : "");
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();
  const unchanged = of.kind === "rule" && trimmed === of.rule.text;

  const run = async (what: "save" | "delete", work: () => Promise<unknown>): Promise<void> => {
    setPending(what);
    setError(null);
    try {
      await work();
      setPending(null);
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setError(refusalWords(err) || "The host did not answer");
      setPending(null);
    }
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!trimmed || pending || unchanged) return;
    void run("save", async () => {
      if (of.kind === "rule") await editRule(env, of.rule.id, { text: trimmed });
      else {
        // Awaited first: `onAdded?.(await addRule(…))` skips the write when no callback is given.
        const rule = await addRule(env, workspaceId, trimmed, of.kind === "proposal" ? of.proposal.id : undefined);
        onAdded?.(rule);
      }
    });
  };

  return (
    <form onSubmit={submit}>
      <ModalBody>
        <Field label="Rule">
          <Textarea
            autoFocus
            rows={2}
            value={text}
            maxLength={RULE_TEXT_MAX}
            onChange={(event) => setText(event.target.value.replace(/\n/g, " "))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </Field>
        {of.kind === "rule" && moves && moves.of > 1 ? (
          <FieldRow label="Order" description={`${moves.at + 1} of ${moves.of}`}>
            <div role="group" className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="sm" disabled={moving !== null || moves.at === 0} onClick={() => move(-1)}>
                <BusyLabel busy={moving === -1} label="Move up" />
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={moving !== null || moves.at === moves.of - 1} onClick={() => move(1)}>
                <BusyLabel busy={moving === 1} label="Move down" />
              </Button>
            </div>
          </FieldRow>
        ) : null}
        {of.kind === "proposal" && of.proposal.edits.length ? <Evidence edits={of.proposal.edits} large className="border-t border-border pt-4" /> : null}
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter
        start={
          of.kind === "rule" ? (
            <Button type="button" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={pending !== null} onClick={() => void run("delete", () => removeRule(env, of.rule.id))}>
              <BusyLabel busy={pending === "delete"} label="Delete" />
            </Button>
          ) : undefined
        }
        onCancel={onClose}
        confirmLabel={of.kind === "rule" ? "Save" : "Add rule"}
        pending={pending === "save"}
        busy={pending === "delete"}
        disabled={!trimmed || unchanged}
      />
    </form>
  );
}
