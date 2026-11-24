import type { OutboxItem } from "@shared/contract-work-outbox";
import { workErrorWords } from "../../lib/workErrorWords";

/**
 * A failure the Outbox shows, in his words (lib/workErrorWords.ts): a host's error that arrives inside an answer (a
 * failed row's reason, a press the host refused) is worded as any other, and one never written for him gives way to
 * the act's own line. A press changes something, so a lost answer reads as unknown, never as failed.
 */

/** Why a held act did not go: a send whose outcome is unknown reads as unknown. */
export function itemFailWords(item: Pick<OutboxItem, "error" | "outcomeUnknown">, host?: string): string {
  return workErrorWords(item.error ?? "", { host, write: item.outcomeUnknown === true }) || "It couldn't be sent";
}

/** Why a press (send, discard, a grant, an undo) went wrong, else the act's own line. */
export function pressFailWords(err: unknown, otherwise: string, host?: string): string {
  return workErrorWords(err, { host, write: true }) || otherwise;
}
