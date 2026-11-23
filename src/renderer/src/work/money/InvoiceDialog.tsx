import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { MoneyInvoiceNext, MoneyInvoicePage, MoneyKept } from "@shared/contract-work-money";
import { addDays, formatMoney, invoiceTotal, lineTotal, today, type Invoice, type InvoiceFrom, type InvoiceLine } from "@shared/work/money";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Plus, X } from "../../chrome/icons";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { request } from "./api";
import { AmountInput, noHeldReturn } from "./fields";
import { parseAmount } from "./model";
import { keepPrinted, newKey, printPage } from "./print";

/**
 * An invoice (Add → Invoice…) or, in a Purdue job, a purchase request (the
 * same dialog under that name): who it goes to, its number and dates, its
 * lines and their total, and his own details, asked whole once and then one
 * line with Edit. Create checks it on the host, prints it, and hands the PDF
 * back to be kept with its row. Nothing is sent from here.
 */

export type InvoiceKind = "invoice" | "request";

interface LineForm {
  what: string;
  quantity: string;
  rate: string;
}

export interface InvoiceForm {
  to: string;
  number: string;
  date: string;
  due: string;
  lines: LineForm[];
  reason: string;
  from: InvoiceFrom;
}

const BLANK_LINE: LineForm = { what: "", quantity: "1", rate: "" };

/** A line as it counts: a name, a quantity above nothing and a rate; null for a line not filled in. */
function lineOf(l: LineForm): InvoiceLine | null {
  const quantity = Number(l.quantity);
  const rate = parseAmount(l.rate);
  if (!l.what.trim() || !Number.isFinite(quantity) || quantity <= 0 || rate === null) return null;
  return { what: l.what.trim(), quantity, rate };
}

/** What Create sends; null while it is not whole. */
export function invoiceOf(kind: InvoiceKind, form: InvoiceForm): Invoice | null {
  const lines = form.lines.filter((l) => l.what.trim() || l.rate.trim()).map(lineOf);
  // Who it is from is needed: the one who gets the page must know (the host refuses it too).
  if (!form.to.trim() || !form.number.trim() || !form.from.name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(form.date) || !lines.length || lines.some((l) => l === null)) return null;
  return {
    kind,
    number: form.number.trim(),
    to: form.to.trim(),
    date: form.date,
    due: /^\d{4}-\d{2}-\d{2}$/.test(form.due) ? form.due : null,
    lines: lines as InvoiceLine[],
    from: { name: form.from.name.trim(), address: form.from.address.trim(), pay: kind === "invoice" ? form.from.pay.trim() : "" },
    ...(kind === "request" && form.reason.trim() ? { reason: form.reason.trim() } : {}),
  };
}

export const invoiceTitle = (kind: InvoiceKind, number: string): string => (kind === "invoice" ? `Invoice ${number}` : `Purchase request ${number}`);

/** Create: the host checks the invoice and answers its page, the page is printed, and the PDF is kept with its row. */
export async function createInvoice(env: string, workspaceId: string, invoice: Invoice, key: string): Promise<MoneyKept> {
  const page = await request<MoneyInvoicePage>(env, "work.money.invoice", { workspaceId, invoice });
  const printed = await printPage(env, page.name.replace(/\.pdf$/i, ""), page.html);
  return keepPrinted(env, { workspaceId, what: "invoice", invoice }, printed.data, key);
}

