import { dialogErrorWords } from "../lib/dialogErrorWords";
import { modOrCtrl } from "../lib/keys";
import { WandSparkles } from "./icons";
import { useRef, useState } from "react";
import { BusyLabel, Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { DialogFooter, ErrorLine } from "./ConfirmDialog";
import { Tip } from "../components/tip";
import { Modal, useModalClose } from "./Modal";
import { Field } from "./DialogField";
import { generateCommitMessage } from "../lib/harness";

type Busy = "stash" | "commit" | null;

type Props = {
  cwd: string;
  branch: string;
  creating?: boolean;
  busy: Busy;
  error?: string | null;
  /** Each resolves true once the switch landed: the dialog plays its exit, then `onSwitched` runs. */
  onStash: () => Promise<boolean>;
  onCommit: (message: string) => Promise<boolean>;
  onSwitched: () => void;
  onCancel: () => void;
};

export function SwitchBranchDialog(props: Props) {
  const [generating, setGenerating] = useState(false);
  return (
    <Modal
      onClose={props.onCancel}
      busy={Boolean(props.busy) || generating}
      title="Uncommitted changes"
      description={`Stash or commit them before ${props.creating ? "creating" : "switching to"} “${props.branch}”.`}
      size="sm"
    >
      <Body {...props} generating={generating} setGenerating={setGenerating} />
    </Modal>
  );
}

function Body({
  cwd,
  busy,
  error,
  onStash,
  onCommit,
  onSwitched,
  onCancel,
  generating,
  setGenerating,
}: Props & { generating: boolean; setGenerating: (on: boolean) => void }) {
  const [message, setMessage] = useState("");
  const [generateError, setGenerateError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const trimmed = message.trim();
  const waiting = Boolean(busy) || generating;
  const canCommit = trimmed.length > 0 && !waiting;
  const close = useModalClose();
  // The verb spins through the exit (busy stays set), so the dialog leaves as Cancel's does.
  const settle = (landed: Promise<boolean>) =>
    void landed.then((ok) => {
      if (ok) (close ?? ((then: () => void) => then()))(onSwitched);
    });
  const commit = () => settle(onCommit(trimmed));

  const generate = async () => {
    if (waiting) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      setMessage(await generateCommitMessage(cwd));
    } catch (err) {
      setGenerateError(dialogErrorWords(err));
    } finally {
      setGenerating(false);
      field.current?.focus();
    }
  };

  return (
    <>
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="relative">
          <Field label="Commit message">
          <Textarea
            ref={field}
            autoFocus
            rows={1}
            value={message}
            disabled={waiting}
            className="max-h-40 min-h-8 resize-none overflow-x-hidden overflow-y-auto py-1.5 pe-9"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (modOrCtrl(event) && event.key === "Enter" && canCommit) {
                event.preventDefault();
                commit();
              }
            }}
          />
          </Field>
          <Tip label="Generate commit message">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Generate commit message"
              disabled={waiting}
              onClick={() => void generate()}
              className="absolute end-1 bottom-1 text-muted-foreground"
            >
              {generating ? <BusyLabel busy label="" /> : <WandSparkles />}
            </Button>
          </Tip>
        </div>
        <ErrorLine error={error || generateError} />
      </div>
      <DialogFooter
        onCancel={onCancel}
        confirmLabel="Stash"
        pending={busy === "stash"}
        busy={waiting && busy !== "stash"}
        onConfirm={() => settle(onStash())}
      >
        <Button variant="secondary" disabled={!canCommit} onClick={commit}>
          <BusyLabel busy={busy === "commit"} label="Commit" />
        </Button>
      </DialogFooter>
    </>
  );
}
