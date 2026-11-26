import { PlanSettingsEditor } from "../../chrome/PlanSettingsFields";
import { ThreadDefaultsEditor } from "../../chrome/ThreadDefaultsDialog";
import { registry } from "../../lib/connection";
import { usePlanSettingsError } from "../../lib/tcserver/plans";
import { useThreadDefaultsError } from "../../lib/tcserver/workspaces";
import { useLinkMay } from "../../lib/linkMay";
import { useComputerName } from "../../lib/settings/computerName";
import { ManagedLine } from "./parts/ManagedLine";
import { usePageHome } from "../../lib/settings/pageHome";

/**
 * New threads: what every new thread starts with, and what a finished plan's build does. One set on the box. Two reads
 * feed it, both of this window's computer; when both fail the page says so once, under Start with (`ReadFailure`),
 * its Retry asks both, and Builds from plans draws nothing, not even its heading.
 */
export function ThreadDefaultsPage() {
  const environmentId = registry.primary().environmentId;
  const defaults = useThreadDefaultsError(environmentId, null);
  const plans = usePlanSettingsError(environmentId, null);
  const both = defaults !== null && plans !== null;
  // A key that may read but not change either set sees words, and once on the page who can change them.
  const mayDefaults = useLinkMay(environmentId, "defaults.set", { workspaceId: null, defaults: null });
  const mayPlans = useLinkMay(environmentId, "plans.set", { projectId: null, settings: null });
  const computer = useComputerName(environmentId);
  // Who can change the set: the computer that keeps it (the box, when the page says so), else this one.
  const home = usePageHome("defaults");
  return (
    <>
      <ThreadDefaultsEditor workspaceId={null} />
      <PlanSettingsEditor quiet={both} />
      {mayDefaults && mayPlans ? null : <ManagedLine computer={home?.name ?? computer.name} />}
    </>
  );
}
