import type { BrowserState, PortalSource } from "@shared/contract-work-browser";
import type { OutboxItem } from "@shared/contract-work-outbox";
import { BROWSER_BUNDLES } from "@shared/computer/outward";

/**
 * What the browser canvas reads off the held item and the pillar's state
 * (docs/agents/work-browser.md "The canvas"), as plain functions. A submit
 * waits as the computer hold's live item; its payload keeps the page's
 * fields as the host read them (`mark`, src/shared/computer/outward.ts
 * `screenMark`, password fields never in it), so the values under the page
 * are the page's own, and only their sources are the agent's words.
 */

/** One value on the page at its final screen: the field as the page labels it, what it holds, and where the agent says it came from. */
export interface PortalValue {
  label: string;
  value: string;
  source: string | null;
}

/** The fields of a held page, in the order the page reads them, from the hold's mark. A mark that does not parse reads as none. */
export function fieldsOfMark(mark: string): Array<{ label: string; value: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(mark);
  } catch {
    return [];
  }
  const fields = Array.isArray(parsed) ? parsed[1] : null;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((f) => {
    if (typeof f !== "string") return [];
    const [role, name, ...rest] = f.split("|");
    const label = (name ?? "").trim();
    const value = rest.join("|").trim();
    // A search box is never in the mark; an unlabelled or empty field says nothing worth a row.
    return role && label && value ? [{ label, value }] : [];
  });
}

const key = (s: string): string => s.trim().toLowerCase();

/** The page's values with the agent's sources beside them, joined by the field's label. */
export function portalValues(mark: string, sources: readonly PortalSource[]): PortalValue[] {
  const by = new Map(sources.map((s) => [key(s.field), s.source]));
  return fieldsOfMark(mark).map((f) => ({ ...f, source: by.get(key(f.label)) ?? null }));
}

/** The held computer act's payload, as far as the canvas reads it. */
export interface HeldSubmitPayload {
  app: { name: string; bundleId: string | null };
  window: string | null;
  label: string;
  mark: string;
  picture?: { mimeType: string; width: number; height: number; data?: string } | null;
}

/** States in which a press may still go: the live hold waits for him. */
const WAITS = new Set(["held", "live"]);

const BROWSERS = new Set(BROWSER_BUNDLES.map((b) => b.toLowerCase()));
/** A held act in a browser: a Send kept in Mail is the Outbox's, never this bar's. */
const inBrowser = (item: OutboxItem): boolean => {
  const bundle = (item.payload as Partial<HeldSubmitPayload> | null)?.app?.bundleId;
  return !!bundle && BROWSERS.has(bundle.toLowerCase());
};

/** The submit the canvas shows: a waiting computer act in a browser, of the thread's tree, newest first; else the last one decided since `since`. */
export function heldSubmitOf(items: readonly OutboxItem[], tree: ReadonlySet<string>, since: number): OutboxItem | null {
  const mine = items.filter((i) => i.kind === "computer.act" && i.sessionId !== null && tree.has(i.sessionId) && inBrowser(i)).sort((a, b) => b.createdAt - a.createdAt);
  return mine.find((i) => WAITS.has(i.state)) ?? mine.find((i) => (i.decidedAt ?? 0) >= since && i.state !== "stale") ?? null;
}

export type BarFace =
  | { face: "loading" }
  /** `owner`: he drives, so the bar offers Hand back where it would offer Take over */
  | { face: "held"; item: OutboxItem; act: string; owner: boolean }
  | { face: "done"; words: string }
  | { face: "owner" }
  | { face: "needs"; words: string }
  | { face: "agent" };

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** What the kind's bar says, in one place: a held submit wins, then his driving (Hand back is never out of reach), then how a submit ended. */
export function barFaceOf(state: BrowserState | null, held: OutboxItem | null): BarFace {
  if (!state) return { face: "loading" };
  if (held && WAITS.has(held.state)) {
    const payload = held.payload as Partial<HeldSubmitPayload> | null;
    const where = state.site?.name ?? payload?.app?.name ?? null;
    return { face: "held", item: held, act: where ? `${held.verb} in ${where}` : held.verb, owner: state.driver === "owner" };
  }
  if (state.driver === "owner") return { face: "owner" };
  if (held && held.decidedAt) {
    const word = held.state === "sent" ? "Submitted" : held.state === "discarded" ? "Left without submitting" : "Did not go through";
    return { face: "done", words: held.state === "discarded" ? word : `${word} ${clock(held.decidedAt)}` };
  }
  if (state.needs) return { face: "needs", words: state.needs };
  return { face: "agent" };
}

/** The site's host for the bar: what the agent opened, else nothing. */
export function siteHost(state: BrowserState | null): string | null {
  const url = state?.site?.url;
  if (!url) return null;
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
