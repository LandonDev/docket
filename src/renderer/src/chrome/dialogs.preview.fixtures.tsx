// bun run ui:preview src/renderer/src/chrome/dialogs.preview.tsx#WorkspaceDialogs
// Static capture shows the open dialogs. Confirming a change needs interaction.
import { waitForPreview, previewCwd } from "../lib/previewHost.preview";

function open(label: string) {
  return async (root: HTMLElement) => {
    const trigger = await waitForPreview(() => root.querySelector<HTMLButtonElement>(`[data-rail-path="${previewCwd}"] [aria-label="Workspace options"]`));
    trigger.click();
    const item = await waitForPreview(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent?.trim() === label));
    item.click();
  };
}
export default [
  { name: "Rename workspace", props: {}, prepare: open("Rename…") },
  { name: "Customize workspace", props: {}, prepare: open("Customize…") },
  { name: "Remove workspace", props: {}, prepare: open("Remove…") },
];
