import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useState } from "react";
import type { SectorKey } from "@shared/work";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Input } from "../../components/ui/input";
import { loadToast } from "../../components/ui/toaster";
import { refusalWords } from "../../lib/settingsHome";

/**
 * New task (prototype workspace.html, the Tasks header's verb): a plain write
 * to LifeOS in the workspace's sector, filed as LifeOS's own quick add files
 * one, so its Undo takes it back by its key. It holds nothing: a task he
 * writes himself goes at once.
 */

const SECTOR_NAMES: Record<SectorKey, string> = { cosmic: "Cosmic", hypixel: "Hypixel", purdue: "Purdue", ref: "Ref", unify: "Unify", life: "Life" };
const create = makeFunctionReference<"mutation">("tasks:create");
const takeBack = makeFunctionReference<"mutation">("tasks:takeBack");

/** A due day with no time is 9:00 that morning, as LifeOS reads one. */
export const dueOf = (day: string): number | undefined => (day ? new Date(`${day}T09:00`).getTime() : undefined);

export function NewTaskDialog({ sector, onClose }: { sector: SectorKey; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title="New task" size="sm" busy={pending}>
      <Body sector={sector} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ sector, onClose, pending, setPending }: { sector: SectorKey; onClose: () => void; pending: boolean; setPending: (p: boolean) => void }) {
  const close = useModalClose();
  const add = useMutation(create);
  const undo = useMutation(takeBack);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const words = title.trim();
    if (!words) return setError("Say what to do");
    const key = crypto.randomUUID();
    const dueAt = dueOf(due);
    setError(null);
    setPending(true);
    add({ sector, title: words, key, source: { kind: "manual", container: "quick-add", channel: "Typed", messageId: key, sentAt: Date.now() }, ...(dueAt !== undefined ? { dueAt } : {}) }).then(
      () => {
        setPending(false);
        void loadToast().then((toast) => toast(`Added to ${SECTOR_NAMES[sector]}`, { action: { label: "Undo", onClick: () => void undo({ key }).catch(() => toast.error("Couldn't undo")) } }));
        close ? close(onClose) : onClose();
      },
      (err: unknown) => {
        setPending(false);
        setError(refusalWords(err) || "LifeOS refused it");
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
        <Field label="Task">
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Book the ballroom" autoComplete="off" />
        </Field>
        <Field label="Due">
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Add" pending={pending} />
    </form>
  );
}
