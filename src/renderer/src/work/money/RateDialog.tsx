import { useState } from "react";
import type { MoneyRate } from "@shared/contract-work-money";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Input } from "../../components/ui/input";
import { request } from "./api";

/** The mileage rate (More → Mileage rate…): his own dollars a mile for the period's year. */

/** Dollars a mile as he types them; null when it does not read. */
export function parseRate(text: string): number | null {
  const n = Number(text.trim().replace(/^\$\s*/, ""));
  return text.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

export function RateDialog({ env, workspaceId, rate, onClose, onSaved }: { env: string; workspaceId: string; rate: MoneyRate; onClose: () => void; onSaved: () => void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title="Mileage rate" description={String(rate.year)} size="sm" busy={pending}>
      <Body env={env} workspaceId={workspaceId} rate={rate} onClose={onClose} onSaved={onSaved} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ env, workspaceId, rate, onClose, onSaved, pending, setPending }: { env: string; workspaceId: string; rate: MoneyRate; onClose: () => void; onSaved: () => void; pending: boolean; setPending: (p: boolean) => void }) {
  const close = useModalClose();
  const [text, setText] = useState(String(rate.rate));
  const [error, setError] = useState<string | null>(null);
  const value = parseRate(text);
  const submit = () => {
    if (value === null || pending) return;
    setError(null);
    setPending(true);
    request(env, "work.money.rate", { workspaceId, year: rate.year, rate: value }).then(
      () => {
        setPending(false);
        onSaved();
        close ? close(onClose) : onClose();
      },
      (err: Error) => {
        setPending(false);
        setError(err.message);
      },
    );
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ModalBody>
        <Field label="Dollars a mile" hint="Used for every later year until you set that year's.">
          <Input value={text} inputMode="decimal" autoComplete="off" className="tabular-nums" onChange={(e) => setText(e.target.value)} />
        </Field>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} disabled={value === null} />
    </form>
  );
}
