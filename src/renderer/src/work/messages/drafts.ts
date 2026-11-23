import { useEffect, useMemo } from "react";
import { useMessagesData, type ThreadDraft } from "./data";
import { markDraft, useDraftMarks, usePendingPress } from "./page";

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
        if (d.id === press?.draft || (mark && "settled" in mark)) return [];
        return mark && "failed" in mark && d.failed === undefined ? [{ ...d, failed: mark.failed }] : [d];
      }),
    [all, marks, press],
  );
}
