import { createContext, useContext } from "react";
import type { ContextChip } from "@shared/work";
import { SOURCE_APP, SOURCE_NAME, type ChatRow } from "@shared/work/messages";
import { AtSign, Copy, ExternalLink, MessageSquarePlus } from "../../chrome/icons";
import type { MenuRow } from "../../chrome/menuRows";
import { loadToast } from "../../components/ui/toaster";
import { openUrl } from "../../lib/native";
import { workOpenPort } from "../../lib/workSwitch";
import { currentActiveSession } from "../../stores/subscriptions";

/**
 * A conversation in a thread (docs/agents/work-messages.md "Threads"): the
 * chip `chat` that names it, a message's words carried on it as `quote`, and
 * the two verbs that use it, Start thread (a new thread's composer with the
 * chip in it) and Mention in a thread (the chip put in the thread open in the
 * window). The same rows serve a conversation's row, its toolbar and a
 * message's menu.
 */

/** The conversation as a chip: "Dana Lee in Slack", with a message's words when it is about one. */
export function chatChip(chat: Pick<ChatRow, "_id" | "name" | "source">, quote?: string): ContextChip {
  const words = quote?.trim();
  return { kind: "chat", label: `${chat.name} in ${SOURCE_NAME[chat.source]}`, ref: { at: "lifeos", table: "chats", id: chat._id }, ...(words ? { quote: words.slice(0, 20_000) } : {}) };
}

/** The thread a mention goes into: the one open in the window, unless it is archived. */
export function mentionTarget(): { id: string; title?: string | null } | null {
  const thread = currentActiveSession();
  return thread && !thread.archived ? thread : null;
}

/** Start thread where the view can start one, and Mention in a thread only while a thread is open to take it. */
export function threadRows(threadOpen: boolean, canStart = true): MenuRow[] {
  const rows: MenuRow[] = [];
  if (canStart) rows.push({ kind: "item", id: "start-thread", label: "Start thread", icon: MessageSquarePlus });
  if (threadOpen) rows.push({ kind: "item", id: "mention", label: "Mention in a thread", icon: AtSign });
  return rows;
}

/** Open in the app and Copy link, for a conversation or a message that has a web address. */
export function linkRows(source: ChatRow["source"], link: string | undefined): MenuRow[] {
  if (!link || !/^https?:\/\//i.test(link)) return [];
  return [
    { kind: "item", id: "open", label: `Open in ${SOURCE_APP[source]}`, icon: ExternalLink },
    { kind: "item", id: "copy-link", label: "Copy link", icon: Copy },
  ];
}

/** The chip put in the open thread, and a toast that names it with the way there. */
export function mention(chip: ContextChip): void {
  const thread = mentionTarget();
  if (!thread) return;
  // The chip store is the canvas chunk's; it is on the page by the time a thread is.
  void import("../canvas/chips").then(({ addContextChip }) => addContextChip(thread.id, chip));
  void loadToast().then((toast) => toast(`Mentioned in ${thread.title?.trim() || "the thread"}`, { action: { label: "Open", onClick: () => workOpenPort.get()?.(thread.id) } }));
}

/** Text to the clipboard, said in a toast. */
export function copyText(text: string, said: string): void {
  void navigator.clipboard?.writeText(text).then(
    () => loadToast().then((toast) => toast(said)),
    () => loadToast().then((toast) => toast.error("Couldn't copy")),
  );
}

/** Starts a thread with a chip in its composer; the view's own, from WorkViewProps. Absent (the preview), Start thread is not offered. */
const StartThread = createContext<((chip: ContextChip) => void) | null>(null);
export const StartThreadProvider = StartThread.Provider;
export const useStartThread = (): ((chip: ContextChip) => void) | null => useContext(StartThread);

/**
 * What a pick from these rows does: the thread verbs with the chip, the link
 * verbs with the link. Answers whether it was one of them.
 */
export function pickThreadVerb(pick: string, chip: ContextChip, start: ((chip: ContextChip) => void) | null, link?: string): boolean {
  if (pick === "start-thread") start?.(chip);
  else if (pick === "mention") mention(chip);
  else if (pick === "open" && link) void openUrl(link);
  else if (pick === "copy-link" && link) copyText(link, "Link copied");
  else return false;
  return true;
}
