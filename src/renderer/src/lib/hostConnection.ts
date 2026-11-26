import type { Capability } from "@server/shared/capabilities";
import type { RouteKind } from "@server/shared/contract-remote";
import { linkFact } from "./connection/degraded";
import type { EnvironmentStatus } from "./connection/types";

/**
 * The words for a host's link and key (Settings → Hosts, the rail's host
 * rows, the connection indicator): pure, so every state is testable.
 */

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** "operate, approve", or "read only" when the key may only read. */
export function capsText(caps: readonly Capability[]): string {
  const granted = (["operate", "approve", "admin"] as Capability[]).filter((cap) => caps.includes(cap));
  return granted.length === 0 ? "read only" : granted.join(", ");
}

/** `wss://host/ws` → `host`, `ws://127.0.0.1:7677/ws` → `127.0.0.1:7677`. */
export function originText(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The main process's `<reason>: <detail>` becomes the detail; it is already a sentence. */
export function hostErrorText(err: unknown): string {
  const text = errorText(err);
  const m = /^(unauthorized|unavailable|self|unknown-environment|unknown-route|bad-url|contract|bad-link): (.*)$/s.exec(text);
  if (!m) return text;
  return m[1] === "self" ? "That is this machine." : m[2];
}

/**
 * A host's state as the trailing fact of its row in the Hosts menu: an open link's own words, else `linkFact`
 * (`linkWords` without the name the row already shows). `slow`: the host's answers are late (lib/connection/link.ts health).
 */
export function statusText(status: EnvironmentStatus, slow = false, online?: boolean): string {
  if (status.transport === "open") return slow ? "Slow to answer" : status.fresh ? "Connected" : "Catching up";
  return linkFact({ kind: status.transport, status }, online);
}

const PRIVATE_HOST = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|localhost$|.*\.local$)/i;

/** Mirrors the main process: loopback here, lan for private names, tunnel otherwise. */
export function kindOf(input: string): RouteKind {
  let host = "";
  try {
    host = new URL(input.trim()).hostname.toLowerCase();
  } catch {
    return "tunnel";
  }
  if (host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1") return "loopback";
  return PRIVATE_HOST.test(host) ? "lan" : "tunnel";
}
