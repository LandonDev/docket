import { useEffect, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { projectSessionCount } from "../lib/projectData";
import { Skeleton } from "../components/ui/skeleton";

type Props = {
  name: string;
  path: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  /** The removal landed and the confirm's exit played: the parent clears its state. */
  onDone: () => void;
};

/** The cost, said once counted: how many threads go with it. */
export function removeProjectNote(sessions: number): string {
  if (sessions === 0) return "It has no threads.";
  return sessions === 1 ? "Its thread is deleted." : `Its ${sessions} threads are deleted.`;
}

/**
 * Removing drops the workspace from the rail along with its projects and
 * threads on the server. Files and worktrees on disk are left alone; opening
 * the folder again brings the workspace back empty.
 */
export function RemoveProjectDialog({ name, path, onCancel, onConfirm, onDone }: Props) {
  const [sessions, setSessions] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void projectSessionCount(path).then((count) => {
      if (!cancelled) setSessions(count);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <ConfirmDialog
      title={`Remove “${name}”?`}
      body="Files on disk stay."
      // The count's line is held by a bone of its size until it lands, and Remove waits for it: the dialog never reflows, and never removes before it says what goes.
      note={sessions === null ? <Skeleton data-remove-count className="h-5 w-44" /> : removeProjectNote(sessions)}
      holding={sessions === null}
      confirmLabel="Remove"
      danger
      onCancel={onCancel}
      onConfirm={onConfirm}
      onDone={onDone}
    />
  );
}
