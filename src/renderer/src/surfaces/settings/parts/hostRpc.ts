import type { ClientRequest } from "@shared/contract";
import { LOCAL_ENVIRONMENT_ID, registry, useEnvironmentStatus, type Link } from "../../../lib/connection";
import { capsMay } from "../../../lib/linkMay";
import { useComputerName, type ComputerName } from "../../../lib/settings/computerName";

/**
 * A page's line to one computer (docs/agents/settings.md "Another computer's settings"): this window's own server, or
 * another computer over that computer's own link. Its listener, sign-ins, limits and attachment size need `admin`
 * there, not a local window, so a Mac holding an admin key sets the box's from the box's page; a key without it reads
 * what it may and sees the rest as words (`may`).
 */

/** The link a computer's page asks: this window's own for its own computer, else that computer's. */
export function hostLink(environmentId: string): Link | undefined {
  return environmentId === LOCAL_ENVIRONMENT_ID || environmentId === registry.primaryEnvironmentId ? registry.primary() : registry.link(environmentId);
}

/** What a request to a computer this window has no link to says. */
export const NOT_LINKED = "This window is not linked to that computer.";

/** One request to one computer; nothing else is written. */
export function hostRequest<T>(environmentId: string, method: string, params: unknown = {}): Promise<T> {
  const link = hostLink(environmentId);
  return link ? link.request<T>(method, params) : Promise.reject(new Error(NOT_LINKED));
}

export type Host = {
  environmentId: string;
  link: Link | undefined;
  /** Its link is open: a page reads and writes only then. */
  connected: boolean;
  name: ComputerName;
  /** Whether this window's key there may make a request: a control it may not use is shown as words. */
  may: (method: ClientRequest["method"], params?: unknown) => boolean;
  request: <T>(method: string, params?: unknown) => Promise<T>;
};

/** One computer as a page sees it, following its link's state and the key's rights as they change. */
export function useHost(environmentId: string): Host {
  const status = useEnvironmentStatus(environmentId === LOCAL_ENVIRONMENT_ID ? registry.primaryEnvironmentId : environmentId);
  const name = useComputerName(environmentId);
  return {
    environmentId,
    link: hostLink(environmentId),
    connected: status.transport === "open",
    name,
    may: (method, params) => capsMay(status.lastHello, method, params),
    request: (method, params) => hostRequest(environmentId, method, params),
  };
}
