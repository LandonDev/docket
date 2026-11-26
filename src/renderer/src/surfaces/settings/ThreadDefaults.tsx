import { PlanSettingsEditor } from "../../chrome/PlanSettingsFields";
import { ThreadDefaultsEditor } from "../../chrome/ThreadDefaultsDialog";

/** New threads: what every new thread starts with, and what a finished plan's build does. One set on the box. */
export function ThreadDefaultsPage() {
  return (
    <>
      <ThreadDefaultsEditor workspaceId={null} />
      <PlanSettingsEditor />
    </>
  );
}
