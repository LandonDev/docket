import { makeFunctionReference } from "convex/server";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { SectorKey } from "@shared/work";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Spinner } from "../../components/ui/spinner";
import { Switch } from "../../components/ui/switch";
import { refusalWords } from "../../lib/settingsHome";
import { sectorName } from "../shell/actions";
import { sessionFailure, sessionWaits, useLifeosQuery, useLifeosSession, type LifeosSession } from "../shell/lifeos";
import { fieldsOf, formChanged, placeWords, rowLabel, sameField, savePatch, type JobStart, type StartPatch, type StartPlace, type StartPlaces, type StartTarget } from "./places";
import { answered } from "./wait";

/**
 * Settings → Work, "Start places" (docs/agents/work-clashes.md): where each
 * job's drives begin, Home first, read live from LifeOS on the owner session
 * so a new address turns from "Looking up…" to the map's name by itself.
 * Each row opens its dialog; only he flips a job's map lookups, there.
 */

const update = makeFunctionReference<"mutation">("settings:update");

type Sector = { key: string; label: string; order: number };

export function StartPlacesSection({ environmentId }: { environmentId: string }) {
  const session = useLifeosSession(environmentId, null);
  const places = useLifeosQuery<StartPlaces>(session, "settings:startPlaces", {});
  // The names the LifeOS section above uses, so a job reads the same on the whole page.
  const sectors = useLifeosQuery<Sector[]>(session, "sectors:list", {});
  const [open, setOpen] = useState<StartTarget | null>(null);
  const connected = session.state === "connected";
  const failed = places.status === "failed" ? places.error : null;
  const ready = connected && places.status === "ready" && sectors.status !== "loading";
  const names = sectors.status === "ready" ? new Map(sectors.value.map((s) => [s.key, s.label])) : undefined;
  const nameOf = (target: StartTarget): string => (target === "home" ? "Home" : sectorName(target, names));
  // What the reads last gave whole: an open dialog stands on it while a read is out or has failed, so what he typed is never taken away under him.
  const good = useRef<{ places: StartPlaces; names: typeof names } | null>(null);
  if (ready && places.status === "ready") good.current = { places: places.value, names };
  const held = open ? good.current : null;
  const job = held && open !== "home" ? held.places.jobs.find((j) => j.sector === open) : undefined;
  const dialog =
    open && held ? (
      <StartPlaceDialog
        session={session}
        target={open}
        title={open === "home" ? "Home" : sectorName(open, held.names)}
        place={open === "home" ? held.places.home : (job ?? { state: "none" })}
        lookups={job?.lookups ?? false}
        // Save sends this one place alone, and waits for a read that is current, so he saves beside what LifeOS holds now.
        // A session still connecting is a wait like a read that is out, not a sign-out, and comes before what an earlier read said: a query keeps its last answer for a render after the session turns.
        blocked={ready ? null : sessionWaits(session) ? "" : (failed ?? (connected ? "" : sessionFailure(session.state)))}
        onClose={() => setOpen(null)}
      />
    ) : null;
  // One shape whatever the reads say, so the dialog is the same mounted form through a failed read, a dropped session and a read that is out.
  const body = failed ? (
    <PageError>{failed}</PageError>
  ) : places.status !== "ready" || sectors.status === "loading" ? (
    <PageRowsSkeleton rows={7} description control="none" />
  ) : (
    <>
      <PlaceRow title="Home" place={places.value.home} target="home" onOpen={() => setOpen("home")} />
      {places.value.jobs.map((j) => (
        <PlaceRow
          key={j.sector}
          title={
            <span className="inline-flex items-center gap-1">
              <SectorDot sector={j.sector} className="-ms-1" />
              {nameOf(j.sector)}
            </span>
          }
          label={nameOf(j.sector)}
          place={j}
          target={j.sector}
          onOpen={() => setOpen(j.sector)}
        />
      ))}
    </>
  );
  return (
    <>
      {connected ? <PageSection title="Start places">{body}</PageSection> : null}
      {dialog}
    </>
  );
}

function PlaceRow({ title, label = "Home", place, target, onOpen }: { title: ReactNode; label?: string; place: StartPlace; target: StartTarget; onOpen: () => void }) {
  const words = placeWords(place, target);
  // The wait turns: LifeOS's worker places a new address within about twenty seconds, and the row changes by itself.
  const description =
    place.state === "looking" ? (
      // The words beside it say the wait; the turning mark is for the eye alone.
      <span className="flex items-center gap-2">
        <Spinner aria-hidden className="size-3" />
        {words.description}
      </span>
    ) : (
      words.description
    );
  return <PageRow data-start={target} title={title} description={description} error={words.error} onOpen={onOpen} openLabel={rowLabel(label, words)} />;
}

