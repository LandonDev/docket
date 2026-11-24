import { useEffect, useState } from "react";
import type { MsFormHistoryRow } from "@shared/contract-work-msforms";
import { Modal } from "../../chrome/Modal";
import { Skeleton } from "../../components/ui/skeleton";
import { dayTime } from "../../lib/duration";

/**
 * Question History (docs/agents/work-msforms.md "Question history"): each change of the form's question list in
 * words, newest first, with when and who: him, an agent, or a change seen in the Forms page itself (his own edits in
 * the guest, or someone else's in Forms).
 */

/** Who made a change, as the list names them. */
export function byWords(by: MsFormHistoryRow["by"]): string {
  if (by === "owner") return "You";
  if (by === "page") return "Seen in the page";
  if (by.startsWith("agent:")) return "An agent";
  return "Someone";
}

export function HistoryDialog({ title, load, onClose }: { title: string; load(): Promise<MsFormHistoryRow[]>; onClose(): void }) {
  const [rows, setRows] = useState<MsFormHistoryRow[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    void load().then(
      (r) => on && setRows(r),
      (err: unknown) => on && setFailed(err instanceof Error ? err.message : "The history could not be read."),
    );
    return () => {
      on = false;
    };
  }, [load]);
  return (
    <Modal title="Question History" description={title} size="md" onClose={onClose}>
      {failed ? (
        <p className="text-[13px] leading-5 text-muted-foreground">{failed}</p>
      ) : !rows ? (
        <div aria-busy="true" className="flex flex-col gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-4 w-[70%]" />
            </div>
          ))}
        </div>
      ) : !rows.length ? (
        <p className="text-[13px] leading-5 text-muted-foreground">No changes yet</p>
      ) : (
        <ol data-msform-history className="flex flex-col gap-4">
          {rows.map((row) => (
            <li key={row.rev} className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">
                {byWords(row.by)} · {dayTime(row.at)}
              </span>
              {row.words.map((w, i) => (
                <span key={i} className="text-[13px] leading-5 text-foreground">
                  {w}
                </span>
              ))}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
