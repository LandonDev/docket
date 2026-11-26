// bun run ui:preview src/renderer/src/surfaces/NotesView.preview.tsx#NotesPreview
// Static capture includes the selected detail and filtered empty list. Edits need interaction.
import { previewInput, previewNow } from "../lib/previewHost.preview";

export default [
  { name: "Loading notes", props: { state: "loading" } },
  { name: "No notes", props: { state: "empty" } },
  { name: "A note selected", props: {} },
  { name: "No notes match the filter", props: {}, prepare: (root: HTMLElement) => previewInput(root, "Filter notes", "packing list") },
].map((fixture) => ({ ...fixture, now: previewNow }));
