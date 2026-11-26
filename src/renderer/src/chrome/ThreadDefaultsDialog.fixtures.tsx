// bun run ui:preview src/renderer/src/chrome/ThreadDefaultsDialog.fixtures.tsx#ThreadDefaultsPreview --shot --fresh
// Export ThreadDefaultsPreview. Host replies are fixed and no settings are saved.
import { DEFAULT_THREAD_DEFAULTS } from "@server/shared/defaults";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { answerAs } from "../work/kit.preview";
import { ThreadDefaultsDialog } from "./ThreadDefaultsDialog";
import { guideWorkspace, ignorePreviewAction as noop, previewPending } from "./previewDialogData";

const workspaces = ["loading", "failed", "overridden", "following"].map((id) => ({ ...guideWorkspace, id }));
const link = answerAs((method, params) => {
  if (method === "workspace.list") return workspaces;
  if (method === "project.list") return [];
  if (method !== "defaults.get") return null;
  if (params.workspaceId === "loading") return previewPending;
  if (params.workspaceId === "failed") throw new Error("The box did not answer.");
  return { defaults: DEFAULT_THREAD_DEFAULTS, overridden: params.workspaceId === "overridden" };
});
workspaceStore.hydrate([{ environmentId: "local", workspaces, projects: [] }]);
workspaceStore.attach(link);

export function ThreadDefaultsPreview({ index = 0 }: { index?: number }) {
  return <ThreadDefaultsDialog workspace={workspaces[index]} onClose={noop} />;
}

export default workspaces.map(({ id: name }, index) => ({ name, props: { index } }));
