import { capabilityRefusal, type Capability } from "@shared/capabilities";
import type { ClientRequest } from "@shared/contract";
import { registry, useEnvironmentStatus, useEnvironmentStatuses } from "./connection";
import { nameInLine } from "./hostWords";

type Method = ClientRequest["method"];

/**
 * Whether this window's link to a host may make a request: the host's own rule (`capabilityRefusal`) asked of
 * the caps the host named in its hello. A control asks it before it is offered, so a press never ends in a
 * refusal he could not have avoided: it is hidden, or it says who can. It only hides or words a control; the
 * host's check stays the judge. The window's own socket holds no key and may do everything; a link that has
 * said no hello yet (connecting, offline) answers true, so nothing is hidden on a guess.
 */
export function linkMay(environmentId: string, method: Method, params?: unknown): boolean {
  return capsMay(registry.statusOf(environmentId).lastHello, method, params);
}

/** `linkMay` on a hello in hand. */
export function capsMay(hello: { caps: readonly Capability[]; key?: unknown } | null | undefined, method: Method, params?: unknown): boolean {
  if (!hello || !hello.key) return true;
  return capabilityRefusal(hello.caps, { method, params }) === null;
}

/** `linkMay` for a control on screen: asked again when the link's hello lands or changes, never a stale read. */
export function useLinkMay(environmentId: string, method: Method, params?: unknown): boolean {
  return capsMay(useEnvironmentStatus(environmentId).lastHello, method, params);
}

/** `useLinkMay` for a list whose rows sit on several hosts: one subscription, asked per row. */
export function useLinksMay(): (environmentId: string, method: Method, params?: unknown) => boolean {
  const statuses = useEnvironmentStatuses();
  return (environmentId, method, params) => capsMay(statuses.get(environmentId)?.lastHello, method, params);
}

/**
 * The one line Work shows in place of a section this window's key may not change: who can. Settings → Work's
 * switch says the same of several hosts (`elsewhereLine`).
 */
export const managedElsewhere = (host: string): string => `Changed from a computer that manages ${nameInLine(host)}`;
