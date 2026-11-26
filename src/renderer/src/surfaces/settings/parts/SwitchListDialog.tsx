import type { ReactNode } from "react";
import { DialogFooter } from "../../../chrome/ConfirmDialog";
import { FieldRow } from "../../../chrome/DialogField";
import { Modal, ModalBody } from "../../../chrome/Modal";
import { SettingSwitch } from "../../../components/setting-switch";

export type SwitchListItem = { id: string; label: string; media?: ReactNode; description?: string; on: boolean };

/**
 * A row's list of on and off choices, opened from it (the model picker's agent apps, Linear's teams): a switch per
 * item that saves as it flips, so the footer has Done alone. `body` stands in for the list while it loads or fails.
 */
export function SwitchListDialog({
  title,
  items,
  body,
  onChange,
  onClose,
}: {
  title: string;
  items: readonly SwitchListItem[];
  body?: ReactNode;
  onChange: (id: string, on: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} size="sm" onClose={onClose}>
      <ModalBody className="gap-0">
        {body ??
          items.map((item) => (
            <FieldRow
              key={item.id}
              description={item.description}
              label={
                <span className="flex min-w-0 items-center gap-2">
                  {item.media}
                  <span className="truncate">{item.label}</span>
                </span>
              }
            >
              <SettingSwitch label={item.label} on={item.on} onChange={(on) => onChange(item.id, on)} />
            </FieldRow>
          ))}
      </ModalBody>
      <DialogFooter confirmLabel="Done" closeOnConfirm onConfirm={onClose} />
    </Modal>
  );
}
