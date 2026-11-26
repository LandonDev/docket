import { useState } from "react";
import { WORKSPACE_NAME_MAX } from "@shared/domain";
import { Input } from "@renderer/components/ui/input";
import { DialogFooter, ErrorLine, errorText } from "./ConfirmDialog";
import { Modal, useModalClose } from "./Modal";
import { renameWorkspace } from "../lib/tcserver/projects";

type Props = { workspaceId: string; name: string; onClose: () => void; onRenamed?: () => void };

/** Rename from a rail row's menu: the row has no inline title to edit. The folder keeps its name. */
export function RenameWorkspaceDialog(props: Props) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} busy={pending} title="Rename workspace" size="sm">
      <RenameForm {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function RenameForm({ workspaceId, name, onClose, onRenamed, pending, setPending }: Props & { pending: boolean; setPending: (on: boolean) => void }) {
  const close = useModalClose();
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const next = draft.trim();
  const done = () => (close ? close(onClose) : onClose());
  const save = async () => {
    if (!next || next === name) return done();
    setPending(true);
    try {
      await renameWorkspace(workspaceId, next);
      onRenamed?.();
      setPending(false);
      done();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <Input
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Name"
          value={draft}
          maxLength={WORKSPACE_NAME_MAX}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
        />
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Rename" pending={pending} disabled={!next} />
    </form>
  );
}
