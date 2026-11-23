import { useState } from "react";
import type { MoneyRate } from "@shared/contract-work-money";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { AmountInput, noHeldReturn } from "./fields";
import { request } from "./api";
import { rateWords } from "@shared/work/money";

/** The mileage rate (More → Mileage rate…): his own dollars a mile for the period's year. */

/** Dollars a mile as he types them ("0.70", "$0.725"): the "$" and spaces go first, then a number above nothing is needed; null for anything else (a lone "$", an empty field, zero). */
export function parseRate(text: string): number | null {
  const bare = text.replace(/[$\s]/g, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(bare)) return null;
  const n = Number(bare);
  return n > 0 && n <= 100 ? n : null;
}


export function RateDialog({ env, workspaceId, rate, onClose, onSaved }: { env: string; workspaceId: string; rate: MoneyRate; onClose: () => void; onSaved: () => void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title={`Mileage rate for ${rate.year}`} size="sm" busy={pending}>
      <Body env={env} workspaceId={workspaceId} rate={rate} onClose={onClose} onSaved={onSaved} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ env, workspaceId, rate, onClose, onSaved, pending, setPending }: { env: string; workspaceId: string; rate: MoneyRate; onClose: () => void; onSaved: () => void; pending: boolean; setPending: (p: boolean) => void }) {
  const close = useModalClose();
  // Bound to the year it opened for: that year's rate seeds it, and that year is what it saves.
  const [bound] = useState(rate);
  // The field seeds with the shared words ("0.70", "0.725", never "1e-7"); untouched, Save sends the stored number itself.
  const seed = rateWords(bound.rate);
  const [text, setText] = useState(seed);
  const [error, setError] = useState<string | null>(null);
  const value = text === seed ? bound.rate : parseRate(text);
  const submit = () => {
    if (value === null || pending) return;
    setError(null);
    setPending(true);
    request(env, "work.money.rate", { workspaceId, year: bound.year, rate: value }).then(
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
      onKeyDown={noHeldReturn}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ModalBody>
        <Field label="Per mile" hint="Later years without a rate use the most recent one.">
          <AmountInput value={text} placeholder="0.70" onChange={(e) => setText(e.target.value)} />
        </Field>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} disabled={value === null} />
    </form>
  );
}
