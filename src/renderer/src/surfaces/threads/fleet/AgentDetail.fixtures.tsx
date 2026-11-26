// bun run ui:preview src/renderer/src/surfaces/threads/fleet/AgentDetail.fixtures.tsx#AgentDetailPreview --shot --fresh
// Export AgentDetailPreview. The sheet starts settled. Static shots cannot show its slide or steer a live agent.
import { AgentDetail } from "./AgentDetail";
import { fixtureMeta } from "./fleetFixture";
import { previewCwd, seedPreviewThreads } from "../previewThreads";

const noop = () => {};
const agentId = "guide-editor";
const parentId = "guide-master";
const meta = fixtureMeta(agentId, { id: agentId, parentId, environmentId: "local", cwd: previewCwd, title: "Check the route guide", status: "running" });
seedPreviewThreads([meta], {
  [agentId]: {
    blocks: [
      { id: "ask", role: "user", text: "Check the route guide for gaps." },
      { id: "result", role: "assistant", text: "The west trail needs a note about the bridge closure." },
    ],
  },
});

export function AgentDetailPreview({ failed = false }: { failed?: boolean }) {
  return <AgentDetail agentId={agentId} parentCwd={previewCwd} onClose={noop} onOpenSession={noop} initialSettled initialSteer={failed ? { text: "Check the north trail too", failure: "Couldn't steer. Its computer isn't answering." } : undefined} />;
}

export default [
  { name: "Transcript and steer field", props: {} },
  { name: "Steer failure", props: { failed: true } },
];
