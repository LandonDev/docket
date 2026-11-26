// bun run ui:preview src/renderer/src/surfaces/transcript/TurnEnd.preview.tsx#PendingTurnEnd
// This capture waits for the closing words. Transition timing is covered by the DOM test.
import { waitForPreview } from "../../lib/previewHost.preview";

export default [{
  name: "Worked, waiting for the time",
  props: {},
  prepare: async (root: HTMLElement) => {
    await waitForPreview(() => root.textContent?.includes("Worked") ? true : null);
  },
}];
