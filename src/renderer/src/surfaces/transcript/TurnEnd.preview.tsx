// bun run ui:preview src/renderer/src/surfaces/transcript/TurnEnd.preview.tsx#PendingTurnEnd
// PendingTurnEnd captures the just-settled line before its time arrives. The transition is DOM-tested.
import { useEffect, useState } from "react";
import type { Block } from "../../lib/session";
import { TurnEnd } from "./TurnEnd";

const user: Block = { id: "preview-pending-user", role: "user", text: "Check the cache" };
const response: Block = { id: "preview-pending-response", role: "assistant", text: "The cache selects the most recent page." };

export function PendingTurnEnd() {
  const [settled, setSettled] = useState(false);
  useEffect(() => setSettled(true), []);
  return <TurnEnd
    turn={{ id: user.id, index: 0, isLast: true, settled, blocks: [user, response], userBlock: user, durationMs: undefined, startedAt: undefined }}
    liveState={false} turnState={null} harnessOf={() => "claude"}
  />;
}
