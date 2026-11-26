import { AnimatePresence } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { taskTitle, useAgents } from "../../lib/threads/agents";
import { OpenAgentDetailContext } from "../agentDetailContext";
import type { Block } from "../../lib/session";
import { ChatFooter, ColumnBand, chatOf } from "./chatSlots";
import { AgentDetail } from "./fleet/AgentDetail";
import { FleetHeader } from "./fleet/FleetHeader";
import type { ThreadViewProps } from "./ThreadView";
import type { OutlinePlacement } from "../transcriptOutlineModel";

/**
 * Orchestration thread: the chat, under a header with the goal and one
 * sentence of what the agents are doing. The agents themselves are rows in
 * the right panel's Agents section; a spawn row in the transcript opens the
 * agent's detail over the pane. The header sits on the transcript's column
 * (`ColumnBand`, as the composer does), after the message list while it is
 * beside and open.
 */

/** The header's goal: the newest user line (its first line), else the
 *  first brief's title; none while it is the newest bubble's whole text,
 *  which the transcript shows right under the header ("yes, go on"). */
export function orchestrationGoal(blocks: readonly Block[]): string {
  const last = [...blocks].reverse().find((b) => b.role === "user" && b.text.trim());
  if (!last) return taskTitle(blocks as Block[]);
  const text = last.text.trim();
  const line = text.split("\n")[0].trim();
  return line === text ? "" : line;
}

export function OrchestrationView(props: ThreadViewProps) {
  const { session } = props;
  const agents = useAgents(session.id);
  const [detailId, setDetailId] = useState<string | null>(null);
  const goal = useMemo(() => orchestrationGoal(session.blocks), [session.blocks]);

  const header = (placement: OutlinePlacement) =>
    agents.length > 0 ? (
      <ColumnBand placement={placement} className="pt-5 pb-3" data-fleet-band="">
        <FleetHeader goal={goal} agents={agents} />
      </ColumnBand>
    ) : null;

  let column: ReactNode;
  if (props.renderSlots) {
    const slots = props.renderSlots();
    column = (
      <>
        {header(slots.placement ?? "hidden")}
        {slots.transcript}
        <ChatFooter slots={slots} />
      </>
    );
  } else {
    column = (
      <>
        {header("hidden")}
        <div className="flex min-h-0 flex-1 flex-col">{chatOf(props)}</div>
      </>
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <OpenAgentDetailContext.Provider value={setDetailId}>{column}</OpenAgentDetailContext.Provider>
      <AnimatePresence>
        {detailId ? (
          <AgentDetail
            key={detailId}
            agentId={detailId}
            parentCwd={session.cwd}
            onClose={() => setDetailId(null)}
            onOpenSession={props.onOpenSession}
            onOpenFile={props.onOpenFile}
            onOpenDiff={props.onOpenDiff}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
