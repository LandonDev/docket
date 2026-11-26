import type { Capability } from "@shared/capabilities";
import { registry } from "./connection/registry";
import { useEnvironmentStatus, useEnvironmentStatuses } from "./connection/status";
import { nameInLine } from "./hostWords";

/**
 * `linkMay` for Docket's first paint: the host's rule (`capabilityRefusal`, shared/capabilities.ts) for the few
 * methods its own controls ask about, with none of the contract the full table imports (every Work schema, 333 kB).
 * The table is the host's, row for row (lib/linkMayCore.test.ts holds it to `METHOD_CAPABILITY` and to every set of
 * caps); a method not in it is a type error, so ask the full `linkMay` (lib/linkMay.ts) from a lazy surface instead.
 */
const NEEDS = {
  "batch.adopt": "operate",
  "batch.setRules": "operate",
  "batch.stopStep": "operate",
  "build.run": "operate",
  "devServer.start": "operate",
  "devServer.stop": "operate",
  "fs.createPath": "operate",
  "git.commitStaged": "operate",
  "git.stageFile": "operate",
  "git.stash": "operate",
  "macBridge.thread.set": "approve",
  "resources.remove": "operate",
  "review.override": "approve",
  "session.answer": "operate",
  "session.approve": "approve",
  "session.archive": "operate",
  "session.batch": "operate",
  "session.compact": "operate",
  "session.continue": "operate",
  "session.create": "operate",
  "session.delete": "operate",
  "session.interrupt": "operate",
  "session.killBackground": "operate",
  "session.notes.set": "operate",
  "session.pause": "operate",
  "session.pauseAllRunning": "operate",
  "session.permission": "approve",
  "session.rename": "operate",
  "session.resume": "operate",
  "session.retype": "operate",
  "session.send": "operate",
  "session.setGoal": "operate",
  "session.setMaster": "operate",
  "session.start": "operate",
  "session.stopTask": "operate",
  "session.tune": "operate",
} as const satisfies Record<string, Capability>;

export type CoreMethod = keyof typeof NEEDS;
export const CORE_METHODS = Object.keys(NEEDS) as CoreMethod[];

/**
 * `capabilityRefusal(caps, req) === null` for a table method: a pending key may make none of them; a device key's
 * admin counts for nothing; `admin` covers operate and approve; a new thread at full access (`auto`) needs approve.
 */
export function capsAllow(caps: readonly Capability[], method: CoreMethod, params?: unknown): boolean {
  const auto = method === "session.create" && (params as { permission?: string } | undefined)?.permission === "auto";
  return allowsNeed(caps, auto ? "approve" : NEEDS[method]);
}

/** `accessCeiling`'s question: may this key start a thread at full access (a new thread's `auto` needs approve)? */
export const capsAllowFullAccess = (caps: readonly Capability[]): boolean => allowsNeed(caps, "approve");

function allowsNeed(caps: readonly Capability[], need: "operate" | "approve"): boolean {
  if (caps.includes("pending")) return false;
  const own = caps.includes("device") ? caps.filter((c) => c !== "admin") : caps;
  return own.includes(need) || own.includes("admin");
}

/** Whether a hello in hand may: the window's own socket holds no key and may do everything, as may a link with no hello yet. */
export function capsMay(hello: { caps: readonly Capability[]; key?: unknown } | null | undefined, method: CoreMethod, params?: unknown): boolean {
  return !hello || !hello.key || capsAllow(hello.caps, method, params);
}

export function linkMay(environmentId: string, method: CoreMethod, params?: unknown): boolean {
  return capsMay(registry.statusOf(environmentId).lastHello, method, params);
}

/** `linkMay` for a control on screen: asked again when the link's hello lands or changes. */
export function useLinkMay(environmentId: string, method: CoreMethod, params?: unknown): boolean {
  return capsMay(useEnvironmentStatus(environmentId).lastHello, method, params);
}

/** `useLinkMay` for a list whose rows sit on several hosts: one subscription, asked per row. */
export function useLinksMay(): (environmentId: string, method: CoreMethod, params?: unknown) => boolean {
  const statuses = useEnvironmentStatuses();
  return (environmentId, method, params) => capsMay(statuses.get(environmentId)?.lastHello, method, params);
}

/** Who can, by the act, where a key may not (docs/DESIGN.md "Loading and empty states"). */
export const managedElsewhere = (host: string): string => `Changed from a computer that manages ${nameInLine(host)}`;
export const signInElsewhere = (host: string): string => `Sign in from a computer that manages ${nameInLine(host)}`;
export const sendElsewhere = (host: string): string => `Send from a computer that manages ${nameInLine(host)}`;
export const approveElsewhere = (host: string): string => `Answer from a computer that manages ${nameInLine(host)}`;
export const answerElsewhere = approveElsewhere;
