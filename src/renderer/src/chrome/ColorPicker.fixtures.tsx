// bun run ui:preview src/renderer/src/chrome/ColorPicker.tsx#ColorPicker --shot --fresh
// Export ColorPicker. Static shots cannot drag the handles or edit the hex value.
import { hsvToHex } from "../lib/colorUtils";

export default [
  { name: "Blue from the map", props: { value: hsvToHex(210, 62, 82), onChange: "fn" } },
  { name: "Gold from the trail sign", props: { value: hsvToHex(40, 73, 92), onChange: "fn" } },
];
