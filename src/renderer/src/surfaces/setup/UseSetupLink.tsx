import { dialogErrorWords } from "../../lib/dialogErrorWords";
import { useCallback, useEffect, useState } from "react";
import type { SetupPeek, SetupState, SetupStep, SetupStepRow } from "@server/shared/contract-devices";
import { PageRow } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { StatusMark } from "../../components/ui/status";
import { DialogFooter } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { giveSetupFolders, onDevicesPush, peekSetupLink, readSetupState, retrySetupStep, startSetup, type StepPush } from "../../lib/devicesClient";
import { pickFolders } from "../../lib/fs";
import { thisDesktopInLine, thisDesktopName } from "../../lib/native";
import { applyPlaceScheme } from "../../lib/placeScheme";
import { allDone, givesText, landStep, stepTitle } from "../settings/hosts/computersText";
import { hostOf, stepReasonWords, writeSeedsOnce } from "./setupFlow";

/**
 * The computer's side of a setup link (docs/agents/pc-setup.md "On the PC"):
 * paste the link, see who gives what from where, Set up this PC, then each
 * step until Ready. The first screen of a fresh install, and Settings →
 * Hosts → Use a setup link…. The link stays in this component's state, and
 * only until the setup starts.
 */

type Phase = { at: "paste" } | { at: "confirm"; link: string; peek: SetupPeek } | { at: "steps"; state: SetupState };

export interface UseSetupLinkProps {
  onClose: () => void;
  /** The first screen of a fresh install: its way out is Skip. */
  first?: boolean;
  /** Where it opens (ui:preview's fixtures; a setup under way opens on its steps). */
  phase?: Phase;
}

/** A step pushed over the one on file. */
const land = (state: SetupState, { words, ...row }: StepPush): SetupState => ({
  ...state,
  steps: landStep(state.steps, row),
  ...(words ? { words } : {}),
});

export function UseSetupLinkDialog(props: UseSetupLinkProps) {
  const { title, pending, at, body } = useSetupLink(props);
  return (
    <Modal onClose={props.onClose} busy={pending} title={title} size="sm" data-setup-link={at}>
      {body}
    </Modal>
  );
}

/** The flow's title, wait and body, apart from its frame (UseSetupLink.preview.tsx draws it in the Modal's box). */
export function useSetupLink({ onClose, first = false, phase: initial }: UseSetupLinkProps) {
  const [phase, setPhase] = useState<Phase>(initial ?? { at: "paste" });
  const [pending, setPending] = useState(false);
  const steps = phase.at === "steps" ? phase.state.steps : [];
  // The host says done; steps that landed by push since its last answer say it too.
  const ready = phase.at === "steps" && (phase.state.done || allDone(steps));

  // Once under way: each step as it moves, and the state read again on a push it cannot place.
  const reread = useCallback(async () => {
    const state = await readSetupState().catch(() => null);
    if (state) setPhase({ at: "steps", state });
  }, []);
  useEffect(() => {
    if (phase.at !== "steps") return;
    return onDevicesPush({ step: (step) => setPhase((p) => (p.at === "steps" ? { at: "steps", state: land(p.state, step) } : p)) });
  }, [phase.at]);
  // The seeds land once, the first time the state carries them.
  const seeds = phase.at === "steps" ? phase.state.seeds : null;
  useEffect(() => {
    if (writeSeedsOnce(seeds)) applyPlaceScheme();
  }, [seeds]);

  const here = thisDesktopName();
  const title = phase.at === "steps" ? (ready ? "Ready" : `Setting up ${thisDesktopInLine()}`) : "Use a setup link";
  const body =
    phase.at === "paste" ? (
      <Paste
        first={first}
        onClose={onClose}
        pending={pending}
        setPending={setPending}
        onPeek={(link, peek) => setPhase({ at: "confirm", link, peek })}
      />
    ) : phase.at === "confirm" ? (
      <Confirm
        link={phase.link}
        peek={phase.peek}
        onClose={onClose}
        pending={pending}
        setPending={setPending}
        verb={`Set up ${thisDesktopInLine()}`}
        onStarted={(state) => setPhase({ at: "steps", state })}
      />
    ) : ready ? (
      <Ready line={`${here} has everything ${phase.state.giver} gave it.`} onClose={onClose} />
    ) : (
      <Steps state={phase.state} steps={steps} onClose={onClose} onReread={reread} />
    );
  return { title, pending, at: phase.at, body };
}

