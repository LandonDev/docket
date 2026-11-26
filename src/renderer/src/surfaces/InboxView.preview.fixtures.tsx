// bun run ui:preview src/renderer/src/surfaces/InboxView.preview.tsx#InboxPreview
// Static capture includes the real selection and filter. Fetch and keyboard navigation need interaction.
import { previewNow, previewInput, waitForPreview } from "../lib/previewHost.preview";

export default [
  { name: "Loading the inbox", props: { state: "loading" } },
  { name: "Empty inbox", props: { state: "empty" } },
  {
    name: "Issues from two hosts, one selected", props: {},
    prepare: async (root: HTMLElement) => {
      const row = await waitForPreview(() => root.querySelector<HTMLElement>('ul[aria-label="Inbox items"] button'));
      row.click();
    },
  },
  {
    name: "No issues match the filter", props: {},
    prepare: async (root: HTMLElement) => {
      await waitForPreview(() => root.querySelector('ul[aria-label="Inbox items"] button'));
      previewInput(root, "Filter inbox", "packing list");
    },
  },
].map((fixture) => ({ ...fixture, now: previewNow }));
