// bun run ui:preview src/renderer/src/chrome/ThreadMenu.fixtures.tsx#PanelToggleGallery --shot --fresh
// Export PanelToggleGallery. The real toggle shows pressed and no-room states; the panel stays in place.
import { AgentsCueEndGroup } from "./AgentsCue.preview";

export function PanelToggleGallery() {
  return (
    <div className="flex flex-col gap-2">
      <AgentsCueEndGroup cue={null} />
      <AgentsCueEndGroup cue={null} pressed />
      <AgentsCueEndGroup cue={null} room={false} />
    </div>
  );
}
