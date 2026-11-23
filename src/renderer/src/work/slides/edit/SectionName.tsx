import { useState } from "react";
import { DialogFooter, ErrorLine, errorText } from "../../../chrome/ConfirmDialog";
import { Field } from "../../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../../chrome/Modal";
import { Input } from "../../../components/ui/input";
import type { HandSession } from "./session";
import type { NameAsk } from "./slides";

/** PowerPoint's name for a section he has not named yet. */
export const UNTITLED_SECTION = "Untitled section";

/**
 * A section's name (a slide's menu: Add section here, Rename section…): a
 * small dialog with one field, the name selected so his first key replaces
 * it. The edit goes on the verb; a refusal stays in the dialog.
 */
export function SectionName({ ask, session, onClose }: { ask: NameAsk; session: HandSession; onClose(): void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title={ask.act === "add" ? "Add section" : "Rename section"} size="sm" busy={pending}>
      <Body ask={ask} session={session} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ ask, session, onClose, pending, setPending }: { ask: NameAsk; session: HandSession; onClose(): void; pending: boolean; setPending(p: boolean): void }) {
  const close = useModalClose();
  const [name, setName] = useState(ask.act === "add" ? UNTITLED_SECTION : ask.name);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    const words = name.trim();
    if (!words) return setError("Give the section a name");
    setError(null);
    setPending(true);
    session.editOrThrow([ask.act === "add" ? { op: "section", act: "add", at: ask.slide.id, name: words } : { op: "section", act: "rename", section: ask.section, name: words }]).then(
      () => {
        setPending(false);
        close ? close(onClose) : onClose();
      },
      (e: unknown) => {
        setPending(false);
        setError(errorText(e) || "The host did not answer");
      },
    );
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <ModalBody>
        <Field label="Name">
          <Input autoFocus value={name} maxLength={200} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel={ask.act === "add" ? "Add" : "Rename"} pending={pending} />
    </form>
  );
}
