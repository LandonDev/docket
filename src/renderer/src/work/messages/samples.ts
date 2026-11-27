import type { ChatKind, ChatMessage, ChatRow } from "@shared/work/messages";
import type { Block } from "./model";

/*
 * What the Messages view's bones are drawn from (docs/agents/loading-bones.md
 * "Samples"): fixed literals shaped like real work, no clock, ids that start
 * `sample:`. Nobody reads the words; their lengths give the bones their shape.
 */

/** A fixed instant, so a sample's time is the same in every drawing. */
const AT = Date.UTC(2026, 10, 23, 20, 31);

const row = (n: number, kind: ChatKind, name: string, lastText: string, lastWho: string): ChatRow => ({
  _id: `sample:chat:${n}`,
  source: "slack",
  account: "sample:account",
  channel: `sample:channel:${n}`,
  name,
  kind,
  sector: "sample",
  lastAt: AT,
  lastText,
  lastWho,
  lastFromMe: false,
  unread: false,
  faces: [{ name: lastWho }],
});

/** The list's rows while it loads: eight, a page of them, names and lines of the lengths real ones run to. */
export const SAMPLE_CHATS: readonly ChatRow[] = [
  row(1, "direct", "Dana Lee", "Also, the art team wants the new key art by Thursday", "Dana Lee"),
  row(2, "direct", "Omar Haddad", "Controller fix is up for review", "Omar Haddad"),
  row(3, "direct", "Priya Raman", "Can we move the playtest to Friday afternoon instead?", "Priya Raman"),
  row(4, "direct", "Lucas Brandt", "Build 0.9.5 is on the share", "Lucas Brandt"),
  row(5, "direct", "Mia Chen", "Thanks, the crash numbers helped a lot in the review", "Mia Chen"),
  row(6, "direct", "Sam Ito", "On my way, ten minutes", "Sam Ito"),
  row(7, "direct", "Grace Okafor", "The store page copy still says early access", "Grace Okafor"),
  row(8, "direct", "Theo Marsh", "Sounds good to me, ship it", "Theo Marsh"),
];

/** A row's time in the sample: one fixed clock. */
export const SAMPLE_TIME = "3:31 PM";

const message = (n: number, name: string, text: string): ChatMessage => ({ _id: `sample:message:${n}`, who: { name, me: false }, text, sentAt: AT, files: [] });
const block = (n: number, name: string, text: string, head: boolean): Block => ({ id: `sample:message:${n}`, message: message(n, name, text), head, day: null, isNew: false, quote: false });

/** A conversation's foot while its messages load: three runs of words, as the column draws them. */
export const SAMPLE_BLOCKS: readonly Block[] = [
  block(1, "Dana Lee", "Can you send me the crash numbers before the review?", true),
  block(2, "Dana Lee", "Just the last three builds is fine.", false),
  block(3, "Omar Haddad", "I'll look at the controller thing this afternoon.", true),
  block(4, "Dana Lee", "Heads up, I moved the review to 4:30 so Priya can make it.", true),
  block(5, "Dana Lee", "The store page copy still says early access. Can you ping marketing?", false),
  block(6, "Dana Lee", "Works for me.", false),
];

/** The conversation a sample block belongs to, for a file that could not come (none does). */
export const SAMPLE_CHAT: Pick<ChatRow, "source" | "link"> = { source: "slack" };
