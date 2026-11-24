import { sessionFailure, sessionWaits, type LifeosSession } from "./lifeos";

/**
 * A LifeOS session that cannot read and is not on its way, by its true state, with the words and the one press the
 * view frame and the settings line give it (work/shell/WorkViewPage.tsx, work/connections/LifeosLine.tsx): Today's
 * line and a held calendar act's details say each state alike. Retry only where asking again can help (LifeOS or the
 * host did not answer); Sign in where the host is signed out or its sign-in was refused; none for a sign-in that waits
 * for his approval, a host whose Work is off, or a computer the host keeps its LifeOS session from.
 */
export type LifeosDown = "unreachable" | "unanswered" | "signed-out" | "refused" | "pairing" | "off" | "withheld";

/** The state of a session that is down; null while it reads or is on its way. */
export function downOf(session: Pick<LifeosSession, "client" | "state" | "withheld" | "unanswered">): LifeosDown | null {
  if (session.client || sessionWaits(session)) return null;
  // Not waiting: the state is none of connecting or connected.
  return session.withheld ? "withheld" : session.unanswered ? "unanswered" : (session.state as LifeosDown);
}

/** What a down session says: the shared words (`sessionFailure`), naming `host`, the computer it reads through ("The box"). */
export const downWords = (down: LifeosDown, host?: string | null): string =>
  down === "withheld" ? sessionFailure("unreachable", true, host) : sessionFailure(down, false, host);

/** Silence, LifeOS's or the host's: the red line with Retry. */
export const downIsSilence = (down: LifeosDown): boolean => down === "unreachable" || down === "unanswered";

/** The one press that can help: Retry for silence, Sign in for a sign-in that is missing or refused, else none. */
export function downPress(down: LifeosDown): "retry" | "sign-in" | null {
  if (downIsSilence(down)) return "retry";
  return down === "signed-out" || down === "refused" ? "sign-in" : null;
}
