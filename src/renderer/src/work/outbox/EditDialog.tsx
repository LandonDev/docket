import { useId, useMemo, useState } from "react";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Modal, ModalBody } from "../../chrome/Modal";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { applyEdits, payloadView } from "./model";
import { editItem, type HostItem } from "./store";
import { splitSummary } from "./OutboxView";

/**
 * Change exactly what will go, while it waits (`work.outbox.edit`): each
 * field a person reads, and the body. What the host keeps for itself (the
 * account, the server, the thread a mail answers) is not offered. Saved, it
 * is still held: nothing goes until Send.
 */
export function EditDialog({ item, onClose }: { item: HostItem; onClose: () => void }) {
  const view = useMemo(() => payloadView(item.payload), [item.payload]);
  const fields = view.fields.filter((f) => f.edit);
  const [values, setValues] = useState<Map<string, string>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const set = (key: string, value: string) => setValues((prev) => new Map(prev).set(key, value));
  const save = async () => {
    const next = applyEdits(item.payload, values, view);
    if (next.error) return setError(next.error);
    setBusy(true);
    try {
      await editItem(item, next.payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} busy={busy} title="Edit" description={splitSummary(item.summary).act}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <ModalBody>
          {fields.map((field) => {
            const key = field.path.join(".");
            return (
              <div key={key} className="flex flex-col gap-1.5">
                <label htmlFor={`${id}-${key}`} className="text-xs font-medium text-muted-foreground">
                  {field.label}
                </label>
                <Input id={`${id}-${key}`} value={values.get(key) ?? field.value} onChange={(e) => set(key, e.target.value)} spellCheck={field.edit === "text"} />
              </div>
            );
          })}
          {view.body ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-body`} className="text-xs font-medium text-muted-foreground">
                Message
              </label>
              <Textarea id={`${id}-body`} rows={10} value={values.get(view.body.path.join(".")) ?? view.body.text} onChange={(e) => set(view.body!.path.join("."), e.target.value)} />
            </div>
          ) : null}
          {!fields.length && !view.body ? <p className="text-[13px] text-muted-foreground">Nothing in this act can be changed here.</p> : null}
          <ErrorLine error={error} />
        </ModalBody>
        <DialogFooter onCancel={onClose} confirmLabel="Save" pending={busy} disabled={values.size === 0} />
      </form>
    </Modal>
  );
}
