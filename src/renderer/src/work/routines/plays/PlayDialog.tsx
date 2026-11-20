import { useState } from "react";
import { PLAY_TAKES, type PlayDraft, type PlayRow, type StarterPlay } from "@shared/contract-work-routines";
import { confirmAction, DialogFooter, ErrorLine } from "../../../chrome/ConfirmDialog";
import { Field } from "../../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../../chrome/Modal";
import { BusyLabel, Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import { registry } from "../../../lib/connection";
import { refusalWords } from "../../../lib/settingsHome";
import { blankPlay, orderedTakes, playFormProblem, TAKE_LABEL, type PlayForm } from "./model";

/** What the dialog writes: a new play, an edit, his Add on a proposal or a starter, or a play saved from a thread. */
export type PlaySource = { kind: "new" } | { kind: "edit"; row: PlayRow } | { kind: "starter"; starter: StarterPlay } | { kind: "thread"; sessionId: string; mayDraft: boolean };

type Props = {
  env: string;
  workspaceId: string;
  source: PlaySource;
  onClose: () => void;
  onSaved?: (row: PlayRow) => void;
};

const titleOf = (source: PlaySource): string =>
  source.kind === "new" ? "New play" : source.kind === "thread" ? "Save as a play" : source.kind === "starter" || source.row.proposed ? "Add play" : "Edit play";

const formOf = (source: PlaySource): PlayForm =>
  source.kind === "edit"
    ? { name: source.row.name, instructions: source.row.instructions, takes: [...source.row.takes] }
    : source.kind === "starter"
      ? { name: source.starter.name, instructions: source.starter.instructions, takes: [...source.starter.takes] }
      : blankPlay();

/**
 * A play's one dialog (docs/agents/work-plays.md): its name, the steps a
 * thread follows and what each start hands it. A proposal or a starter opens
 * filled for him to change before Add; from a thread it opens empty, and
 * Draft from the thread fills it with one model call, made only on that press.
 */
export function PlayDialog(props: Props) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} title={titleOf(props.source)} size="md" busy={pending} data-play-dialog="">
      <Body {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ env, workspaceId, source, onClose, onSaved, pending, setPending }: Props & { pending: boolean; setPending: (p: boolean) => void }) {
  const close = useModalClose();
  const [form, setForm] = useState<PlayForm>(() => formOf(source));
  const [error, setError] = useState<string | null>(null);
  const [other, setOther] = useState<"remove" | "draft" | null>(null);
  const patch = (next: Partial<PlayForm>) => setForm((cur) => ({ ...cur, ...next }));
  const finish = (then: () => void) => (close ? close(then) : then());
  const row = source.kind === "edit" ? source.row : null;
  const link = registry.linkOf(env);

  const save = () => {
    const problem = playFormProblem(form);
    if (problem) return setError(problem);
    setError(null);
    setPending(true);
    const params = {
      ...(row ? { id: row.id } : {}),
      workspaceId,
      name: form.name.trim(),
      instructions: form.instructions.trim(),
      takes: form.takes,
      ...(source.kind === "starter" ? { starter: source.starter.key } : {}),
      ...(source.kind === "thread" ? { madeIn: source.sessionId } : {}),
    };
    link.request<PlayRow>("work.routines.playSave", params).then(
      (saved) => {
        setPending(false);
        finish(() => onSaved?.(saved));
      },
      (err: unknown) => {
        setPending(false);
        setError(refusalWords(err) || "The host refused it");
      },
    );
  };

  // Delete asks first; Not now on a proposal is his answer to it, and asks nothing.
  const remove = async () => {
    if (!row) return;
    if (!row.proposed && !(await confirmAction({ title: `Delete “${row.name}”?`, body: "The threads it started stay.", action: "Delete", danger: true }))) return;
    setOther("remove");
    link.request("work.routines.playRemove", { id: row.id }).then(
      () => finish(() => {}),
      (err: unknown) => {
        setOther(null);
        setError(refusalWords(err) || "The host refused it");
      },
    );
  };

  const draft = () => {
    if (source.kind !== "thread") return;
    setOther("draft");
    setError(null);
    link.request<PlayDraft>("work.routines.playDraft", { sessionId: source.sessionId }).then(
      (d) => {
        setOther(null);
        setForm({ name: d.name, instructions: d.instructions, takes: orderedTakes(d.takes) });
      },
      (err: unknown) => {
        setOther(null);
        setError(refusalWords(err) || "The draft did not come back");
      },
    );
  };

  const drafting = other === "draft";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <ModalBody>
        <Field label="Name">
          <Input autoFocus value={form.name} disabled={drafting} onChange={(e) => patch({ name: e.target.value })} placeholder="Game assignment" autoComplete="off" />
        </Field>
        <Field label="Instructions">
          <Textarea rows={8} value={form.instructions} disabled={drafting} onChange={(e) => patch({ instructions: e.target.value })} placeholder="The steps, in your words" />
        </Field>
        <Field label="Takes" hint="What you hand it at each start">
          <ToggleGroup
            aria-label="Takes"
            multiple
            value={form.takes}
            onValueChange={(next) => patch({ takes: orderedTakes(next as string[]) })}
            disabled={drafting}
            size="xs"
            spacing={0.5}
            className="w-fit rounded-lg border border-input p-0.5"
          >
            {PLAY_TAKES.map((take) => (
              <ToggleGroupItem key={take} value={take} className="px-2">
                {TAKE_LABEL[take]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter
        start={
          row ? (
            <Button type="button" variant="ghost" size="sm" disabled={pending || other !== null} onClick={() => void remove()}>
              <BusyLabel busy={other === "remove"} label={row.proposed ? "Not now" : "Delete"} />
            </Button>
          ) : source.kind === "thread" && source.mayDraft ? (
            <Button type="button" variant="ghost" size="sm" disabled={pending || other !== null} onClick={draft}>
              <BusyLabel busy={drafting} label="Draft from the thread" busyLabel="Drafting…" />
            </Button>
          ) : undefined
        }
        onCancel={onClose}
        confirmLabel={row && !row.proposed ? "Save" : "Add"}
        pending={pending}
        busy={other !== null}
      />
    </form>
  );
}
