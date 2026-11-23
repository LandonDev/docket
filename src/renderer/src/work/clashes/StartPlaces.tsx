import { makeFunctionReference } from "convex/server";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
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
import { sessionFailure, useLifeosQuery, useLifeosSession, type LifeosSession } from "../shell/lifeos";
import { formChanged, placeWords, rowLabel, savePatch, type JobStart, type StartPatch, type StartPlace, type StartPlaces, type StartSettings, type StartTarget } from "./places";

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
  const settings = useLifeosQuery<StartSettings>(session, "settings:get", {});
  // The names the LifeOS section above uses, so a job reads the same on the whole page.
  const sectors = useLifeosQuery<Sector[]>(session, "sectors:list", {});
  const [open, setOpen] = useState<StartTarget | null>(null);
  if (session.state !== "connected") return null;
  const failed = places.status === "failed" ? places.error : settings.status === "failed" ? settings.error : null;
  if (failed) {
    return (
      <PageSection title="Start places">
        <PageError>{failed}</PageError>
      </PageSection>
    );
  }
  if (places.status !== "ready" || settings.status !== "ready" || sectors.status === "loading") {
    return (
      <PageSection title="Start places">
        <PageRowsSkeleton rows={7} description control="none" />
      </PageSection>
    );
  }
  const names = sectors.status === "ready" ? new Map(sectors.value.map((s) => [s.key, s.label])) : undefined;
  const nameOf = (target: StartTarget): string => (target === "home" ? "Home" : sectorName(target, names));
  const job = open && open !== "home" ? places.value.jobs.find((j) => j.sector === open) : undefined;
  return (
    <PageSection title="Start places">
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
      {open ? (
        <StartPlaceDialog
          session={session}
          target={open}
          title={nameOf(open)}
          place={open === "home" ? places.value.home : (job ?? { state: "none" })}
          lookups={job?.lookups ?? false}
          settings={settings.value}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </PageSection>
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
  settings,
  onClose,
}: {
  session: LifeosSession;
  target: StartTarget;
  title: string;
  place: StartPlace | JobStart;
  lookups: boolean;
  settings: StartSettings;
  onClose: () => void;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const send = (patch: StartPatch): Promise<unknown> => (session.client ? session.client.mutation(update, patch) : Promise.reject(new Error(sessionFailure(session.state))));
  return (
    <Modal onClose={onClose} title={title} size="sm" busy={pending !== null}>
      <StartPlaceForm target={target} place={place} lookups={lookups} settings={settings} send={send} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  );
}

type Pending = "save" | null;

/** The dialog's body and footer: one address, and for a job its lookups switch and "Use home", which empties the address for Save to send with whatever else changed. */
export function StartPlaceForm({
  target,
  place,
  lookups,
  settings,
  send,
  onClose,
  pending,
  setPending,
  error: shownError = null,
}: {
  target: StartTarget;
  place: StartPlace;
  lookups: boolean;
  settings: StartSettings;
  send: (patch: StartPatch) => Promise<unknown>;
  onClose: () => void;
  pending: Pending;
  setPending: (pending: Pending) => void;
  /** A refusal to show from the start: the preview's seam. */
  error?: string | null;
}) {
  const close = useModalClose();
  const [saved] = useState(() => ({ address: place.address ?? "", lookups }));
  const [form, setForm] = useState(saved);
  const [error, setError] = useState<string | null>(shownError);
  const job: SectorKey | null = target === "home" ? null : target;

  const linesId = useId();
  const address = useRef<HTMLInputElement>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const patch = savePatch(target, saved, form, settings);
    if (!patch || pending) return;
    setPending("save");
    setError(null);
    send(patch).then(
      () => {
        setPending(null);
        close ? close(onClose) : onClose();
      },
      (err: unknown) => {
        setPending(null);
        setError(refusalWords(err) || "LifeOS refused it");
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <ModalBody>
        <Field label="Address">
          <Input ref={address} autoFocus disabled={pending !== null} value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} placeholder={job ? "Home" : undefined} autoComplete="off" spellCheck={false} />
        </Field>
        {job ? (
          <FieldRow label="Look up event places on Apple Maps" description={<span id={linesId}>When off, this job's event places never leave your machines.</span>}>
            <Switch checked={form.lookups} disabled={pending !== null} aria-describedby={linesId} onCheckedChange={(on) => setForm((f) => ({ ...f, lookups: on }))} />
          </FieldRow>
        ) : null}
        <div role="alert" className="empty:hidden">
          <ErrorLine error={error} />
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
                setForm((f) => ({ ...f, address: "" }));
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
        disabled={!formChanged(saved, form)}
      />
    </form>
  );
}
