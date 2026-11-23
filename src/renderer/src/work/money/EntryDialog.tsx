import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { EntryFields, MoneyRead } from "@shared/contract-work-money";
import type { LedgerRow, Status } from "@shared/work/money";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { CheckRow, Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { ChoiceToggle } from "../../components/choice-toggle";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/cn";
import { atOf, saveEntry } from "./api";
import { AmountInput } from "./fields";
import { blankForm, canSave, fieldsOfForm, formOfRow, statusChoices, type EntryForm } from "./model";
import { sigOf } from "@shared/work/money";

/**
 * The one entry dialog (docs/DESIGN.md "The Money view"): a new entry, a
 * row he looks at or changes, and a receipt he confirms. Amount leads,
 * focused and selected; Return in any field saves; Save is off until Amount
 * and Date are there. With a picture the dialog is wide, the picture at the
 * left in a fixed column and the fields at the right.
 */

export type EntryMode = "new" | "edit" | "confirm";

const WAYS = [
  { value: "out", label: "Spent" },
  { value: "in", label: "Received" },
] as const;
const NEW_CATEGORY = "\u0000new";

const TITLES: Record<EntryMode, string> = { new: "New entry", edit: "Entry", confirm: "Confirm receipt" };

export interface EntryDialogProps {
  env: string;
  workspaceId: string;
  read: MoneyRead;
  mode: EntryMode;
  /** the row being looked at (edit) */
  row?: LedgerRow | null;
  /** the form to start from, in place of the row's or a blank one (confirm) */
  start?: EntryForm;
  /** a key that, when it changes, starts the form again from `start` (the next receipt) */
  startKey?: string;
  /** the picture at the left (confirm, or a row's receipt) */
  picture?: ReactNode;
  /** the Job field's choices; drawn only in confirm mode with more than one */
  jobs?: readonly { value: string; label: string }[];
  /** an action of the dialog's own at the footer's start (Discard, Send…); given Save's being in flight, so it can wait for it */
  footerStart?: ReactNode | ((saving: boolean) => ReactNode);
  /** in place of the mode's title ("Confirm receipt 1 of 2") */
  title?: string;
  /** in place of the entry write: confirm mode's accept. Answers whether the dialog closes (false: it stays for the next) */
  onSave?: (fields: EntryFields, form: EntryForm) => Promise<boolean>;
  onClose: () => void;
  /** a write landed, or the ledger changed under it: read again */
  onSaved: () => void;
  /** another of the dialog's verbs is in flight */
  busy?: boolean;
}

export function EntryDialog(props: EntryDialogProps) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} title={props.title ?? TITLES[props.mode]} size={props.picture ? "lg" : "md"} busy={pending || props.busy}>
      <EntryBody {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function EntryBody({
  env,
  workspaceId,
  read,
  mode,
  row,
  start,
  startKey,
  picture,
  jobs,
  footerStart,
  onSave,
  onClose,
  onSaved,
  busy,
  pending,
  setPending,
}: EntryDialogProps & { pending: boolean; setPending: (p: boolean) => void }) {
  const close = useModalClose();
  const first = (): EntryForm => start ?? (row ? formOfRow(row, workspaceId) : blankForm(workspaceId));
  const [form, setForm] = useState<EntryForm>(first);
  const [typingCategory, setTypingCategory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = useRef<HTMLInputElement>(null);
  const sellers = useId();
  const patch = (p: Partial<EntryForm>) => setForm((f) => ({ ...f, ...p }));

  // Open, and each next receipt: Amount focused and selected.
  useEffect(() => {
    amount.current?.focus();
    amount.current?.select();
  }, [startKey]);
  // The next receipt swaps the form in place: the dialog stays.
  const seen = useRef(startKey);
  useEffect(() => {
    if (seen.current === startKey) return;
    seen.current = startKey;
    setForm(first());
    setTypingCategory(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startKey]);

  const ready = canSave(form);
  const finish = (fn: () => void) => (close ? close(fn) : fn());

  const submit = () => {
    if (pending || busy) return;
    const fields = fieldsOfForm(form, row ?? null);
    if (!fields) return;
    setError(null);
    setPending(true);
    const write: Promise<boolean> = onSave
      ? onSave(fields, form)
      : saveEntry(env, workspaceId, fields, row ? atOf({ ref: row.ref, row: row.row, sig: sigOf(row) }) : undefined).then(() => true);
    write.then(
      (closes) => {
        setPending(false);
        onSaved();
        if (closes) finish(onClose);
      },
      (err: Error) => {
        setPending(false);
        setError(err.message);
      },
    );
  };

  // Return in any field saves; a select's own list keeps its keys.
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || !(e.target instanceof HTMLInputElement)) return;
    if (e.target.type === "checkbox") return;
    e.preventDefault();
    submit();
  };

  const categories = categoryChoices(read.categories, form.category);
  const statuses = statusChoices(form);
  const showStatus = !(form.way === "out" && form.reimburse);
  const showJob = mode === "confirm" && (jobs?.length ?? 0) > 1;

  const fields = (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount">
          <AmountInput ref={amount} value={form.amount} placeholder="0.00" onChange={(e) => patch({ amount: e.target.value })} />
        </Field>
        <Field label="Date">
          <Input type="date" value={form.date} onChange={(e) => patch({ date: e.target.value })} className="tabular-nums" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Who">
          <Input value={form.who} list={sellers} autoComplete="off" onChange={(e) => patch({ who: e.target.value })} />
        </Field>
        {typingCategory ? (
          <Field label="Category">
            <Input autoFocus value={form.category} autoComplete="off" onChange={(e) => patch({ category: e.target.value })} />
          </Field>
        ) : (
          <Field label="Category">
            <ChoiceSelect
              label="Category"
              className="w-full"
              value={form.category}
              options={categories}
              onChange={(next) => {
                if (next === NEW_CATEGORY) {
                  patch({ category: "" });
                  setTypingCategory(true);
                } else patch({ category: next });
              }}
            />
          </Field>
        )}
      </div>
      <datalist id={sellers}>
        {read.sellers.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <div className="flex min-h-7 items-center gap-4">
        <ChoiceToggle label="Spent or received" value={form.way} options={WAYS} onChange={(way) => patch({ way, status: form.status === "To reimburse" ? "Paid" : form.status })} />
        {form.way === "out" ? <CheckRow label="To be paid back" checked={form.reimburse} onCheckedChange={(reimburse) => patch({ reimburse })} /> : null}
      </div>
      <div className={cn("grid gap-3", showStatus ? "grid-cols-2" : "grid-cols-1")}>
        {showStatus ? (
          <Field label="Status">
            <ChoiceSelect label="Status" className="w-full" value={form.status} options={statuses.map((s) => ({ value: s, label: s }))} onChange={(status: Status) => patch({ status })} />
          </Field>
        ) : null}
        <Field label="For">
          <Input value={form.what} autoComplete="off" onChange={(e) => patch({ what: e.target.value })} />
        </Field>
      </div>
      {showJob ? (
        <Field label="Job">
          <ChoiceSelect label="Job" className="w-full" value={form.job} options={jobs!} onChange={(job) => patch({ job })} />
        </Field>
      ) : null}
      <ErrorLine error={error} />
    </>
  );

  return (
    <form
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {picture ? (
        <ModalBody className="grid grid-cols-[320px_minmax(0,1fr)] items-start gap-5">
          <div className="w-[320px]">{picture}</div>
          <div className="flex min-w-0 flex-col gap-4">{fields}</div>
        </ModalBody>
      ) : (
        <ModalBody>{fields}</ModalBody>
      )}
      <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} busy={busy} disabled={!ready} start={typeof footerStart === "function" ? footerStart(pending) : footerStart} />
    </form>
  );
}

/** The category list, then New…; a word the row holds that is not on the list is kept on it. */
function categoryChoices(list: readonly string[], current: string): { value: string; label: string }[] {
  const words = current && !list.some((c) => c.toLowerCase() === current.toLowerCase()) ? [...list, current] : list;
  return [{ value: "", label: "None" }, ...words.map((c) => ({ value: c, label: c })), { value: NEW_CATEGORY, label: "New…" }];
}
