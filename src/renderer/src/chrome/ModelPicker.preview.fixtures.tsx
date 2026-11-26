// bun run ui:preview src/renderer/src/chrome/ModelPicker.preview.tsx#ModelPickerPreview
// Static capture opens the picker. Search and choosing a model are covered by DOM tests.
import { previewClick } from "../lib/previewHost.preview";

const prepare = (root: HTMLElement) => previewClick(root, 'button[aria-keyshortcuts]');
export default [
  { name: "Model menu open", props: {}, prepare },
  { name: "Harness unavailable", props: { missing: true }, prepare },
  { name: "No provider account", props: { noAccount: true }, prepare },
];
