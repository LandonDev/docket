import { useState } from "react";
import { PageRow, PageRowsSkeleton } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { registry } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import { hostFailure } from "../../lib/hostFailure";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useKeptRetry } from "./keptRetry";

/**
 * A Work workspace's page, "Where it runs": whether a Teams file on a desktop it may use is copied
 * to the workspace's own host to open in a thread's canvas there (docs/agents/work-teams-files.md "Where
 * the files live"). Off by default: Purdue's rule keeps university files where they are, and a file
 * on another host then opens in its app there.
 */
export function TeamsCopyRow({ workspace, hostName, desktops }: { workspace: Pick<WorkspaceMeta, "id" | "environmentId">; hostName: string; desktops: string[] }) {
  const link = registry.linkOf(workspace.environmentId);
  const read = useHostRead(link, () => link.request<{ on: boolean }>("work.office.filesCopyGet", { workspaceId: workspace.id }), workspace.id);
  const [error, setError] = useState<string | null>(null);
  const title = `Copy Teams files to ${hostName}`;
  const kept = useKeptRetry(read.error, read.value === undefined && read.error === null);
  if (!read.value) {
    if (!kept.error) return <PageRowsSkeleton rows={1} description control="switch" />;
    return (
      <PageRow title={title} error={hostFailure(workspace.environmentId, kept.error, "could not read whether it copies Teams files")}>
        <Button variant="ghost" size="sm" disabled={kept.retrying} onClick={() => kept.press(read.retry)}>
          <BusyLabel busy={kept.retrying} label="Retry" />
        </Button>
      </PageRow>
    );
  }
  const set = async (on: boolean): Promise<void> => {
    setError(null);
    try {
      read.set(await link.request<{ on: boolean }>("work.office.filesCopySet", { workspaceId: workspace.id, on }));
    } catch (err) {
      setError(hostFailure(workspace.environmentId, err, "did not save the change", true));
    }
  };
  return (
    <PageRow title={title} description={read.value.on ? "Copies go with their thread" : `Files open in their app on ${desktops.join(", ")}`} error={error ?? undefined}>
      <SettingSwitch label={title} on={read.value.on} onChange={set} />
    </PageRow>
  );
}
