// bun run ui:preview src/renderer/src/surfaces/TranscriptSelectionMenu.tsx#TranscriptSelectionMenu
// Static capture shows the selection actions in place. Positioning, selection and Escape need interaction.
import { menuChunk } from "./chunks";

await menuChunk.load();
export default [
  { name: "Actions for selected prose", props: { selection: { text: "Keep the last page visible", rect: new window.DOMRect(20, 40, 200, 20) }, onAddToChat: "fn", onDismiss: "fn" } },
];
