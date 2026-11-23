import { useRef, useState } from "react";
import type { Template } from "@shared/work/templates";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Input } from "../../components/ui/input";
import { renameTemplate } from "./data";

/** A template of his own under a new name: the name filled and selected, Rename sends it to the host. */
export function RenameDialog({ env, workspaceId, template, onClose }: { env: string; workspaceId: string; template: Template; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal title="Rename template" size="sm" busy={pending} onClose={onClose}>
      <RenameForm env={env} workspaceId={workspaceId} template={template} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function RenameForm({
  env,
  workspaceId,
  template,
  onClose,
  pending,
  setPending,
}: {
  env: string;
  workspaceId: string;
  template: Template;
  onClose: () => void;
  pending: boolean;
  setPending: (on: boolean) => void;
}) {
  const close = useModalClose();
  const [name, setName] = useState(template.name);
  const [error, setError] = useState<string | null>(null);
  const selected = useRef(false);
  const rename = async () => {
    const next = name.trim();
    if (pending) return;
    if (!next || next === template.name) {
      if (close) close(onClose);
      else onClose();
      return;
    }
    setPending(true);
    setError(null);
    try {
      await renameTemplate(env, workspaceId, template.id, next);
      setPending(false);
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setPending(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void rename();
      }}
    >
      <ModalBody>
        <Field label="Name">
          <Input
            autoFocus
            value={name}
            readOnly={pending}
            spellCheck={false}
            onFocus={(event) => {
              if (selected.current) return;
              selected.current = true;
              event.currentTarget.select();
            }}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Rename" pending={pending} />
    </form>
  );
}
