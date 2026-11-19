import type { DraftEdit } from "@shared/contract-work-rules";
import { cn } from "../../lib/cn";
import { dayTime } from "../../lib/duration";

/**
 * The edits a proposal was drawn from (docs/agents/work-rules.md): each one
 * paragraph, the words he took out struck on the delete wash and the words
 * he put in on the add wash, as every review draws them, with its mail and
 * time on a 12px line over it. 13px on the page and under a sent mail, 14px
 * in a dialog; `framed` puts the edits in one hairline frame, as a sent
 * mail's line opens.
 */

const INS = "rounded-[2px] bg-(--add-bg) box-decoration-clone";
// Removed words keep 70% of the ink, so they read on the tint in both themes (docs/DESIGN.md "Canvas tints").
const DEL = "rounded-[2px] bg-(--del-bg) box-decoration-clone text-muted-foreground line-through decoration-[color-mix(in_srgb,var(--destructive)_70%,transparent)]";

function Edit({ edit, large }: { edit: DraftEdit; large: boolean }) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          To {edit.to}
          {edit.subject ? `, ${edit.subject}` : null}
        </span>
        <time className="ms-auto shrink-0 tabular-nums">{dayTime(edit.sentAt)}</time>
      </div>
      <p className={cn("mt-1 max-w-[70ch] whitespace-pre-wrap break-words text-pretty select-text", large ? "text-sm leading-[22px]" : "text-[13px] leading-5")}>
        {edit.ops.map((op, i) => (
          <span key={i} className={cn(op.op === "+" && INS, op.op === "-" && DEL)}>
            {op.text}
          </span>
        ))}
      </p>
    </div>
  );
}

export function Evidence({ edits, large = false, framed = false, className }: { edits: readonly DraftEdit[]; large?: boolean; framed?: boolean; className?: string }) {
  if (framed)
    return (
      <div className={cn("overflow-hidden rounded-xl border border-border", className)}>
        {edits.map((edit, i) => (
          <div key={edit.draftId} className={cn("px-3 py-2.5", i > 0 && "border-t border-border")}>
            <Edit edit={edit} large={false} />
          </div>
        ))}
      </div>
    );
  return (
    <div className={cn("flex min-w-0 flex-col", large ? "gap-4" : "gap-3", className)}>
      {edits.map((edit) => (
        <Edit key={edit.draftId} edit={edit} large={large} />
      ))}
    </div>
  );
}

/** "from 3 edits" */
export const fromEdits = (n: number): string => `from ${n} ${n === 1 ? "edit" : "edits"}`;
