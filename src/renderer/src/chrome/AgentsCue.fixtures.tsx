// bun run ui:preview src/renderer/src/chrome/AgentsCue.fixtures.tsx#AgentsCueNoRoom --shot --fresh
// Export AgentsCueNoRoom. The cue is shown when the panel has no room. Its tooltip needs a live pointer.
import { agentsCue } from "../lib/threads/agents";
import { AgentsCueEndGroup } from "./AgentsCue.preview";

export function AgentsCueNoRoom() {
  return <AgentsCueEndGroup cue={agentsCue({ working: 1, waiting: 1, queued: 0, providers: ["claude", "codex"] }, true)} room={false} />;
}
