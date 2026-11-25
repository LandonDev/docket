/**
 * What the owner's page tells the phone it is open in (docs/agents/work-phone-files.md "The hosted editor"). The
 * phone's web view adds a message handler of this name (ios HostedItemView.swift, `HostedBridge`); a browser has
 * none, and then nothing is said. The phone hears whether the page opened, and that its pass ended (a restart of
 * the host forgets every pass), so it can open the same file again on a new ticket.
 */
export const PHONE_HANDLER = "tempcodeHosted";

export type PhoneNote = { kind: "opened" } | { kind: "passEnded" };

type WithHandlers = { webkit?: { messageHandlers?: Record<string, { postMessage(note: unknown): void } | undefined> } };

/** Tells the phone around the page, if there is one; answers whether there was. */
export function tellPhone(note: PhoneNote, w: WithHandlers = window as WithHandlers): boolean {
  const handler = w.webkit?.messageHandlers?.[PHONE_HANDLER];
  if (!handler) return false;
  try {
    handler.postMessage(note);
    return true;
  } catch {
    return false;
  }
}
