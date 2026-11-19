import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useState } from "react";
import type { SectorKey } from "@shared/work";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { Input } from "../../components/ui/input";
import { loadToast } from "../../components/ui/toaster";
import { refusalWords } from "../../lib/settingsHome";
import { eventPayload, type EventForm, pad } from "./newEvent";

/**
 * New event (prototype workspace.html, the Agenda header's verb): a calendar
 * act LifeOS holds (`calendarOps.save`, milestone 24) on a Google calendar of
 * the workspace's sector, which goes when he presses Add, or Send invites
 * when it asks anyone (`calendarOps.send`, his press). LifeOS's worker
 * carries it to Google, as it carries any calendar act.
 */

type Source = { _id: string; kind: string; account: string; channel?: string; label?: string; sector?: string; enabled: boolean };
const sourcesList = makeFunctionReference<"query">("sources:list");
const save = makeFunctionReference<"mutation">("calendarOps:save");
const send = makeFunctionReference<"mutation">("calendarOps:send");

export function NewEventDialog({ sector, startsAt, onClose }: { sector: SectorKey; startsAt: number | null; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title="New event" size="sm" busy={pending}>
      <Body sector={sector} startsAt={startsAt} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  );
}

const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const timeOf = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function Body({ sector, startsAt, onClose, pending, setPending }: { sector: SectorKey; startsAt: number | null; onClose: () => void; pending: boolean; setPending: (p: boolean) => void }) {
  const close = useModalClose();
  const sources = useQuery(sourcesList, {}) as Source[] | undefined;
  const calendars = (sources ?? []).filter((s) => s.kind === "gcal" && s.enabled && s.sector === sector);
  const saveOp = useMutation(save);
  const sendOp = useMutation(send);
  // A slot picked in the week, else the next whole hour.
  const start = startsAt ?? Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  const [form, setForm] = useState<EventForm>({ title: "", day: dayOf(start), from: timeOf(start), to: timeOf(start + 3_600_000), where: "", invite: "" });
  const [calendar, setCalendar] = useState("");
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<EventForm>) => setForm((f) => ({ ...f, ...p }));
  const sourceId = calendar || calendars[0]?._id;
  const made = eventPayload(form);
  const asks = typeof made !== "string" && (made.attendees?.length ?? 0) > 0;

  const submit = () => {
    if (typeof made === "string") return setError(made);
    if (!sourceId) return setError("No calendar in this sector takes new events here.");
    setError(null);
    setPending(true);
    saveOp({ kind: "create", sourceId, payload: made })
      .then((id) => sendOp({ id, cause: "press" }))
      .then(
        () => {
          setPending(false);
          void loadToast().then((toast) => toast(asks ? `Invites sent: ${made.title}` : `Added ${made.title}`));
          close ? close(onClose) : onClose();
        },
        (err: unknown) => {
          setPending(false);
          const words = refusalWords(err) || "LifeOS refused it";
          setError(/NEEDS_WRITE_GRANT/.test(words) ? "This calendar's Google account must be connected again before LifeOS may write to it." : words);
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
        <Field label="Event">
          <Input autoFocus value={form.title} onChange={(e) => patch({ title: e.target.value })} placeholder="Walk the ballroom" autoComplete="off" />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_96px_96px] gap-2">
          <Field label="Day">
            <Input type="date" value={form.day} onChange={(e) => patch({ day: e.target.value })} />
          </Field>
          <Field label="From">
            <Input type="time" value={form.from} onChange={(e) => patch({ from: e.target.value })} />
          </Field>
          <Field label="To">
            <Input type="time" value={form.to} onChange={(e) => patch({ to: e.target.value })} />
          </Field>
        </div>
        <Field label="Where">
          <Input value={form.where} onChange={(e) => patch({ where: e.target.value })} autoComplete="off" />
        </Field>
        <Field label="Invite" hint="Addresses, comma between">
          <Input value={form.invite} onChange={(e) => patch({ invite: e.target.value })} placeholder="sam@purdue.edu" autoComplete="off" spellCheck={false} />
        </Field>
        {calendars.length > 1 ? (
          <Field label="Calendar">
            <ChoiceSelect label="Calendar" value={sourceId ?? ""} options={calendars.map((c) => ({ value: c._id, label: c.label ?? c.channel ?? c.account }))} onChange={setCalendar} />
          </Field>
        ) : null}
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel={asks ? "Send invites" : "Add"} pending={pending} disabled={sources === undefined} />
    </form>
  );
}
