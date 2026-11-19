import type { ContextChip } from "@shared/work";

/**
 * The first paint's end of the composer's chip row (docs/agents/work-canvas.md
 * "The composer's chips"). What a message is about is Work's, and Work is
 * not in the first paint, so the composer asks through this port: Work's
 * chip store (work/canvas/chips.ts) names itself here when its chunk lands
 * and says when a thread's chips change. Until then there are no chips.
 */
export interface ChipPort {
  /** How many chips the thread's composer holds. */
  count(sessionId: string): number;
  /** The composer sent `text`: the message with the chips' lines in it, and the chips are gone. A draft's first chip is kept for its create. */
  send(sessionId: string, firstSend: boolean, text: string): string;
  /** What `session.create` says the new thread is about, until the thread exists. */
  about(sessionId: string): ContextChip | undefined;
}

let port: ChipPort | null = null;
const listeners = new Set<() => void>();

export const chipPort = {
  get: (): ChipPort | null => port,
  set(next: ChipPort | null): void {
    port = next;
    chipPort.changed();
  },
  changed(): void {
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
