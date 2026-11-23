import { useEffect, useRef, useState } from "react";
import type { EntryFields, MoneyActed, MoneyRead, ToConfirm } from "@shared/contract-work-money";
import { BusyLabel, Button } from "../../components/ui/button";
import { moneyState, request, sayChanged, withToast } from "./api";
import { EntryDialog } from "./EntryDialog";
import { formOfReceipt, type EntryForm } from "./model";
import { dropWaiting, ReceiptPicture } from "./ToConfirm";

/**
 * Confirming receipts: the entry dialog in confirm mode, the picture at the
 * left and what was read in the fields. Save files it and, while more wait,
 * shows the next in the same dialog, so ten receipts are ten Returns.
 * Discard drops the one on screen and goes on the same way.
 */
export function ConfirmFlow({ env, workspaceId, read, first, onClose, reload }: { env: string; workspaceId: string; read: MoneyRead; first: string; onClose: () => void; reload: () => Promise<void> }) {
  const [id, setId] = useState(first);
  const [dropping, setDropping] = useState(false);
  const [jobs, setJobs] = useState<{ value: string; label: string }[]>([]);
  // What this dialog already filed or dropped: never shown again while the read catches up.
  const done = useRef(new Set<string>());
  // The item on screen, held while a newer read no longer lists it.
  const shown = useRef<ToConfirm | null>(null);
  const item = read.toConfirm.find((t) => t.id === id) ?? (shown.current?.id === id ? shown.current : null);
  shown.current = item;

  useEffect(() => {
    let live = true;
    moneyState(env).then(
      (state) => live && setJobs(state.jobs.map((j) => ({ value: j.workspaceId, label: j.name }))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [env]);

  const next = (): ToConfirm | null => read.toConfirm.find((t) => t.state === "ready" && t.id !== id && !done.current.has(t.id)) ?? null;
  /** On to the next, or closed when none waits. True: the dialog closes. */
  const advance = (): boolean => {
    done.current.add(id);
    const after = next();
    if (after) setId(after.id);
    return !after;
  };

  if (!item) return null;
  const name = item.fields.who || item.name || "Receipt";

  const save = async (fields: EntryFields, form: EntryForm): Promise<boolean> => {
    const acted = await request<MoneyActed>(env, "work.money.accept", { id: item.id, fields, ...(form.job && form.job !== workspaceId ? { workspaceId: form.job } : {}) });
    if ("changed" in acted) sayChanged();
    return advance();
  };

  const discard = () => {
    setDropping(true);
    withToast(() =>
      dropWaiting(env, item)
        .then(() => {
          void reload();
          if (advance()) onClose();
        })
        .finally(() => setDropping(false)),
    );
  };

  return (
    <EntryDialog
      key="confirm"
      env={env}
      workspaceId={workspaceId}
      read={read}
      mode="confirm"
      start={formOfReceipt(item.fields, workspaceId)}
      startKey={item.id}
      picture={item.picture ? <ReceiptPicture key={item.id} env={env} of={{ id: item.id }} name={name} /> : undefined}
      jobs={jobs}
      busy={dropping}
      footerStart={
        <Button variant="ghost" disabled={dropping} onClick={discard}>
          <BusyLabel busy={dropping} label="Discard" />
        </Button>
      }
      onSave={save}
      onClose={onClose}
      onSaved={() => void reload()}
    />
  );
}
