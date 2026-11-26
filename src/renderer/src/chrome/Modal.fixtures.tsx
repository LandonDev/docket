// bun run ui:preview src/renderer/src/chrome/Modal.fixtures.tsx#FormDialog --shot --fresh
// Exports FormDialog, FailedConfirm and ModalComparison. The harness opens each popup in a static window;
// focus, Escape and exit motion need a DOM test.
import { useEffect } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { ConfirmDialog, DialogFooter } from "./ConfirmDialog";
import { CheckRow, Field, FieldRow } from "./DialogField";
import { Modal, ModalBody } from "./Modal";

const noop = () => {};

export function FormDialog() {
  return (
    <Modal title="Workspace options" onClose={noop} busy>
      <ModalBody>
        <Field label="Name"><Input defaultValue="Field guide" /></Field>
        <FieldRow label="Keep history"><Switch defaultChecked /></FieldRow>
        <CheckRow label="Keep a local copy" checked onCheckedChange={noop} />
      </ModalBody>
      <DialogFooter start={<Button variant="ghost" size="sm">Clear</Button>} note="Saved on the box" onCancel={noop} confirmLabel="Save" busyLabel="Saving…" pending onConfirm={noop} />
    </Modal>
  );
}

export function FailedConfirm() {
  useEffect(() => {
    const timer = setTimeout(() => document.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-content"] [data-slot="alert-dialog-action"]')?.click(), 20);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div>
      <ConfirmDialog title="Delete Field guide?" body="Its threads will be deleted." note="The files on disk stay." confirmLabel="Delete workspace" danger onCancel={noop} onDone={noop} onConfirm={async () => { throw new Error("The box did not answer. Try again."); }} />
    </div>
  );
}


export function ModalComparison() {
  return <div data-preview-stage data-preview-dialog-grid><FormDialog /><FailedConfirm /></div>;
}
