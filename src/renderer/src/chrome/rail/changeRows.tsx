import { cn } from "@renderer/lib/cn";
import { Counts as DiffCounts } from "../../surfaces/transcript/Counts";
import { basename } from "../../lib/fs";

/* The pieces of a changed-file row the Changes section's two groups share
   (ChangesPanel's index rows, ChangesAgainst's rows against a target). */

/** `+n −n` in the diff colours; New for a file git has not seen, Deleted for one that is gone. */
export function Counts({ status, additions, deletions, className }: { status?: string; additions: number; deletions: number; className?: string }) {
  if (status === "untracked" || status === "added") return <span data-slot="counts" className={cn("font-sans text-muted-foreground", className)}>New</span>;
  if (status === "deleted") return <span data-slot="counts" className={cn("font-sans text-muted-foreground", className)}>Deleted</span>;
  return <DiffCounts added={additions} removed={deletions} className={cn("font-sans", className)} />;
}

/** A file's name with its folder after it, the folder truncating first and from its start
 *  ("…renderer/src/lib"), so its last folder is what stays: the leading part laid out right to
 *  left, held in its order between two left-to-right marks, so a leading "." never jumps to the end.
 *  Where not even the last folder would show whole, the folder is dropped: the line wraps, and the
 *  one-line box hides what wrapped (no measuring, no hook per row). */
export function FileName({ relative, muted }: { relative: string; muted?: boolean }) {
  const name = basename(relative);
  const dir = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
  const cut = dir.lastIndexOf("/");
  const lead = cut < 0 ? "" : dir.slice(0, cut + 1);
  const last = cut < 0 ? dir : dir.slice(cut + 1);
  return (
    <span className="flex h-5 min-w-0 flex-wrap items-baseline gap-x-2 overflow-hidden leading-5">
      <span className={cn("max-w-full shrink-0 truncate text-[13px]", muted ? "text-muted-foreground" : "text-foreground")}>{name}</span>
      {dir ? (
        // The lead keeps room for its whole ellipsis ("…/rail"): less, and the folder wraps away.
        <span data-slot="file-folder" className={cn("grow basis-0 items-baseline text-xs text-muted-foreground", lead ? "grid grid-cols-[minmax(1em,max-content)_max-content]" : "flex")}>
          {lead ? <span dir="rtl" className="min-w-0 truncate text-left">{`\u200E${lead}\u200E`}</span> : null}
          <span>{last}</span>
        </span>
      ) : null}
    </span>
  );
}
