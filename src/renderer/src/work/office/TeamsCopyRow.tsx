import { useState } from "react";
import { errorText } from "../../chrome/ConfirmDialog";
import { PageRow, PageRowsSkeleton } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { Button } from "../../components/ui/button";
import { registry } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import type { WorkspaceMeta } from "../../lib/tcserver/types";

/**
 * A Work workspace's page, "Where it runs": whether a Teams file on a desktop it may use is copied
 * to the workspace's own host to open in a thread's canvas there (docs/agents/work-files.md "Where
 * the files live"). Off by default: Purdue's rule keeps university files where they are, and a file
 * on another host then opens in its app there.
 */
export function TeamsCopyRow({ workspace, hostName, desktops }: { workspace: Pick<WorkspaceMeta, "id" | "environmentId">; hostName: string; desktops: string[] }) {
  const link = registry.linkOf(workspace.environmentId);
  const read = useHostRead(link, () => link.request<{ on: boolean }>("work.office.filesCopyGet", { workspaceId: workspace.id }), workspace.id);
  const [error, setError] = useState<string | null>(null);
  const title = `Copy Teams files to ${hostName}`;
  if (!read.value) {
    if (!read.error) return <PageRowsSkeleton rows={1} description control="switch" />;
    return (
      <PageRow title={title} error={read.error}>
        <Button variant="ghost" size="sm" onClick={read.retry}>
          Retry
        </Button>
      </PageRow>
    );
  }
  const set = async (on: boolean): Promise<void> => {
    setError(null);
    try {
      read.set(await link.request<{ on: boolean }>("work.office.filesCopySet", { workspaceId: workspace.id, on }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <PageRow title={title} description={read.value.on ? "Copies go with their thread" : `Files open in their app on ${desktops.join(", ")}`} error={error ?? undefined}>
      <SettingSwitch label={title} on={read.value.on} onChange={set} />
    </PageRow>
  );
}