function Paste({
  first,
  onClose,
  pending,
  setPending,
  onPeek,
}: {
  first: boolean;
  onClose: () => void;
  pending: boolean;
  setPending: (on: boolean) => void;
  onPeek: (link: string, peek: SetupPeek) => void;
}) {
  const close = useModalClose();
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const go = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      onPeek(link.trim(), await peekSetupLink(link.trim()));
    } catch (err) {
      setError(dialogErrorWords(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (link.trim() && !pending) void go();
      }}
    >
      <ModalBody>
        <Field label="Paste the link from your Mac" error={error}>
          <Input
            data-setup-field
            value={link}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setLink(e.target.value);
              setError(null);
            }}
            className="font-mono text-xs"
          />
        </Field>
      </ModalBody>
      <DialogFooter pending={pending} confirmLabel="Continue" disabled={!link.trim()}>
        {/* The first screen's way on without a link; elsewhere it is Cancel. */}
        <Button data-setup-skip variant="secondary" disabled={pending} onClick={() => (close ? close(onClose) : onClose())}>
          {first ? "Skip" : "Cancel"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Confirm({
  link,
  peek,
  verb,
  onClose,
  pending,
  setPending,
  onStarted,
}: {
  link: string;
  peek: SetupPeek;
  verb: string;
  onClose: () => void;
  pending: boolean;
  setPending: (on: boolean) => void;
  onStarted: (state: SetupState) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const start = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await startSetup(link);
      // The steps begin from what the host has; before its first word, from the peek.
      onStarted((await readSetupState()) ?? { giver: peek.giver, origin: peek.origin, steps: [{ step: "link", state: "working" }], words: null, seeds: null, done: false });
    } catch (err) {
      setError(dialogErrorWords(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <ModalBody>
        <p data-setup-gives className="text-[13px] text-foreground">
          From <span className="font-medium">{peek.giver}</span> at <span className="font-medium">{hostOf(peek.origin)}</span>: {givesText(peek.items)}
        </p>
        {error ? <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel={verb} pending={pending} onConfirm={() => void start()} />
    </>
  );
}

/** A step's mark: waiting muted, working spinning, done, failed in red. Allow waits on him at the Mac, so it waits in amber. */
function StepMark({ step }: { step: SetupStepRow }) {
  if (step.state === "working") return <StatusMark state="working" />;
  if (step.state === "done") return <StatusMark state="done" />;
  if (step.state === "failed") return <StatusMark state="failed" />;
  // The glyph alone: a row's title already says what it waits for.
  return <StatusMark state={step.step === "allow" ? "waiting" : "queued"} word={false} />;
}

function Steps({ state, steps, onClose, onReread }: { state: SetupState; steps: SetupStepRow[]; onClose: () => void; onReread: () => Promise<void> }) {
  const [busy, setBusy] = useState<SetupStep | null>(null);
  const [errors, setErrors] = useState<Partial<Record<SetupStep, string>>>({});
  const run = async (step: SetupStep, work: () => Promise<unknown>): Promise<void> => {
    setBusy(step);
    setErrors(({ [step]: _gone, ...rest }) => rest);
    try {
      await work();
      await onReread();
    } catch (err) {
      setErrors((prev) => ({ ...prev, [step]: dialogErrorWords(err) }));
    } finally {
      setBusy(null);
    }
  };
  // His pick goes once the giver allowed this computer: before that there is nothing to show the folders in.
  const allowed = steps.some((s) => s.step === "allow" && s.state === "done");
  const addFolders = async (): Promise<void> => {
    const paths = await pickFolders("Folders for Files");
    if (paths) await giveSetupFolders(paths);
  };
  return (
    <>
      <ModalBody className="gap-0 py-1">
        {steps.map((step) => (
          <PageRow
            key={step.step}
            data-setup-step={step.step}
            data-state={step.state}
            title={stepTitle(step.step, state.giver)}
            description={step.step === "allow" && state.words && step.state !== "done" ? <span data-setup-words className="font-medium text-foreground">{state.words.join(" · ")}</span> : undefined}
            error={errors[step.step] ?? (step.state === "failed" ? stepReasonWords(step.reason) : undefined)}
          >
            {/* One button weight in the list: Retry and Add folders… are both secondary. */}
            {step.state === "failed" ? (
              <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void run(step.step, () => retrySetupStep(step.step))}>
                <BusyLabel busy={busy === step.step} label="Retry" />
              </Button>
            ) : step.step === "folders" && step.state === "waiting" && allowed ? (
              <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void run("folders", addFolders)}>
                <BusyLabel busy={busy === "folders"} label="Add folders…" />
              </Button>
            ) : (
              <StepMark step={step} />
            )}
          </PageRow>
        ))}
      </ModalBody>
      <DialogFooter confirmLabel="Close" closeOnConfirm onConfirm={onClose} />
    </>
  );
}

function Ready({ line, onClose }: { line: string; onClose: () => void }) {
  return (
    <>
      <ModalBody>
        <p data-setup-ready className="text-[13px] text-foreground">
          {line}
        </p>
      </ModalBody>
      <DialogFooter confirmLabel="Done" closeOnConfirm onConfirm={onClose} />
    </>
  );
}
