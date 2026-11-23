import { useEffect, useState } from "react";
import type { CalendarOffer, MoneyEvents, MoneyTripped } from "@shared/contract-work-money";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { Input } from "../../components/ui/input";
import { heardTrip, request } from "./api";
import { AmountInput, noHeldReturn } from "./fields";
import { amountText, offerDay, parseAmount } from "./model";

/**
 * A trip and its pay (docs/DESIGN.md "The Money view"): a calendar offer he
 * reviews, or one he adds by hand, which may start from an event of the
 * last 60 days. An estimated distance says so under Miles; nothing else is
 * flagged.
 */

export interface TripForm {
  eventId: string | null;
  date: string;
  title: string;
  place: string;
  miles: string;
  fee: string;
  measured: boolean;
}

export const tripFormOf = (offer: CalendarOffer | null, day: string): TripForm =>
  offer
    ? { eventId: offer.eventId, date: offer.date, title: offer.title, place: offer.place ?? "", miles: offer.miles === null ? "" : String(offer.miles), fee: amountText(offer.fee), measured: offer.measured }
    : { eventId: null, date: day, title: "", place: "", miles: "", fee: "", measured: true };

/** A fee as he types it: blank, "0" or "$0.00" are no fee (0); null when it does not read. */
function feeOf(text: string): number | null {
  const bare = text.replace(/[$\s,]/g, "");
  if (bare === "" || /^0*\.?0*$/.test(bare)) return 0;
  return parseAmount(text);
}

/** What a trip writes; null while it has no date or name, a number does not read, or there is neither miles nor a fee. */
export function tripParams(workspaceId: string, form: TripForm): Record<string, unknown> | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date) || !form.title.trim()) return null;
  const miles = form.miles.trim() === "" ? 0 : Number(form.miles);
  const fee = feeOf(form.fee);
  if (!Number.isFinite(miles) || miles < 0 || fee === null || (miles <= 0 && fee <= 0)) return null;
  return {
    workspaceId,
    ...(form.eventId ? { eventId: form.eventId } : {}),
    date: form.date,
    title: form.title.trim(),
    place: form.place.trim(),
    ...(miles ? { miles } : {}),
    ...(fee ? { fee } : {}),
  };
}

/** A whole offer: its fee and measured miles are known, so one press adds it. */
export const offerWhole = (offer: CalendarOffer): boolean => offer.fee !== null && offer.miles !== null && offer.measured;

/** Adds an offer as it stands. */
export const addOffer = (env: string, workspaceId: string, offer: CalendarOffer): Promise<MoneyTripped> => request<MoneyTripped>(env, "work.money.trip", tripParams(workspaceId, tripFormOf(offer, offer.date))!);

const NONE = "";
export const ALREADY_WORDS = "That event was already added.";

export function TripDialog({ env, workspaceId, offer, day, onClose, onSaved }: { env: string; workspaceId: string; offer: CalendarOffer | null; day: string; onClose: () => void; onSaved: () => void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title="Trip" size="sm" busy={pending}>
      <Body env={env} workspaceId={workspaceId} offer={offer} day={day} onClose={onClose} onSaved={onSaved} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ env, workspaceId, offer, day, onClose, onSaved, pending, setPending }: { env: string; workspaceId: string; offer: CalendarOffer | null; day: string; onClose: () => void; onSaved: () => void; pending: boolean; setPending: (p: boolean) => void }) {
  const close = useModalClose();
  const [form, setForm] = useState<TripForm>(() => tripFormOf(offer, day));
  const [events, setEvents] = useState<CalendarOffer[] | null>(offer ? [] : null);
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<TripForm>) => setForm((f) => ({ ...f, ...p }));
  const params = tripParams(workspaceId, form);

  // By hand: the job's events of the last 60 days, to start from one.
  useEffect(() => {
    if (offer) return;
    let live = true;
    request<MoneyEvents>(env, "work.money.events", { workspaceId }).then(
      (r) => live && setEvents(r.events),
      () => live && setEvents([]),
    );
    return () => {
      live = false;
    };
  }, [env, workspaceId, offer]);

  const submit = () => {
    if (!params || pending) return;
    setError(null);
    setPending(true);
    request<MoneyTripped>(env, "work.money.trip", params).then(
      (tripped) => {
        setPending(false);
        // The event was added before: nothing was written, so the form stays, saying so.
        if (tripped?.already) {
          setError(ALREADY_WORDS);
          return;
        }
        // Its pay row or its log row may only wait as a suggestion: said, never shown as saved.
        heardTrip(env, workspaceId, tripped);
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
        {!offer ? (
          <Field label="From the calendar">
            <ChoiceSelect
              label="From the calendar"
              className="w-full"
              disabled={events === null}
              value={form.eventId ?? NONE}
              options={[{ value: NONE, label: "None" }, ...(events ?? []).map((e) => ({ value: e.eventId, label: `${offerDay(e.date)}, ${e.title}` }))]}
              onChange={(id) => {
                const picked = (events ?? []).find((e) => e.eventId === id) ?? null;
                setForm(picked ? tripFormOf(picked, day) : { ...form, eventId: null, measured: true });
              }}
            />
          </Field>
        ) : null}
        <Field label="Date">
          <Input type="date" value={form.date} onChange={(e) => patch({ date: e.target.value })} className="tabular-nums" />
        </Field>
        <Field label="Name">
          <Input value={form.title} autoComplete="off" onChange={(e) => patch({ title: e.target.value })} />
        </Field>
        <Field label="Place">
          <Input value={form.place} autoComplete="off" onChange={(e) => patch({ place: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 items-start gap-3">
          <Field label="Miles there and back" hint={form.measured ? undefined : "Estimated: check the miles"}>
            <Input value={form.miles} inputMode="decimal" autoComplete="off" className="tabular-nums" onChange={(e) => patch({ miles: e.target.value, measured: true })} />
          </Field>
          <Field label="Fee">
            <AmountInput value={form.fee} placeholder="0.00" onChange={(e) => patch({ fee: e.target.value })} />
          </Field>
        </div>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Add" pending={pending} disabled={!params} />
    </form>
  );
}
