import { useEffect, useMemo } from "react";
import { useMessagesData, type ThreadDraft } from "./data";
import { draftEditsOf, keepDraftEdit, keepLooseWords, markDraft, useDraftEdits, useDraftMarks, usePendingPress } from "./page";

/**
 * The threads' drafts still waiting in a conversation, as the composer and Undo
 * must see them: the Outbox's own list (`useDrafts`) less a draft pressed and
 * on its way, less one settled here (sent or discarded) that the list has not
 * dropped yet, and with a failure known here before the list says so. The
 * marks live in page.ts, so no mount, Retry or 640px crossing offers a settled
 * draft again; each is forgotten once the list has caught up with it.
 */
export function useWaitingDrafts(workspaceId: string, chatId: string): readonly ThreadDraft[] {
  const all = useMessagesData().useDrafts(chatId);
  const marks = useDraftMarks(workspaceId, chatId);
  const press = usePendingPress(workspaceId, chatId);
  const edits = useDraftEdits(workspaceId, chatId);
  useEffect(() => {
    for (const [id, mark] of marks) {
      const listed = all.find((d) => d.id === id);
      if (!listed || ("failed" in mark && listed.failed !== undefined)) markDraft(workspaceId, chatId, id, null);
    }
    // A kept revision goes once the item holds it (a save went through). If the item goes while it is kept (discarded or
    // decided elsewhere), the words outlive it as his own, offered back by the composer; only an item settled here (sent
    // or discarded by his own press) takes them with it.
    for (const [id, text] of edits) {
      const listed = all.find((d) => d.id === id);
      // Every reader runs this in the same commit: act only on what the store holds now, so the words move once.
      if ((listed && listed.text !== text) || draftEditsOf(workspaceId, chatId).get(id) !== text) continue;
      // A draft his own press is sending leaves the list as it goes: its words went with it, nothing to keep.
      if (id === press?.draft) continue;
      const mark = marks.get(id);
      if (!listed && !(mark && "settled" in mark)) keepLooseWords(workspaceId, chatId, text);
      keepDraftEdit(workspaceId, chatId, id, null);
    }
  }, [all, marks, edits, press, workspaceId, chatId]);
  return useMemo(
    () =>
      all.flatMap((d): ThreadDraft[] => {
        const mark = marks.get(d.id);
        if (d.id === press?.draft || (mark && "settled" in mark)) return [];
        // His revision the Outbox refused to save stands in for the item's words until a save of it goes through.
        const edit = d.failed === undefined ? edits.get(d.id) : undefined;
        const own = edit !== undefined && edit !== d.text ? { ...d, text: edit, unsaved: true } : d;
        return mark && "failed" in mark && own.failed === undefined ? [{ ...own, failed: mark.failed, ...(mark.unknown ? { unknown: true } : {}) }] : [own];
      }),
    [all, marks, press, edits],
  );
}

/**
 * What the field's words are now, answered once for every reader (the line, Send, the failure cleanup, Undo), against
 * all the drafts still waiting, not only the one the line would show: a held draft's (a press sends the item), a
 * copy-only draft's, a failed item's (the Outbox's; never sent as his own), or his own, which is also what a draft gone
 * from the list leaves behind.
 */
export type FieldOrigin = { kind: "own" } | { kind: "held" | "copy" | "failed"; draft: ThreadDraft };
export function fieldOrigin(from: string | null, drafts: readonly ThreadDraft[]): FieldOrigin {
  const draft = from ? drafts.find((d) => d.id === from) : undefined;
  if (!draft) return { kind: "own" };
  return { kind: draft.failed !== undefined ? "failed" : draft.held ? "held" : "copy", draft };
}
