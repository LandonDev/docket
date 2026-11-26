// bun run ui:preview src/renderer/src/chrome/ModelPicker.preview.tsx#ModelPickerPreview
// Static capture opens the picker. Search and choosing a model are covered by DOM tests.
import { previewClick } from "../lib/previewHost.preview";

const prepare = (root: HTMLElement) => previewClick(root, 'button[aria-keyshortcuts]');
export default [
  { name: "Model menu open", props: {}, prepare },
  { name: "Harness unavailable", props: { missing: true }, prepare },
  { name: "No provider account", props: { noAccount: true }, prepare },
  { name: "A new profile, no star: the current model's provider", props: { fresh: true }, prepare },
];
