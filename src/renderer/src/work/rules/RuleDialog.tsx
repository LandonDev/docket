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
 * dialog also moves it up or down the list, so the order is not the pointer's
 * alone. A move stays in the dialog until Save, which writes it with the same
 * reorder the grip makes; Cancel leaves the order as it was.
 */

/** The list's order as the dialog opened on it, and how Save writes a new one (rejects when the host refuses it). */
export type RuleMoves = { ids: readonly string[]; save(order: string[]): Promise<void> };

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
  // The order as the dialog has it: moved here, written only with Save.
  const [order, setOrder] = useState<string[]>(() => [...(moves?.ids ?? [])]);
  const ruleId = of.kind === "rule" ? of.rule.id : null;
  const at = ruleId ? order.indexOf(ruleId) : -1;
  const reordered = !!moves && order.join("\n") !== moves.ids.join("\n");
  const move = (by: -1 | 1): void =>
    setOrder((was) => {
      const next = [...was];
      const to = at + by;
      if (at < 0 || to < 0 || to >= next.length) return was;
      [next[at], next[to]] = [next[to]!, next[at]!];
      return next;
    });
  const close = useModalClose();
  const [text, setText] = useState(of.kind === "rule" ? of.rule.text : of.kind === "proposal" ? of.proposal.text : "");
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();
  const unchanged = of.kind === "rule" && trimmed === of.rule.text && !reordered;

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
      if (of.kind === "rule") {
        if (trimmed !== of.rule.text) await editRule(env, of.rule.id, { text: trimmed });
        if (reordered) await moves!.save(order);
      } else {
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
        {at >= 0 && order.length > 1 ? (
          <FieldRow label="Order" description={`${at + 1} of ${order.length}`}>
            <div role="group" className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="sm" disabled={pending !== null || at === 0} onClick={() => move(-1)}>
                Move up
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={pending !== null || at === order.length - 1} onClick={() => move(1)}>
                Move down
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
