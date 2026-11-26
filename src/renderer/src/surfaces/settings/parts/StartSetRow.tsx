import { useState } from "react";
import { AS_LAST_READ, ThreadDefaultsDialog } from "../../../chrome/ThreadDefaultsDialog";
import { PageRowsSkeleton } from "../../../components/page";
import { Button } from "../../../components/ui/button";
import { EFFORT_LABELS, PERMISSION_LABELS, effortLadder, modelForDefaults, type DefaultsScope } from "../../../lib/tcserver/defaults";
import type { WorkspaceMeta } from "../../../lib/tcserver/types";
import { useThreadDefaults, useThreadDefaultsError, useThreadDefaultsStale } from "../../../lib/tcserver/workspaces";
import { ReadFailure } from "./ReadFailure";
import { SettingRow } from "./SettingRow";

/**
 * What a job's or a code workspace's new threads start with, values in force and whose they are: "Set for this job: …"
 * when it keeps its own, "Same as New threads: …" when it follows the set every computer reads. The model, its effort
 * where it has a ladder, and the access by its own name.
 */
export function startSetWords(scope: DefaultsScope, whose: "job" | "workspace", environmentId?: string): string {
  const model = modelForDefaults(scope.defaults, environmentId);
  const parts = [model.name];
  if (effortLadder(model).length > 1) parts.push(EFFORT_LABELS[scope.defaults.reasoning]);
  // Access keeps its own capitals inside the sentence: "Full access", "Auto-accept edits".
  parts.push(PERMISSION_LABELS[scope.defaults.permission]);
  return `${scope.overridden ? `Set for this ${whose}` : "Same as New threads"}: ${parts.join(", ")}`;
}

/**
 * The page's New threads row (`job.threads`, `ws.threads`): the summary, and Change… opening the start set's dialog
 * (chrome/ThreadDefaultsDialog.tsx). A key that may not set it (`may`) reads the summary alone. While the set is read the
 * row waits in its shape; a failed read is the section's red line with Retry. After Use New threads the store holds no
 * guess until the place is read again (`saveDefaults`), so the row waits, or says that read's failure, and the dialog
 * stays open meanwhile. A refresh that fails over a held answer keeps the summary, marked "(as last read)", and says the
 * failure with Retry.
 */
export function StartSetRow({ id, workspace, whose, may }: { id: "job.threads" | "ws.threads"; workspace: WorkspaceMeta; whose: "job" | "workspace"; may: boolean }) {
  const scope = useThreadDefaults(workspace.environmentId, workspace.id, true);
  const failure = useThreadDefaultsError(workspace.environmentId, workspace.id);
  // A refresh that failed over a held answer: the summary stays, marked as last read, the failure said with Retry.
  const stale = useThreadDefaultsStale(workspace.environmentId, workspace.id);
  const [open, setOpen] = useState(false);
  const dialog = open ? <ThreadDefaultsDialog workspace={workspace} onClose={() => setOpen(false)} /> : null;
  return (
    <>
      {scope && stale ? <ReadFailure computer={workspace.environmentId} error={stale.error} retry={stale.retry} /> : null}
      {scope ? (
        <SettingRow id={id} description={stale ? `${startSetWords(scope, whose, workspace.environmentId)} (${AS_LAST_READ.toLowerCase()})` : startSetWords(scope, whose, workspace.environmentId)}>
          {may ? (
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
              Change…
            </Button>
          ) : null}
        </SettingRow>
      ) : failure ? (
        <ReadFailure computer={workspace.environmentId} error={failure.error} retry={failure.retry} />
      ) : (
        <PageRowsSkeleton rows={[{ description: true, control: may ? "button" : "none" }]} />
      )}
      {dialog}
    </>
  );
}
