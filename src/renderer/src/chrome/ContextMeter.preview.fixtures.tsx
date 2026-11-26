// bun run ui:preview src/renderer/src/chrome/ContextMeter.preview.tsx#ContextMeterPreview
// Static capture shows the breakdown. Polling and Compact need interaction.
import fixtures from "./ContextMeter.fixtures";

export default fixtures.map(({ name, props: { reading, usage, busy, compacting, compactable } }) => ({
  name,
  props: { reading, usage, busy, compacting, onCompact: compactable ? "fn" : undefined },
}));
