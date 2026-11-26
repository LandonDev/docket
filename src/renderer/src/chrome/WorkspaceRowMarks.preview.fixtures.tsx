// bun run ui:preview src/renderer/src/chrome/WorkspaceRowMarks.preview.tsx#WorkspaceRowPreview
// Static capture shows the menus opened through the rail. Choosing an action is DOM-tested.
import { waitForPreview, previewClick, previewCwd } from "../lib/previewHost.preview";

const row = (root: HTMLElement) => waitForPreview(() => root.querySelector<HTMLElement>(`[data-rail-path="${previewCwd}"]`));
export default [
  { name: "Workspace options", props: {}, prepare: async (root: HTMLElement) => previewClick(await row(root), '[aria-label="Workspace options"]') },
  { name: "Threads in the workspace", props: {}, prepare: async (root: HTMLElement) => previewClick(await row(root), 'button[aria-haspopup="dialog"]') },
];
