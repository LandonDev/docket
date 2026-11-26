// bun run ui:preview src/renderer/src/chrome/Rail.preview.tsx#RailShipped
// bun run ui:preview src/renderer/src/chrome/Rail.preview.tsx#RailHostAway
// Popup positioning and keyboard focus need interaction.
import { waitForPreview } from "../lib/previewHost.preview";

export const RailShippedFixtures = [{ name: "The rail at its default width", props: {} }];
export const RailHostAwayFixtures = [
  { name: "A workspace on a host with a refused key", props: {} },
  { name: "Hosts menu", props: {}, prepare: async (root: HTMLElement) => (await waitForPreview(() => root.querySelector<HTMLButtonElement>('button[aria-label^="Hosts"]'))).click() },
];
