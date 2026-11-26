import { registry } from "../lib/connection";
import { addPreviewHost, previewClick, waitForPreview } from "../lib/previewHost.preview";

const server = {
  key: "env_box/res1",
  environmentId: "env_box",
  title: "Vite dev server",
  sessionId: "t1",
  owner: "Coins page",
  port: { number: 5173, environmentId: "env_box" },
  runId: null,
  resource: { id: "res1", sessionId: "t1" },
  callId: null,
  command: "bun run dev",
  startedAt: 1,
};
export default [
  { name: "a thread's server", props: { server } },
  { name: "a Bun server, picked", props: { server: { ...server, key: "env_box/res2", title: "Bun server", port: { number: 3000, environmentId: "env_box" } }, picked: true, onPick: "fn" } },
  { name: "stopping", props: { server: { ...server, stopping: "" } } },
  {
    name: "a Stop that failed",
    props: { server: { ...server, key: "env_fail/run1", environmentId: "env_fail", runId: "run1", resource: null, port: { number: 5173, environmentId: "env_fail" } } },
    // Stop pressed on a host that answers with its link's raw words: the row says them as a person would.
    prepare: async (container: HTMLElement) => {
      if (!registry.has("env_fail")) {
        await addPreviewHost({ id: "env_fail", name: "The box", answers: { "devServer.stop": () => { throw new Error("devServer.stop: socket closed"); } } });
      }
      previewClick(container, "[data-dev-server] button:not([aria-label])");
      await waitForPreview(() => container.querySelector(".text-destructive"));
    },
  },
];
