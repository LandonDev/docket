import type { SessionStatus } from "../lib/tcserver/types";
import { ConfirmDialog } from "./ConfirmDialog";

/** The delete confirm's one line: a thread still at work stops first, a
 *  queued one never starts. */
export function deleteBody(status: SessionStatus | undefined): string {
  const live = status === "running" || status === "starting" || status === "waiting" || status === "watching" || status === "paused";
  if (live) return "It stops first, and its transcript is gone for good.";
  if (status === "queued") return "It leaves the queue unstarted, and its transcript is gone for good.";
  return "Its transcript is gone for good.";
}

/** The one confirm a thread's delete asks, wherever it starts: the thread
 *  menu's dialog and the app's own delete (App.tsx `confirmAction`). */
export function deleteThreadWords(title: string, status: SessionStatus | undefined): { title: string; body: string; action: string } {
  return { title: `Delete ${title}?`, body: deleteBody(status), action: "Delete thread" };
}

/** A thread menu's Delete… (chrome/useThreadMenu.tsx), in the dialogs chunk:
 *  it names the thread and says what happens to one still at work. */
export function DeleteThreadDialog({
  title,
  status,
  onCancel,
  onConfirm,
  onDone,
}: {
  title: string;
  status: SessionStatus | undefined;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  /** The delete landed: runs once the dialog's exit has played. */
  onDone: () => void;
}) {
  const words = deleteThreadWords(title, status);
  return (
    <ConfirmDialog
      title={words.title}
      body={words.body}
      confirmLabel={words.action}
      danger
      onCancel={onCancel}
      onConfirm={onConfirm}
      onDone={onDone}
    />
  );
}
