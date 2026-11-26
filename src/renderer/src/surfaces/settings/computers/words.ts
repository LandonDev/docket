import type { AdmissionState } from "@server/shared/contract-admission";
import type { Capability } from "@server/shared/capabilities";
import type { RemoteKey, RemotePairing, RemoteSession } from "@server/shared/contract-remote";
import { ago } from "../../harnessLine";

/**
 * The words a computer's pages say, kept apart from their markup (docs/agents/settings.md "The pages: computers"):
 * what a device may do in the plan's words, a device's kind and line, how many threads run. Pure, so every state is
 * testable.
 */

/** What a key or a link may do, as a choice reads it: "Look only", "Run threads", "Run threads and approve",
 *  "Manage the box". `computer` is the computer as it reads mid-line. */
export function mayWords(caps: readonly Capability[], computer: string): string {
  if (caps.includes("admin")) return `Manage ${computer}`;
  if (caps.includes("approve")) return "Run threads and approve";
  if (caps.includes("operate")) return "Run threads";
  return "Look only";
}

/** The same, as it reads inside a device's line: "runs threads and approves", "manages the box". */
export function mayInLine(caps: readonly Capability[], computer: string): string {
  if (caps.includes("admin")) return `manages ${computer}`;
  if (caps.includes("approve")) return "runs threads and approves";
  if (caps.includes("operate")) return "runs threads";
  return "looks only";
}

export type DeviceKind = "phone" | "computer" | "browser" | "bot" | "app";

/** The kinds in the order the list keeps them. */
export const DEVICE_KINDS: readonly DeviceKind[] = ["phone", "computer", "browser", "bot", "app"];

const KIND_WORD: Record<DeviceKind, string> = { phone: "Phone", computer: "Computer", browser: "Browser", bot: "Bot", app: "App" };

/** A key's kind. A key made by a sign-in link carries the app that took it (`client`) where the computer lists it;
 *  an older computer's list does not, and its key reads "App". */
export function keyKind(key: RemoteKey & { client?: string | null }): DeviceKind {
  if (key.audience === "mcp") return "bot";
  if (key.kind === "browser") return "browser";
  if (key.client === "phone") return "phone";
  if (key.client === "desktop") return "computer";
  return "app";
}

/** One row of "Who can sign in to <computer>": a key, a browser signed in, or a sign-in link not yet used. */
export type SignIn =
  | { kind: "key"; id: string; name: string; device: DeviceKind; caps: readonly Capability[]; line: string; own?: boolean }
  | { kind: "session"; id: string; name: string; device: "browser"; caps: readonly Capability[]; line: string; own?: boolean }
  | { kind: "link"; id: string; name: string; caps: readonly Capability[]; expiresAt: number };

/** "Chrome", "Safari", "Edge"…: the browser a session signed in from; "" when the agent names none. */
export function shortAgent(ua: string): string {
  const m = /(Edg|OPR|Chrome|Firefox|Safari|CriOS)\/[\d.]+/.exec(ua);
  return m ? m[0].split("/")[0].replace("CriOS", "Chrome").replace("OPR", "Opera").replace("Edg", "Edge") : "";
}

/** Every way in, in one list: the links still waiting first, then by kind and by name. `ownKey` is the key this window
 *  signed in with (its socket's hello): that key's row, or for a browser the newest session on it, is marked `own`. */
export function signInsOf(
  lists: { keys: readonly RemoteKey[]; sessions: readonly RemoteSession[]; pairings: readonly RemotePairing[] },
  computer: string,
  now = Date.now(),
  ownKey: string | null = null,
): SignIn[] {
  const ownSession = lists.sessions.filter((s) => s.keyId === ownKey).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]?.id;
  const links: SignIn[] = lists.pairings
    .filter((p) => p.consumedAt === null && p.expiresAt > now)
    .map((p) => ({ kind: "link", id: p.id, name: p.name, caps: p.caps, expiresAt: p.expiresAt }));
  const keys: SignIn[] = lists.keys
    // A browser's key only anchors its sessions: the sessions are the rows.
    .filter((k) => k.revokedAt === null && k.kind !== "browser")
    .map((k) => {
      const device = keyKind(k);
      const used = k.lastUsedAt ? `used ${ago(k.lastUsedAt, now)}` : "never used";
      return { kind: "key", id: k.id, name: k.name, device, caps: k.caps, line: [KIND_WORD[device], mayInLine(k.caps, computer), used].join(", "), own: k.id === ownKey };
    });
  const sessions: SignIn[] = lists.sessions.map((s) => {
    const browser = shortAgent(s.userAgent ?? "");
    return {
      kind: "session",
      id: s.id,
      name: browser ? `${browser}, ${s.keyName}` : s.keyName,
      device: "browser",
      caps: s.caps,
      line: ["Browser", mayInLine(s.caps, computer), `used ${ago(s.lastSeenAt, now)}`].join(", "),
      own: s.id === ownSession,
    };
  });
  const rank = (row: SignIn): number => (row.kind === "link" ? -1 : DEVICE_KINDS.indexOf(row.device));
  return [...links, ...keys, ...sessions].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The one row left that can manage the computer: removing it leaves no device that can. */
export const lastManager = (rows: readonly SignIn[], row: SignIn): boolean =>
  row.kind !== "link" && row.caps.includes("admin") && rows.filter((r) => r.kind !== "link" && r.caps.includes("admin")).length === 1;

/** "2 of 8 running", "118 of 120 running, 7 waiting". */
export function runningWords(state: Pick<AdmissionState, "running" | "cap" | "queued">): string {
  const running = `${state.running} of ${state.cap} running`;
  return state.queued > 0 ? `${running}, ${state.queued} waiting` : running;
}

/** 81920 → "80 GiB", 9216 → "9 GiB", 2560 → "2.5 GiB". */
export function gib(mb: number): string {
  const n = mb / 1024;
  return `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} GiB`;
}

/** What the default is sized from, said on hover: "Sized from 80 GiB, 331 MB a thread, 9 GiB free". */
export const budgetWords = (s: AdmissionState): string =>
  `Sized from ${gib(s.memory.budgetMB)}, ${s.memory.perProcessMB} MB a thread, ${gib(s.memory.freeMB)} free`;
