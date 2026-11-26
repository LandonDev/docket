// bun run ui:preview src/renderer/src/surfaces/DevServersPane.preview.tsx#LiveDevServers
// Static capture waits for the real xterm log rows. Stop and port forwarding need interaction.
import { waitForPreview } from "../lib/previewHost.preview";

export default [{
  name: "Two live servers with the Notes API console selected",
  props: {},
  prepare: async (root: HTMLElement) => {
    await waitForPreview(() => root.querySelector(".xterm-rows")?.textContent?.includes("Ready for local requests") ? true : null);
  },
}];
