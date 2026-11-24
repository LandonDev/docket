import { useEffect, useMemo } from "react";
import { useMessagesData, type ThreadDraft } from "./data";
import { draftEnded, markDraft, rememberedDraft, useDraftMarks } from "./page";

/**
 * The threads' drafts still waiting in a conversation, as the composer and Undo
 * must see them: the Outbox's own list (`useDrafts`) less one settled here
 * (sent or discarded) that the list has not dropped yet, and with a failure
 * known here before the list says so. A draft whose press is on its way stays
 * listed: its words stay in the field until the host has taken them, and its
 * line names its thread meanwhile. The marks live in page.ts, so no mount,
 * Retry or 640px crossing offers a settled draft again; each is forgotten once
 * the list has caught up with it.
 */
export function useWaitingDrafts(workspaceId: string, chatId: string): readonly ThreadDraft[] {
  const all = useMessagesData().useDrafts(chatId);
  const marks = useDraftMarks(workspaceId, chatId);
  useEffect(() => {
    for (const [id, mark] of marks) {
      const listed = all.find((d) => d.id === id);
      if (!listed || ("failed" in mark && listed.failed !== undefined)) markDraft(workspaceId, chatId, id, null);
    }
  }, [all, marks, workspaceId, chatId]);
  return useMemo(
    () =>
      all.flatMap((d): ThreadDraft[] => {
        const mark = marks.get(d.id);
        if (mark && "settled" in mark) return [];
        return mark && "failed" in mark && d.failed === undefined ? [{ ...d, failed: mark.failed, ...(mark.unknown ? { unknown: true } : {}) }] : [d];
      }),
    [all, marks],
  );
}

/**
 * What the field's words are now, answered once for every reader (the line, Send, the failure cleanup, Undo), against
 * all the drafts still waiting, not only the one the line would show: a held draft's (a press sends the item), a
 * copy-only draft's, a failed item's (the Outbox's; never sent as his own), one another window is sending (nothing here
 * acts on it), or his own, which is also what an edited draft gone from the list leaves behind (an untouched one goes
 * with it: the composer's cleanup).
 */
export type FieldOrigin = { kind: "own" } | { kind: "held" | "copy" | "failed" | "sending" | "unlisted"; draft: ThreadDraft };
export function fieldOrigin(from: string | null, drafts: readonly ThreadDraft[]): FieldOrigin {
  const draft = from ? drafts.find((d) => d.id === from) : undefined;
  if (!draft) return { kind: "own" };
  // Sending from elsewhere is not yet sent: its words stay the draft's, and nothing here may act on them, until the list
  // says how it ended.
  return { kind: draft.failed !== undefined ? "failed" : draft.sending ? "sending" : draft.held ? "held" : "copy", draft };
}

/**
 * What a Discard's answer from the host means for the composer: nothing (the item was discarded), or why not, in plain
 * words. The host answers with the item as it now is, and an item another window already claimed comes back sending or
 * sent, not discarded: that is no success, and its words stay where they are.
 */
export function discardRefusal(after: { state: string; error?: string | null }): string | null {
  if (after.state === "discarded") return null;
  if (after.state === "sending") return "Already sending from the Outbox";
  if (after.state === "sent") return "Already sent from the Outbox";
  return after.error ?? "The Outbox did not discard it";
}

/**
 * Whose words the field holds, as every reader must take it: `fieldOrigin`, except that a draft the field came from that
 * has left the Outbox's list is not his own until the host says it ended (`endDraft`): the list is capped, so a draft
 * still held can drop out of it. Until then it is `unlisted`, and nothing here sends, discards or writes over its words.
 */
export function originOf(workspaceId: string, chatId: string, from: string | null, drafts: readonly ThreadDraft[]): FieldOrigin {
  const origin = fieldOrigin(from, drafts);
  if (origin.kind !== "own" || !from || draftEnded(workspaceId, chatId, from)) return origin;
  const kept = rememberedDraft<ThreadDraft>(workspaceId, chatId, from);
  return kept ? { kind: "unlisted", draft: kept } : origin;
}

/** A draft whose state is another's to settle (sending elsewhere, or out of the list): its words are not to be touched. */
export const lockedOrigin = (origin: FieldOrigin): boolean => origin.kind === "sending" || origin.kind === "unlisted";
