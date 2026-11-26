import { clockTime as clock } from "./duration";
import type { SteerStamp } from "./session";

/** The one word under a steered bubble (UserMessage's SteerLine). */
export function steerWord(stamp: SteerStamp): string {
  switch (stamp.state) {
    case "sent":
      return "Sent";
    case "received":
      return "Received";
    case "queued":
      return "Queued for the next turn";
    case "failed":
      return "Not delivered";
  }
}

/** Its tooltip: when, and how it went in ("Received at 2:02 PM, as its own turn"). */
export function steerTip(stamp: SteerStamp): string {
  if (stamp.state === "failed") return stamp.reason ? `Not delivered: ${stamp.reason}` : `Not delivered at ${clock(stamp.ts)}`;
  const word = stamp.state === "queued" ? "Queued" : steerWord(stamp);
  return `${word} at ${clock(stamp.ts)}${stamp.state === "received" && stamp.how === "next-turn" ? ", as its own turn" : ""}`;
}

/**
 * Why a steer (or a message, once the agent has settled) from the agent's sheet did not go, in plain words: the
 * cause worded once, never the host's raw line (docs/DESIGN.md "Typography and text hierarchy").
 */
export function steerFailureWords(error: unknown, live: boolean): string {
  const raw = error instanceof Error ? error.message : String(error);
  const verb = live ? "Couldn't steer" : "Couldn't send";
  if (/not connected|connection closed|socket closed|^closed\.?$|did not answer|timed out|no answer/i.test(raw)) return `${verb}. Its computer isn't answering.`;
  if (/^forbidden\b|not allowed|may not|permission/i.test(raw)) return `${verb}. This computer may not message it.`;
  if (/not running|no live harness|no (active |running )?turn|already (ended|finished|stopped)|has ended|unknown (session|thread)|no such (session|thread)|not found/i.test(raw)) return live ? `${verb}. It has already finished.` : `${verb}. This agent is gone.`;
  return `${verb}. Try again.`;
}