function StartPlaceDialog({
  session,
  target,
  title,
  place,
  lookups,
  blocked,
  onClose,
}: {
  session: LifeosSession;
  target: StartTarget;
  title: string;
  place: StartPlace | JobStart;
  lookups: boolean;
  blocked: string | null;
  onClose: () => void;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const send = (patch: StartPatch): Promise<unknown> => (session.client ? session.client.mutation(update, patch) : Promise.reject(new Error(sessionFailure(session.state))));
  return (
    <Modal onClose={onClose} title={title} size="sm" busy={pending !== null}>
      <StartPlaceForm target={target} place={place} lookups={lookups} blocked={blocked} send={send} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  );
}

type Pending = "save" | null;
/** What the dialog says when a Save got no answer in time: it may or may not have landed. */
const UNSURE = "LifeOS did not answer. Save again to be sure.";

/** The dialog's body and footer: one address, and for a job its lookups switch and "Use home", which empties the address for Save to send with whatever else changed. */
export function StartPlaceForm({
  target,
  place,
  lookups,
  send,
  onClose,
  pending,
  setPending,
  blocked = null,
  error: shownError = null,
}: {
  target: StartTarget;
  place: StartPlace;
  lookups: boolean;
  send: (patch: StartPatch) => Promise<unknown>;
  onClose: () => void;
  pending: Pending;
  setPending: (pending: Pending) => void;
  /** LifeOS cannot be read just now (why, in words; empty while a read is merely out, which the form says as a wait): the form keeps what he typed and Save waits. */
  blocked?: string | null;
  /** A refusal to show from the start: the preview's seam. */
  error?: string | null;
}) {
  const close = useModalClose();
  // What LifeOS holds now, as the reads say, with what he changed laid over it. A field he has not touched follows the reads, and Save is on whenever the form differs from what is stored now: a Save that timed out and landed after all can be undone, and a change made elsewhere to a field he left alone is never sent back.
  const saved = { address: place.address ?? "", lookups };
  const [edits, setEdits] = useState<Partial<typeof saved>>({});
  const form = { ...saved, ...edits };
  const [error, setError] = useState<string | null>(shownError);
  const job: SectorKey | null = target === "home" ? null : target;
  // What a Save whose answer never came sent. Once the reads show those values, it landed: its words go, and its edits are simply what is stored now, so they are dropped and those fields follow the reads again (a change made elsewhere since is not undone by his next Save). An edit he made after it stays.
  const unsure = useRef<Partial<typeof saved> | null>(null);
  useEffect(() => {
    const sent = unsure.current;
    if (!sent) return;
    const fields = Object.keys(sent) as (keyof typeof saved)[];
    if (!fields.every((field) => sameField(saved[field], sent[field]))) return;
    unsure.current = null;
    setError(null);
    setEdits((edits) => Object.fromEntries(Object.entries(edits).filter(([field, value]) => !sameField(value, sent[field as keyof typeof saved]))));
  }, [saved.address, saved.lookups]);

  const linesId = useId();
  const address = useRef<HTMLInputElement>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const patch = savePatch(target, saved, form);
    if (!patch || pending || blocked !== null) return;
    setPending("save");
    setError(null);
    unsure.current = null;
    // The write is given an end: a session that drops under it would leave the dialog locked. One job set alone is the same write twice over, so Save again is safe.
    answered(send(patch), UNSURE).then(
      () => {
        setPending(null);
        close ? close(onClose) : onClose();
      },
      (err: unknown) => {
        setPending(null);
        const words = refusalWords(err) || "LifeOS refused it";
        if (words === UNSURE) unsure.current = fieldsOf(patch);
        setError(words);
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <ModalBody>
        <Field label="Address">
          <Input ref={address} autoFocus disabled={pending !== null} value={form.address} onChange={(e) => setEdits((f) => ({ ...f, address: e.target.value }))} placeholder={job ? "Home" : undefined} autoComplete="off" spellCheck={false} />
        </Field>
        {job ? (
          <FieldRow label="Look up event places on Apple Maps" description={<span id={linesId}>When off, this job's event places never leave your machines.</span>}>
            <Switch checked={form.lookups} disabled={pending !== null} aria-describedby={linesId} onCheckedChange={(on) => setEdits((f) => ({ ...f, lookups: on }))} />
          </FieldRow>
        ) : null}
        {/* One line at a time: why LifeOS cannot be read now, before what it said of an earlier Save; and the wait, while a read is out. An earlier Save's words stand only while the form still differs from what LifeOS holds: once a Save that timed out is seen to have landed, there is nothing left to save again. */}
        <div role="alert" className="empty:hidden">
          <ErrorLine error={blocked === "" ? null : blocked || (formChanged(saved, form) ? error : null)} />
        </div>
        <div role="status" className="empty:hidden">
          {blocked === "" ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner aria-hidden className="size-3" />
              Waiting for LifeOS…
            </span>
          ) : null}
        </div>
      </ModalBody>
      <DialogFooter
        start={
          // Empties the field, as typing would: Save sends it with whatever else he changed here.
          job && form.address.trim() ? (
            <Button
              type="button"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => {
                setEdits((f) => ({ ...f, address: "" }));
                // The verb leaves with the address: the keyboard goes on from the field it emptied.
                address.current?.focus();
              }}
            >
              Use home
            </Button>
          ) : undefined
        }
        onCancel={onClose}
        confirmLabel="Save"
        pending={pending === "save"}
        disabled={!formChanged(saved, form) || blocked !== null}
      />
    </form>
  );
}
