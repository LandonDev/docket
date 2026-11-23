import { useEffect, useRef, useState } from "react";
import type { CanvasSource } from "@shared/work/canvas";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { CheckRow, Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Input } from "../../components/ui/input";
import { loadToast } from "../../components/ui/toaster";
import { openWorkView } from "../../lib/workSwitch";
import { TEMPLATES_ROW } from "../views/registry";
import { fieldsOfFile, saveTemplate } from "./data";
import { asksLine, sourceStem } from "./model";

type SaveProps = {
  env: string;
  workspaceId: string;
  source: CanvasSource;
  name?: string;
  fields?: readonly string[];
  onClose: () => void;
};

/**
 * "Save as template" (docs/agents/work-templates.md "Save as template"): the
 * name, filled with the file's stem and selected, and whether it is used in all
 * jobs. The footer's quiet note names the fields the template will ask for: the
 * caller's `fields` when it listed them, else the host's read of the file
 * (`work.templates.fields`), asked as the dialog opens; no note for a file with
 * none, nor for our own sheet, whose fields only the save knows (`later`). A
 * blank name stays in the form with its error, and a refusal is read out. The
 * toast that says it was saved names the fields only when the dialog could not;
 * Show opens the shelf.
 */
export function SaveDialog(props: SaveProps) {
  const [pending, setPending] = useState(false);
  return (
    <Modal title="Save as template" size="sm" busy={pending} onClose={props.onClose} data-template-save="">
      <SaveForm {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

export function SaveForm({ env, workspaceId, source, name, fields, onClose, pending, setPending }: SaveProps & { pending: boolean; setPending: (on: boolean) => void }) {
  const close = useModalClose();
  const [value, setValue] = useState(() => name ?? sourceStem(source));
  const [everywhere, setEverywhere] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The fields: the caller's, else the host's read; undefined while it is asked, when it did not answer, and for
  // our own sheet, whose fields are known only from the save's answer (`later`).
  const [read, setRead] = useState<readonly string[] | undefined>(fields);
  const selected = useRef(false);
  const sourceKey = JSON.stringify(source);
  useEffect(() => {
    if (fields) return;
    let live = true;
    fieldsOfFile(env, workspaceId, source).then(
      (found) => live && !found.later && setRead(found.fields),
      () => {},
    );
    return () => {
      live = false;
    };
    // The source by its value: a caller's new object for the same file asks nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, workspaceId, sourceKey, fields]);
  const said = read ? asksLine(read) : null;

  const save = async () => {
    if (pending) return;
    const typed = value.trim();
    if (!typed) return setNameError("A template needs a name");
    setPending(true);
    setError(null);
    try {
      const saved = await saveTemplate(env, workspaceId, source, { name: typed, everywhere });
      const toast = await loadToast();
      // The fields, said once: in the toast only when the dialog could not say them.
      const asks = read ? null : asksLine(saved.fields);
      toast.success("Saved to Templates", {
        ...(asks ? { description: asks } : {}),
        ...(TEMPLATES_ROW ? { action: { label: "Show", onClick: () => openWorkView({ workspaceId, view: "templates" }) } } : {}),
      });
      setPending(false);
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setPending(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <ModalBody>
        <Field label="Name" error={nameError}>
          <Input
            autoFocus
            value={value}
            readOnly={pending}
            spellCheck={false}
            onFocus={(event) => {
              if (selected.current) return;
              selected.current = true;
              event.currentTarget.select();
            }}
            onChange={(event) => {
              setValue(event.target.value);
              setNameError(null);
            }}
          />
        </Field>
        <CheckRow label="Use in all jobs" checked={everywhere} disabled={pending} onCheckedChange={setEverywhere} />
        {/* Read out as it lands, as the fields' refusal is. */}
        <div role="alert" className="contents">
          <ErrorLine error={error} />
        </div>
      </ModalBody>
      {/* The fields are the file's, said in the footer's quiet slot ("Kept in" stands there in New), so nothing moves when the read answers. */}
      <DialogFooter note={said ? <span data-asks="">{said}</span> : undefined} onCancel={onClose} confirmLabel="Save" pending={pending} />
    </form>
  );
}
