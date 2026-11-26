import { useEffect, useId, useState } from "react";
import type { SetupItems } from "@server/shared/contract-devices";
import type { LifeosStatus } from "@server/shared/contract-work-lifeos";
import { BusyLabel, Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Tip } from "../../../components/tip";
import { DialogFooter, ErrorLine } from "../../../chrome/ConfirmDialog";
import { CheckRow, Field } from "../../../chrome/DialogField";
import { ModalBody, useModalClose } from "../../../chrome/Modal";
import { loadThemePreference } from "../../../lib/appearance";
import { LOCAL_ENVIRONMENT_ID } from "../../../lib/connection";
import { cancelSetupLink, makeSetupLink, type MadeLink } from "../../../lib/devicesClient";
import { loadDefaultModels } from "../../../lib/models";
import { thisDesktopInLine } from "../../../lib/native";
import { useWorkspaces } from "../../../lib/tcserver/workspaces";
import { hostRequest } from "../parts/hostRpc";
import { addErrorWords } from "./addWords";
import { ChoiceField, Secret, useFrame } from "./frame";

/**
 * Set up a new computer (docs/agents/pc-setup.md "The setup link"): a name and the list of what it gets, then the
 * link with Copy and the time it ends. Cancel the link withdraws it. The link lives in the dialog's state alone.
 */

type Workspace = { id: string; name: string };

/** This window's theme per kind of place and its default models, written once into the new computer's window. */
const windowSeeds = () => ({
  appearance: { code: loadThemePreference("code"), work: loadThemePreference("work") },
  defaultModels: loadDefaultModels(),
});

/** Signed in to LifeOS: a token is here, whether or not LifeOS answered last. */
const signedIn = (status: LifeosStatus | null): boolean =>
  !!status && (status.lifeos.state === "connected" || status.lifeos.state === "connecting" || status.lifeos.state === "unreachable");

export function SetupWay({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const work = useWorkspaces().filter((w) => w.kind === "work");
  const [lifeos, setLifeos] = useState<LifeosStatus | null>(null);
  useEffect(() => {
    void hostRequest<LifeosStatus>(LOCAL_ENVIRONMENT_ID, "work.lifeos.status").then(setLifeos, () => setLifeos(null));
  }, []);
  return <SetupWayView onClose={onClose} onChanged={onChanged} workspaces={work.map(({ id, name }) => ({ id, name }))} lifeosSignedIn={signedIn(lifeos)} />;
}

export type SetupWayViewProps = {
  onClose: () => void;
  onChanged?: () => void;
  workspaces: Workspace[];
  lifeosSignedIn: boolean;
  /** A link already made (ui:preview's fixture). */
  made?: MadeLink | null;
};

export function SetupWayView({ onClose, onChanged = () => {}, workspaces, lifeosSignedIn, made: madeAtFirst = null }: SetupWayViewProps) {
  const [pending, setPending] = useState(false);
  const [made, setMade] = useState<MadeLink | null>(madeAtFirst);
  useFrame({ title: "Set up a new computer", endsAt: made?.expiresAt, busy: pending });
  return made ? (
    <LinkMade made={made} onClose={onClose} onChanged={onChanged} />
  ) : (
    <SetupForm
      workspaces={workspaces}
      lifeosSignedIn={lifeosSignedIn}
      onClose={onClose}
      pending={pending}
      setPending={setPending}
      onMade={(next) => {
        setMade(next);
        onChanged();
      }}
    />
  );
}

/** The link, Copy and its end on the frame's line. Cancel the link takes it back; Done keeps it for the computer. */
function LinkMade({ made, onClose, onChanged }: { made: MadeLink; onClose: () => void; onChanged: () => void }) {
  const close = useModalClose();
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const cancel = async (): Promise<void> => {
    setCancelling(true);
    setError(null);
    try {
      await cancelSetupLink(made.pairingId);
      onChanged();
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setError(addErrorWords(err, thisDesktopInLine()));
      setCancelling(false);
    }
  };
  return (
    <>
      <ModalBody>
        <Secret label="Link" value={made.link} />
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter busy={cancelling} confirmLabel="Done" closeOnConfirm onConfirm={onClose}>
        <Button data-setup-cancel variant="secondary" disabled={cancelling} onClick={() => void cancel()}>
          <BusyLabel busy={cancelling} label="Cancel the link" />
        </Button>
      </DialogFooter>
    </>
  );
}

function SetupForm({
  workspaces,
  lifeosSignedIn,
  onClose,
  pending,
  setPending,
  onMade,
}: {
  workspaces: Workspace[];
  lifeosSignedIn: boolean;
  onClose: () => void;
  pending: boolean;
  setPending: (on: boolean) => void;
  onMade: (made: MadeLink) => void;
}) {
  const getsId = useId();
  const [name, setName] = useState("");
  const [items, setItems] = useState<SetupItems>({ accounts: true, lifeos: lifeosSignedIn, reader: lifeosSignedIn, folders: workspaces.length > 0 });
  const [chosen, setChosen] = useState<string[]>(() => workspaces.map((w) => w.id));
  const [error, setError] = useState<string | null>(null);
  // The status answers after the dialog opens: LifeOS takes its tick once it is known signed in.
  useEffect(() => {
    setItems((prev) => ({ ...prev, lifeos: lifeosSignedIn, reader: lifeosSignedIn }));
  }, [lifeosSignedIn]);
  const set = (patch: Partial<SetupItems>) => setItems((prev) => ({ ...prev, ...patch }));
  const folders = items.folders && chosen.length > 0;

  const make = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      onMade(await makeSetupLink({ name: name.trim(), items: { ...items, folders }, workspaces: folders ? chosen : [], seeds: windowSeeds() }));
    } catch (err) {
      setError(addErrorWords(err, thisDesktopInLine()));
    } finally {
      setPending(false);
    }
  };

  const lifeosRow = <CheckRow label="LifeOS signed in" checked={items.lifeos} disabled={!lifeosSignedIn} onCheckedChange={(on) => set({ lifeos: on, reader: on })} />;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && !pending) void make();
      }}
    >
      <ModalBody>
        <Field label="Name">
          <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Purdue laptop" spellCheck={false} autoComplete="off" />
        </Field>
        <ChoiceField label="It gets" id={getsId}>
          <div role="group" aria-labelledby={getsId} className="flex flex-col">
            {/* Always given: everything else travels over it. */}
            <CheckRow label="Link to the box" checked disabled onCheckedChange={() => {}} />
            <CheckRow label="Your accounts" checked={items.accounts} onCheckedChange={(on) => set({ accounts: on })} />
            {lifeosSignedIn ? (
              lifeosRow
            ) : (
              <Tip label={`Work on ${thisDesktopInLine()} is not signed in to LifeOS`}>
                <span className="flex">{lifeosRow}</span>
              </Tip>
            )}
            <CheckRow className="ps-6" label="Outlook and Teams reader" checked={items.reader} disabled={!items.lifeos} onCheckedChange={(on) => set({ reader: on })} />
            <CheckRow label="Folders in Files" checked={items.folders} disabled={workspaces.length === 0} onCheckedChange={(on) => set({ folders: on })} />
            {workspaces.map((w) => (
              <CheckRow
                key={w.id}
                className="ps-6"
                label={w.name}
                checked={chosen.includes(w.id)}
                disabled={!items.folders}
                onCheckedChange={(on) => setChosen((prev) => (on ? [...prev, w.id] : prev.filter((id) => id !== w.id)))}
              />
            ))}
          </div>
        </ChoiceField>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Make the link" pending={pending} disabled={!name.trim()} />
    </form>
  );
}
