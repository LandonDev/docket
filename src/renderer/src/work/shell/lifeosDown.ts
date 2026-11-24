import type { ClientRequest } from "@shared/contract";
import { useEnvironmentStatus } from "../../lib/connection";
import { capsMay, managedElsewhere } from "../../lib/linkMay";
import { lifeosHostName, sessionFailure, sessionWaits, type LifeosSession } from "./lifeos";
import { openConnections, openWorkSettings } from "./open";

/**
 * A LifeOS session that cannot read and is not on its way, by its true state, with the words and the one press every
 * reader gives it (the view frame, a part's `DownLine`, Mail's canvas, Today, the settings line, the project sheet, the
 * rail's menu). Retry only where asking again can help (LifeOS or the host did not answer); Sign in where the host is
 * signed out or its sign-in was refused, and Show the code where a sign-in waits for his approval, each only where this
 * window may sign that host in; Open Settings where Work is off and this window may turn it on; none for a computer the
 * host keeps its LifeOS session from.
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

/** The press that can help a down session. */
export type DownPress = "retry" | "sign-in" | "code" | "settings";

/**
 * The one press that can help: Retry for silence, Sign in for a sign-in that is missing or refused, Show the code for
 * one that waits for his approval (the code is what ends the wait), Open Settings (Settings → Work, the switch) for Work
 * off; else none. Each but Retry is offered only where this window may make it (`useDownPress`).
 */
export function downPress(down: LifeosDown): DownPress | null {
  if (downIsSilence(down)) return "retry";
  if (down === "off") return "settings";
  if (down === "pairing") return "code";
  return down === "signed-out" || down === "refused" ? "sign-in" : null;
}

/** Each press's name, the same on every reader. */
export const DOWN_PRESS_LABEL: Record<DownPress, string> = { retry: "Retry", "sign-in": "Sign in", code: "Show the code", settings: "Open Settings" };

/**
 * The host ask each press ends in, asked of this window's key before it is offered: the sign-in's pairing needs admin
 * (`work.lifeos.pairStart`, as Connections asks before it draws the host's sign-in), the switch `work.set`.
 */
const PRESS_ASK: Partial<Record<DownPress, { method: ClientRequest["method"]; params?: unknown }>> = {
  "sign-in": { method: "work.lifeos.pairStart" },
  code: { method: "work.lifeos.pairStart" },
  settings: { method: "work.set", params: { enabled: true } },
};

/**
 * `downPress` as this window may make it: Sign in and Show the code only where its key may sign that host in, Open
 * Settings only where it may turn Work on there; where it may not, no press, and `elsewhere` says who can
 * (`managedElsewhere`).
 */
export function useDownPress(down: LifeosDown | null, environmentId: string): { press: DownPress | null; elsewhere: string | null } {
  // `useLinkMay`, read through a status that may not be there yet (a page drawn before its host is known).
  const hello = useEnvironmentStatus(environmentId)?.lastHello;
  const press = down ? downPress(down) : null;
  const ask = press ? PRESS_ASK[press] : undefined;
  if (ask && !capsMay(hello, ask.method, ask.params)) return { press: null, elsewhere: managedElsewhere(lifeosHostName(environmentId) ?? "this host") };
  return { press, elsewhere: null };
}

/**
 * A press as a reader draws it: its name and what it does. Sign in and Show the code open Settings → Connections, where
 * the host's sign-in row opens the sign-in dialog; Open Settings opens Settings → Work. Retry is the reader's own ask
 * (`reopenLifeos` for the session); with none given, Retry is not drawn.
 */
export function downAction(press: DownPress | null, retry?: () => void | Promise<void>): { label: string; run: () => void | Promise<void> } | undefined {
  if (!press) return undefined;
  const run = press === "retry" ? retry : press === "settings" ? openWorkSettings : openConnections;
  return run ? { label: DOWN_PRESS_LABEL[press], run } : undefined;
}
