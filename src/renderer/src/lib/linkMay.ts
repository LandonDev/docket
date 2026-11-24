import { capabilityRefusal, type Capability } from "@shared/capabilities";
import type { ClientRequest } from "@shared/contract";
import { registry } from "./connection";

/**
 * Whether this window's link to a host may make a request: the host's own rule (`capabilityRefusal`) asked of
 * the caps the host named in its hello. A control asks it before it is offered, so a press never ends in a
 * refusal he could not have avoided: it is hidden, or it says who can. It only hides or words a control; the
 * host's check stays the judge. The window's own socket holds no key and may do everything; a link that has
 * said no hello yet (connecting, offline) answers true, so nothing is hidden on a guess.
 */
export function linkMay(environmentId: string, method: ClientRequest["method"], params?: unknown): boolean {
  return capsMay(registry.statusOf(environmentId).lastHello, method, params);
}

/** `linkMay` on a hello in hand. */
export function capsMay(hello: { caps: readonly Capability[]; key?: unknown } | null | undefined, method: ClientRequest["method"], params?: unknown): boolean {
  if (!hello || !hello.key) return true;
  return capabilityRefusal(hello.caps, { method, params }) === null;
}
