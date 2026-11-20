import { useState, type FormEvent } from "react";
import type { FormQuestion } from "@shared/contract-work-forms";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { newId, TYPE_WORDS } from "./model";

type Kind = Exclude<FormQuestion["type"], "section">;
const KINDS: { value: Kind; label: string }[] = (["short", "long", "choice", "dropdown"] as const).map((value) => ({ value, label: TYPE_WORDS[value] }));

/** The options typed one to a line, blank lines dropped. */
export const optionLines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * A new question, written in full before it reaches the form: nothing is made until Add, so a published form never shows
 * respondents a placeholder. A refused Add keeps the dialog and his words, with the reason.
 */
export function AddQuestion({ onAdd, onClose }: { onAdd(q: FormQuestion): Promise<void>; onClose(): void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} busy={pending} title="Add question" size="sm">
      <Body onAdd={onAdd} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ onAdd, onClose, pending, setPending }: { onAdd(q: FormQuestion): Promise<void>; onClose(): void; pending: boolean; setPending(p: boolean): void }) {
  const close = useModalClose();
  const [label, setLabel] = useState("");
  const [type, setType] = useState<Kind>("short");
  const [options, setOptions] = useState("");
  const [required, setRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const takes = type === "choice" || type === "dropdown";
  const choices = optionLines(options);
  const ready = !!label.trim() && (!takes || choices.length > 0);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready || pending) return;
    const q: FormQuestion = { id: newId(), label: label.trim(), type, required, ...(takes ? { options: choices } : {}) };
    setPending(true);
    setError(null);
    onAdd(q).then(
      () => {
        setPending(false);
        if (close) close(onClose);
        else onClose();
      },
      (err: unknown) => {
        setError(err instanceof Error && err.message ? err.message : "The host did not answer");
        setPending(false);
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <ModalBody>
        <Field label="Question">
          <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <FieldRow label="Kind">
          <ChoiceSelect label="Kind" value={type} options={KINDS} onChange={setType} />
        </FieldRow>
        {takes ? (
          <Field label="Options">
            <Textarea rows={3} value={options} placeholder="One per line" onChange={(e) => setOptions(e.target.value)} />
          </Field>
        ) : null}
        <FieldRow label="Required">
          <Switch checked={required} onCheckedChange={setRequired} />
        </FieldRow>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Add" pending={pending} disabled={!ready} />
    </form>
  );
}