export function InvoiceDialog({ env, workspaceId, kind, onClose, onCreated }: { env: string; workspaceId: string; kind: InvoiceKind; onClose: () => void; onCreated: (kept: MoneyKept, invoice: Invoice) => void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title={kind === "invoice" ? "Invoice" : "Purchase request"} size="lg" busy={pending}>
      <Body env={env} workspaceId={workspaceId} kind={kind} onClose={onClose} onCreated={onCreated} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ env, workspaceId, kind, onClose, onCreated, pending, setPending }: { env: string; workspaceId: string; kind: InvoiceKind; onClose: () => void; onCreated: (kept: MoneyKept, invoice: Invoice) => void; pending: boolean; setPending: (p: boolean) => void }) {
  const close = useModalClose();
  const [next, setNext] = useState<MoneyInvoiceNext | null>(null);
  const [form, setForm] = useState<InvoiceForm | null>(null);
  const [dueTouched, setDueTouched] = useState(false);
  const [editingFrom, setEditingFrom] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const linesRef = useRef<HTMLDivElement>(null);
  // A line added from the keyboard takes the caret in its What.
  useEffect(() => {
    if (focusLine === null) return;
    linesRef.current?.querySelector<HTMLInputElement>(`[data-invoice-line="${focusLine}"] input`)?.focus();
    setFocusLine(null);
  }, [focusLine]);
  /** Return in a line's field adds the next line and moves there; Create stays on its button (and Return in To). */
  const onLineKey = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (e.repeat) return;
    setForm((f) => (f ? { ...f, lines: [...f.lines.slice(0, i + 1), { ...BLANK_LINE }, ...f.lines.slice(i + 1)] } : f));
    setFocusLine(i + 1);
  };

  useEffect(() => {
    let live = true;
    request<MoneyInvoiceNext>(env, "work.money.invoiceNext", { workspaceId, kind }).then(
      (n) => {
        if (!live) return;
        const date = today();
        setNext(n);
        setForm({ to: "", number: n.number, date, due: addDays(date, n.dueDays), lines: [{ ...BLANK_LINE }], reason: "", from: n.from ?? { name: "", address: "", pay: "" } });
      },
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [env, workspaceId, kind]);

  const invoice = form ? invoiceOf(kind, form) : null;
  const patch = (p: Partial<InvoiceForm>) => setForm((f) => (f ? { ...f, ...p } : f));
  const setLine = (i: number, p: Partial<LineForm>) => setForm((f) => (f ? { ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) } : f));

  const submit = () => {
    if (!invoice || pending) return;
    setError(null);
    setPending(true);
    // One key for one invoice: a retry of the same Create files it once on the host.
    const content = JSON.stringify(invoice);
    const key = keys.current.get(content) ?? newKey();
    keys.current.set(content, key);
    createInvoice(env, workspaceId, invoice, key).then(
      (kept) => {
        setPending(false);
        onCreated(kept, invoice);
        close ? close(onClose) : onClose();
      },
      (err: Error) => {
        setPending(false);
        setError(err.message);
      },
    );
  };

  const askFrom = !!next && (!next.from || editingFrom);
  const total = form ? invoiceTotal(form.lines.map(lineOf).filter((l): l is InvoiceLine => l !== null)) : 0;

  return (
    <form
      onKeyDown={noHeldReturn}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {!form ? (
        <ModalBody aria-busy="true" aria-label="Loading">
          {error ? (
            <ErrorLine error={error} />
          ) : (
            <>
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-20 w-full" />
            </>
          )}
        </ModalBody>
      ) : (
        <ModalBody>
          <Field label={kind === "invoice" ? "To" : "Vendor"}>
            <Input autoFocus value={form.to} autoComplete="off" onChange={(e) => patch({ to: e.target.value })} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Number">
              <Input value={form.number} autoComplete="off" className="tabular-nums" onChange={(e) => patch({ number: e.target.value })} />
            </Field>
            <Field label="Date">
              <Input
                type="date"
                value={form.date}
                className="tabular-nums"
                onChange={(e) => {
                  const date = e.target.value;
                  // The due date keeps its distance from the date until he sets it himself.
                  patch(dueTouched || !next || !date ? { date } : { date, due: addDays(date, next.dueDays) });
                }}
              />
            </Field>
            <Field label={kind === "invoice" ? "Due" : "Needed by"}>
              <Input
                type="date"
                value={form.due}
                className="tabular-nums"
                onChange={(e) => {
                  setDueTouched(true);
                  patch({ due: e.target.value });
                }}
              />
            </Field>
          </div>
          {kind === "request" ? (
            <Field label="Reason">
              <Textarea value={form.reason} rows={2} onChange={(e) => patch({ reason: e.target.value })} />
            </Field>
          ) : null}
          <div ref={linesRef} role="group" aria-label="Lines" className="flex flex-col gap-1">
            <div className="grid grid-cols-[minmax(0,1fr)_72px_112px_96px_28px] gap-2 text-xs font-medium text-muted-foreground">
              <span>What</span>
              <span>Quantity</span>
              <span>Rate</span>
              <span className="text-end">Amount</span>
              <span />
            </div>
            {form.lines.map((l, i) => {
              const counted = lineOf(l);
              return (
                <div key={i} data-invoice-line={i} className="grid grid-cols-[minmax(0,1fr)_72px_112px_96px_28px] items-center gap-2">
                  <Input aria-label={`What, line ${i + 1}`} value={l.what} autoComplete="off" onKeyDown={onLineKey(i)} onChange={(e) => setLine(i, { what: e.target.value })} />
                  <Input aria-label={`Quantity, line ${i + 1}`} onKeyDown={onLineKey(i)} value={l.quantity} inputMode="decimal" autoComplete="off" className="tabular-nums" onChange={(e) => setLine(i, { quantity: e.target.value })} />
                  <AmountInput aria-label={`Rate, line ${i + 1}`} onKeyDown={onLineKey(i)} value={l.rate} placeholder="0.00" onChange={(e) => setLine(i, { rate: e.target.value })} />
                  <span className="text-end text-[13px] tabular-nums">{counted ? formatMoney(lineTotal(counted)) : ""}</span>
                  {i > 0 ? (
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove line ${i + 1}`} className="text-muted-foreground" onClick={() => patch({ lines: form.lines.filter((_, j) => j !== i) })}>
                      <X />
                    </Button>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })}
            <div className="flex items-center justify-between pe-9 pt-1">
              <Button variant="ghost" size="xs" className="-ms-2 text-muted-foreground" onClick={() => patch({ lines: [...form.lines, { ...BLANK_LINE }] })}>
                <Plus />
                Add line
              </Button>
              <span className="flex items-baseline gap-2">
                <span className="text-xs text-muted-foreground">Total</span>
                <span data-invoice-total className="text-[13px] font-semibold tabular-nums">
                  {formatMoney(total)}
                </span>
              </span>
            </div>
          </div>
          {askFrom ? (
            <div role="group" aria-label="From" className="flex flex-col gap-4">
              <Field label={kind === "invoice" ? "Business name" : "From"}>
                <Input value={form.from.name} autoComplete="organization" onChange={(e) => patch({ from: { ...form.from, name: e.target.value } })} />
              </Field>
              <Field label="Address">
                <Textarea value={form.from.address} rows={2} onChange={(e) => patch({ from: { ...form.from, address: e.target.value } })} />
              </Field>
              {kind === "invoice" ? (
                <Field label="How to pay">
                  <Textarea value={form.from.pay} rows={2} onChange={(e) => patch({ from: { ...form.from, pay: e.target.value } })} />
                </Field>
              ) : null}
            </div>
          ) : (
            <div className="flex min-h-7 items-center gap-2 text-[13px]">
              <span className="min-w-0 truncate text-muted-foreground">From {form.from.name}</span>
              <Button variant="ghost" size="xs" onClick={() => setEditingFrom(true)}>
                Edit
              </Button>
            </div>
          )}
          <ErrorLine error={error} />
        </ModalBody>
      )}
      <DialogFooter onCancel={onClose} confirmLabel="Create" pending={pending} disabled={!invoice} />
    </form>
  );
}
