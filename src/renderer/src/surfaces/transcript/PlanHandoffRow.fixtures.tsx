// bun run ui:preview src/renderer/src/surfaces/transcript/PlanHandoffRow.tsx#PlanHandoffRow
// Static capture shows the handoff line. Opening the build is covered by its DOM test.
import type { Block } from "../../lib/session";

export default [
  { name: "Build started by the agent", props: { block: { id: "preview-plan", role: "system", text: "", planHandoff: { id: "preview-build", title: "Build the batch export", how: "auto" } } satisfies Block } },
  { name: "Build started by the person", props: { block: { id: "preview-picked-plan", role: "system", text: "", planHandoff: { id: "preview-build", title: "Build the batch export", how: "manual" } } satisfies Block } },
];
