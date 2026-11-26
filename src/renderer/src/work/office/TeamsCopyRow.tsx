import { confirmAction } from "../../chrome/ConfirmDialog";
import { PageRowsSkeleton } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { registry } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import { hostFailure } from "../../lib/hostFailure";
import { settingTitle } from "../../lib/settings/map";
import { inWords } from "../../lib/settings/workWords";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { SettingRow } from "../../surfaces/settings/parts/SettingRow";
import { useSaved } from "../../surfaces/settings/parts/useSaved";
import { useKeptRetry } from "./keptRetry";

/**
 * A job's page, "Computers its threads may use": whether a Teams file on a desktop it may use is copied to the job's
 * own computer to open in a thread's canvas there (docs/agents/work-teams-files.md "Where the files live"). Off by
 * default: Purdue's rule keeps university files where they are, and a file on another computer then opens in its app
 * there. Turning it off deletes the copies, so it asks first. `computer` is the job's computer as it reads mid-line.
 */
export function TeamsCopyRow({ workspace, computer }: { workspace: Pick<WorkspaceMeta, "id" | "environmentId">; computer: string }) {
  const link = registry.linkOf(workspace.environmentId);
  const read = useHostRead(link, () => link.request<{ on: boolean }>("work.office.filesCopyGet", { workspaceId: workspace.id }), workspace.id);
  const saved = useSaved();
  const vars = { computer };
  const kept = useKeptRetry(read.error, read.value === undefined && read.error === null);
  if (!read.value) {
    if (!kept.error) return <PageRowsSkeleton rows={1} description control="switch" />;
    return (
      <SettingRow id="job.copy" vars={vars} error={hostFailure(workspace.environmentId, kept.error, "could not read whether it copies Teams files")}>
        <Button variant="ghost" size="sm" disabled={kept.retrying} onClick={() => kept.press(read.retry)}>
          <BusyLabel busy={kept.retrying} label="Retry" />
        </Button>
      </SettingRow>
    );
  }
  const set = async (on: boolean): Promise<boolean> => {
    if (!on && !(await confirmAction({ title: `Stop copying Teams files to ${computer}?`, body: `The copies on ${computer} are deleted. The files stay in Teams.`, action: "Stop copying", danger: true }))) return false;
    return saved.run(() => inWords(workspace.environmentId, async () => read.set(await link.request<{ on: boolean }>("work.office.filesCopySet", { workspaceId: workspace.id, on }))));
  };
  return (
    <SettingRow id="job.copy" vars={vars} saved={saved} description={`So a thread on ${computer} can open them`}>
      <SettingSwitch label={settingTitle("job.copy", vars)} on={read.value.on} onChange={set} />
    </SettingRow>
  );
}
