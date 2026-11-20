import { useState, type FormEvent } from "react";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Input } from "../../components/ui/input";

/**
 * A new option, named before it reaches the question: nothing is made until Add, so a published form never shows
 * respondents a placeholder ("Option 3"). A refused Add keeps the dialog and the name, with the reason. As Add question.
 */
export function AddOption({ onAdd, onClose }: { onAdd(text: string): Promise<void>; onClose(): void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} busy={pending} title="Add option" size="sm">
      <Body onAdd={onAdd} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ onAdd, onClose, pending, setPending }: { onAdd(text: string): Promise<void>; onClose(): void; pending: boolean; setPending(p: boolean): void }) {
  const close = useModalClose();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ready = !!text.trim();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    onAdd(text.trim()).then(
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
        <Field label="Option">
          <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Add" pending={pending} disabled={!ready} />
    </form>
  );
}
