import { PlanSettingsEditor } from "../../chrome/PlanSettingsFields";
import { ThreadDefaultsEditor } from "../../chrome/ThreadDefaultsDialog";
import { registry } from "../../lib/connection";
import { usePlanSettingsError } from "../../lib/tcserver/plans";
import { useThreadDefaultsError } from "../../lib/tcserver/workspaces";

/**
 * New threads: what every new thread starts with, and what a finished plan's build does. One set on the box. Two reads
 * feed it; when both fail the page says so once, under Start with, and its Retry asks both.
 */
export function ThreadDefaultsPage() {
  const environmentId = registry.primary().environmentId;
  const defaults = useThreadDefaultsError(environmentId, null);
  const plans = usePlanSettingsError(environmentId, null);
  const both = defaults !== null && plans !== null;
  return (
    <>
      <ThreadDefaultsEditor workspaceId={null} alsoRetry={both ? plans.retry : undefined} />
      <PlanSettingsEditor quiet={both} />
    </>
  );
}
