// bun run ui:preview src/renderer/src/surfaces/AgentTranscript.preview.tsx#AgentTranscriptPreview
// Static capture shows the settled rows and an offline thread. Scroll anchoring and live reveal have DOM tests.
import { waitForPreview } from "../lib/previewHost.preview";

export default [
  { name: "Two settled turns", props: {} },
  { name: "The studio is offline", props: { away: true } },
  { name: "Earlier messages on the host", props: { history: true } },
  {
    name: "Earlier messages requested",
    props: { history: true },
    prepare: async (root: HTMLElement) => {
      const button = await waitForPreview(() => root.querySelector<HTMLButtonElement>('[data-row="more"] button'));
      button.click();
    },
  },
];
