import { useRef, useState } from "react";
import type { CanvasSource } from "@shared/work/canvas";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { CheckRow, Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Input } from "../../components/ui/input";
import { loadToast } from "../../components/ui/toaster";
import { openWorkView } from "../../lib/workSwitch";
import { TEMPLATES_ROW } from "../views/registry";
import { saveTemplate } from "./data";
import { asksLine, baseName, stemOf } from "./model";

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
 * name, filled with the file's and selected, and whether it is for all jobs.
 * The fields a template asks for are known to a caller that listed it (`fields`)
 * and, for any file, from the host's answer: the dialog names them when it was
 * given them, else the toast that says it was saved does. Show opens the shelf.
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
  const [value, setValue] = useState(() => name ?? (source.at === "file" ? stemOf(baseName(source.path)) : ""));
  const [everywhere, setEverywhere] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = useRef(false);
  const said = fields ? asksLine(fields) : null;

  const save = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const saved = await saveTemplate(env, workspaceId, source, { ...(value.trim() ? { name: value.trim() } : {}), everywhere });
      const toast = await loadToast();
      // The fields, said once: here when the dialog did not already name them.
      const asks = said ? null : asksLine(saved.fields);
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
        <Field label="Name" hint={said}>
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
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <CheckRow label="All jobs" checked={everywhere} disabled={pending} onCheckedChange={setEverywhere} />
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} />
    </form>
  );
}
