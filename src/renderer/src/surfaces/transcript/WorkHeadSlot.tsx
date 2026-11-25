import { createContext, useContext } from "react";
import { useWorkSessionId } from "../../lib/workRow";
import { workHeadChunk } from "../chunks";
import { useTranscriptSession } from "../transcriptSession";

/** The id of the thread's first message while the transcript holds the thread from its start; null while older history is still to load. */
export const ThreadHeadContext = createContext<string | null>(null);

const WorkHeadSurface = workHeadChunk.surface("WorkHead");

/**
 * Where a Work thread's head goes: over its first message, in that message's
 * own row, so it scrolls with the transcript and the rows' layout measures it
 * as part of the row. A code thread draws nothing here and loads nothing: the
 * head is its own chunk (surfaces/chunks.ts), read on the row (lib/workRow.ts).
 */
export function WorkHeadSlot({ blockId }: { blockId: string }) {
  const first = useContext(ThreadHeadContext) === blockId;
  const sessionId = useTranscriptSession();
  const work = useWorkSessionId(first ? sessionId : null);
  return work && sessionId ? <WorkHeadSurface sessionId={sessionId} /> : null;
}
