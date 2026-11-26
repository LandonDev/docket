// bun run ui:preview src/renderer/src/chrome/ModelPicker.preview.tsx#ModelPickerPreview
// ModelPickerPreview draws the real menu for two mock hosts. Choosing a model and search keys need interaction.
import { addPreviewHost, previewNoop } from "../lib/previewHost.preview";
import { registerBuiltinHarnesses } from "../lib/harness/register";
import { ModelPicker } from "./ModelPicker";
import { saveModelPickerTab } from "../lib/models";

registerBuiltinHarnesses();
await addPreviewHost({ id: "preview-models", name: "This computer", answers: { "doctor.get": () => ({ claude: { found: true }, codex: { found: true } }) } });
await addPreviewHost({ id: "preview-no-account", name: "Workshop", answers: { "doctor.get": () => ({ claude: { found: true } }) } });
await addPreviewHost({ id: "preview-no-cli", name: "Studio", answers: { "doctor.get": () => ({ claude: { found: false } }) } });

export function ModelPickerPreview({ missing = false, noAccount = false }: { missing?: boolean; noAccount?: boolean }) {
  saveModelPickerTab("claude");
  return (
    <ModelPicker
      harness="claude" model="claude:opus-5.5" onChange={previewNoop}
      environmentId={missing ? "preview-no-cli" : noAccount ? "preview-no-account" : "preview-models"}
      settings={{ values: { effort: "high" }, onChange: previewNoop }}
    />
  );
}
