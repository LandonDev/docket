import { ConvexProvider, useConvex, useMutation, useQuery, type ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useEffect, useRef, useState } from "react";
import type { SectorKey } from "@shared/work";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { Input } from "../../components/ui/input";
import { loadToast } from "../../components/ui/toaster";
import { workErrorWords } from "../../lib/workErrorWords";
import { jobNameNow } from "../jobName";
import { tellAdded } from "./added";
import { eventPayload, type EventForm, pad } from "./newEvent";
import type { LifeosSession } from "../shell/lifeos";
import { downOf } from "../shell/lifeosDown";
import { DownLine } from "../shell/DownLine";

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

type Writes = { saveOp: (args: Record<string, unknown>) => Promise<string>; sendOp: (args: Record<string, unknown>) => Promise<unknown>; convex: ConvexReactClient };

/**
 * What the form reads and writes through a client: the job's calendars and the two writes. Mounted only while there is a
 * client; the form keeps the calendars it last read and what he typed while there is none.
 */
function Live({ onWrites, onSources }: { onWrites: (writes: Writes | null) => void; onSources: (sources: Source[]) => void }) {
  const sources = useQuery(sourcesList, {}) as Source[] | undefined;
  const saveOp = useMutation(save) as Writes["saveOp"];
  const sendOp = useMutation(send);
  const convex = useConvex();
  useEffect(() => {
    if (sources !== undefined) onSources(sources);
  }, [sources, onSources]);
  // One lasting set over the newest callers and client (NewTaskDialog's `Live` says why).
  const latest = useRef({ saveOp, sendOp, convex });
  useEffect(() => {
    latest.current = { saveOp, sendOp, convex };
  });
  useEffect(() => {
    onWrites({
      saveOp: (args) => latest.current.saveOp(args),
      sendOp: (args) => latest.current.sendOp(args),
      get convex() {
        return latest.current.convex;
      },
    });
    return () => onWrites(null);
  }, [onWrites]);
  return null;
}

export function NewEventDialog({
  sector,
  startsAt,
  initial,
  onAdded,
  onClose,
  session,
}: {
  sector: SectorKey;
  startsAt: number | null;
  /** what the form starts with (a mail chat's proposed event); he still saves it */
  initial?: Partial<EventForm>;
  /** after his Add went through */
  onAdded?: () => void;
  onClose: () => void;
  /**
   * The session it writes through, where the form outlives the view's body (`WorkViewModule.Kept`): while it is down,
   * the form keeps what he typed, says its line (`DownLine`) and holds Add. Without it, the form reads and writes
   * through the Convex client around it.
   */
  session?: LifeosSession;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title="New event" size="sm" busy={pending}>
      <Body sector={sector} startsAt={startsAt} initial={initial} onAdded={onAdded} onClose={onClose} pending={pending} setPending={setPending} session={session} />
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

function Body({
  sector,
  startsAt,
  initial,
  onAdded,
  onClose,
  pending,
  setPending,
  session,
}: {
  sector: SectorKey;
  startsAt: number | null;
  initial?: Partial<EventForm>;
  onAdded?: () => void;
  onClose: () => void;
  pending: boolean;
  setPending: (p: boolean) => void;
  session?: LifeosSession;
}) {
  const close = useModalClose();
  const [sources, setSources] = useState<Source[] | undefined>(undefined);
  const [writes, setWrites] = useState<Writes | null>(null);
  const down = session && downOf(session) ? session : null;
  const calendars = (sources ?? []).filter((s) => s.kind === "gcal" && s.enabled && s.sector === sector);
  // A slot picked in the week, else the next whole hour.
  const start = startsAt ?? Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  const [form, setForm] = useState<EventForm>({ title: "", day: dayOf(start), from: timeOf(start), to: timeOf(start + 3_600_000), where: "", invite: "", ...initial });
  const [calendar, setCalendar] = useState("");
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<EventForm>) => setForm((f) => ({ ...f, ...p }));
  const sourceId = calendar || calendars[0]?._id;
  const made = eventPayload(form);
  const asks = typeof made !== "string" && (made.attendees?.length ?? 0) > 0;
  // Read, and none of the job's calendars takes events: said before the press, which stays off.
  const none = sources !== undefined && !sourceId;

  const submit = () => {
    if (typeof made === "string") return setError(made);
    if (!sourceId || !writes) return;
    const { saveOp, sendOp, convex } = writes;
    setError(null);
    setPending(true);
    saveOp({ kind: "create", sourceId, payload: made })
      .then((id: string) => sendOp({ id, cause: "press" }).then(() => id))
      .then(
        (id) => {
          setPending(false);
          onAdded?.();
          // LifeOS has it queued: the toast says Adding, and Added (or why not) only once LifeOS's own row says so.
          void loadToast().then((toast) => tellAdded(convex, toast, { id, title: made.title, invites: asks }));
          close ? close(onClose) : onClose();
        },
        (err: unknown) => {
          setPending(false);
          const words = workErrorWords(err) || "LifeOS did not add the event";
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
      {session ? (
        session.client ? (
          <ConvexProvider client={session.client}>
            <Live onWrites={setWrites} onSources={setSources} />
          </ConvexProvider>
        ) : null
      ) : (
        <Live onWrites={setWrites} onSources={setSources} />
      )}
      <ModalBody>
        {/* The session dropped while the form was open: its line, with the rule's press; what he typed stays. */}
        {down ? <DownLine session={down} /> : null}
        <Field label="Event">
          <Input autoFocus value={form.title} onChange={(e) => patch({ title: e.target.value })} autoComplete="off" />
        </Field>
        {/* Day, From and To on one row where Day keeps room for its date; narrower, Day takes a row and the times share one. */}
        <div data-event-when className="@container/when">
          <div className="grid grid-cols-2 gap-2 @[400px]/when:grid-cols-[minmax(0,1fr)_120px_120px]">
            <Field label="Day" className="col-span-2 @[400px]/when:col-span-1">
              <Input type="date" value={form.day} onChange={(e) => patch({ day: e.target.value })} />
            </Field>
            <Field label="From">
              <Input type="time" value={form.from} onChange={(e) => patch({ from: e.target.value })} />
            </Field>
            <Field label="To">
              <Input type="time" value={form.to} onChange={(e) => patch({ to: e.target.value })} />
            </Field>
          </div>
        </div>
        <Field label="Where">
          <Input value={form.where} onChange={(e) => patch({ where: e.target.value })} autoComplete="off" />
        </Field>
        <Field label="Invite" hint="Addresses, comma between">
          <Input value={form.invite} onChange={(e) => patch({ invite: e.target.value })} autoComplete="off" spellCheck={false} />
        </Field>
        {calendars.length > 1 ? (
          <Field label="Calendar">
            <ChoiceSelect label="Calendar" value={sourceId ?? ""} options={calendars.map((c) => ({ value: c._id, label: c.label ?? c.channel ?? c.account }))} onChange={setCalendar} />
          </Field>
        ) : null}
        {none ? (
          <p data-no-calendar className="text-[13px] leading-5 text-muted-foreground">
            {jobNameNow(sector)} has no calendar that takes new events.
          </p>
        ) : null}
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel={asks ? "Send invites" : "Add"} pending={pending} disabled={sources === undefined || none || !writes} />
    </form>
  );
}
