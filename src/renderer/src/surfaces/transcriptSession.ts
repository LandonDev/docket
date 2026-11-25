import { createContext, createElement, useContext } from "react";
import { registry } from "../lib/connection";
import { sessionStore } from "../lib/tcserver/store";
import { useWorkSessionId } from "../lib/workRow";
import { workHeadChunk } from "./chunks";
import { LEAD_LOCAL_MS, LEAD_REMOTE_MS } from "./smoothText";

/** The session a transcript renders, for rows that key state by session. */
export const TranscriptSessionContext = createContext<string | undefined>(undefined);

/** The row was born live: it joined the live turn after the transcript
 *  opened, so its prose reveals from its first word (AgentTranscript). */
export const RowBornContext = createContext(false);

export function useTranscriptSession(): string | undefined {
  return useContext(TranscriptSessionContext);
}

/** The host the transcript's thread runs on; undefined outside a transcript. */
export function useTranscriptHost(): string | undefined {
  const sessionId = useTranscriptSession();
  return sessionId ? sessionStore.environmentOf(sessionId) : undefined;
}

/** The streaming reveal's seed lead for the transcript's thread: a thread
 *  on another host starts with the lead that covers the link's jitter. */
export function useRevealLead(): number {
  const host = useTranscriptHost();
  return host && host !== registry.primaryEnvironmentId ? LEAD_REMOTE_MS : LEAD_LOCAL_MS;
}

/** The id of the thread's first message while the transcript holds the thread from its start; null while older history is still to load. */
export const ThreadHeadContext = createContext<string | null>(null);

const Head = workHeadChunk.surface("WorkHead");

/**
 * Where a thread's head goes: over its first message, in that message's own row, so it scrolls with the transcript
 * and the rows' layout measures it as part of the row. Only a Work thread has one (surfaces/transcript/WorkHead.tsx,
 * its own chunk); a code thread draws nothing here and loads nothing.
 */
export function ThreadHeadSlot({ blockId }: { blockId: string }) {
  const first = useContext(ThreadHeadContext) === blockId;
  const sessionId = useTranscriptSession();
  const work = useWorkSessionId(first ? sessionId : null);
  return work && sessionId ? createElement(Head, { sessionId }) : null;
}
