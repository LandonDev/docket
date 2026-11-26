import {
  ChevronRight,
  FoldVertical,
  UnfoldVertical,
} from "../chrome/icons";
import { Tip, TruncateTip } from "../components/tip";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Counts } from "../chrome/rail/changeRows";
import { TooltipProvider } from "../components/ui/tooltip";
import { useMemo, useState } from "react";
import { FileTypeIcon } from "../chrome/FileTypeIcon";
import { basename } from "../lib/fs";
import type { GithubPrDiff } from "../lib/githubTasks";
import {
  mergePrDiff,
  parsePrPatch,
  type PrDiffFile,
  type PrDiffLine,
} from "../lib/prDiff";
import { EmptyState } from "./SurfaceSkeleton";
import { DiffBody } from "./DiffBody";
import type { DiffRow } from "./diffRows";
import { DISCLOSURE_CHEVRON } from "../components/ui/disclosure";
import { cn } from "../lib/cn";

type Props = {
  diff: GithubPrDiff;
};

export function InboxPrDiff({ diff }: Props) {
  const files = useMemo(
    () => mergePrDiff(diff.files, parsePrPatch(diff.patch)),
    [diff],
  );
  const [open, setOpen] = useState<Set<string>>(() => {
    const next = new Set<string>();
    if (files[0]) next.add(files[0].path);
    return next;
  });

  if (files.length === 0) {
    return <EmptyState title="No file changes" />;
  }

  const fileLabel = files.length === 1 ? "1 file" : `${files.length} files`;

  return (
    <div className="inbox-pr-diff flex flex-col gap-3">
      {/* "3 files" and its tally are two values of one line: 4px apart. */}
      <div className="flex items-center gap-1 text-xs">
        <span className="text-muted-foreground">{fileLabel}</span>
        <Counts additions={diff.additions} deletions={diff.deletions} className="text-xs" />
        <TooltipProvider>
          <span className="ml-auto flex items-center gap-0.5">
            <Tip label="Expand all files">
              <Button variant="ghost" size="icon-sm" aria-label="Expand all files" onClick={() => setOpen(new Set(files.map((file) => file.path)))} className="text-muted-foreground">
                <UnfoldVertical className="size-3.5" />
              </Button>
            </Tip>
            <Tip label="Collapse all files">
              <Button variant="ghost" size="icon-sm" aria-label="Collapse all files" disabled={open.size === 0} onClick={() => setOpen(new Set())} className="text-muted-foreground">
                <FoldVertical className="size-3.5" />
              </Button>
            </Tip>
          </span>
        </TooltipProvider>
      </div>
      {diff?.truncated ? (
        <p className="text-xs text-muted-foreground">
          Too large to show the diffs
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {files.map((file) => (
          <PrFileCard
            key={file.path}
            file={file}
            expanded={open.has(file.path)}
            onToggle={() => {
              setOpen((current) => {
                const next = new Set(current);
                if (next.has(file.path)) next.delete(file.path);
                else next.add(file.path);
                return next;
              });
            }}
          />
        ))}
      </div>
    </div>
  );
}

function PrFileCard({
  file,
  expanded,
  onToggle,
}: {
  file: PrDiffFile;
  expanded: boolean;
  onToggle: () => void;
}) {
  const name = basename(file.path);
  const label =
    file.status === "renamed" && file.previousPath
      ? `${file.previousPath} → ${file.path}`
      : file.path;

  return (
    // The body eases open and shut on the one disclosure (Collapsible), mounted only while open.
    <Collapsible open={expanded} onOpenChange={onToggle} className="overflow-hidden rounded-lg border border-border">
      <CollapsibleTrigger
        // Still the design system's Button, by its slot as by its look.
        data-slot="button"
        render={<Button variant="ghost" size="sm" className="w-full justify-start gap-2 rounded-none px-2.5 text-left font-normal" />}
      >
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground", DISCLOSURE_CHEVRON, expanded && "rotate-90")} />
        <FileTypeIcon name={name} isDir={false} size={16} />
        <TruncateTip text={label}>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{label}</span>
        </TruncateTip>
        <Counts additions={file.additions} deletions={file.deletions} className="text-xs" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <PrFileBody file={file} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function PrFileBody({ file }: { file: PrDiffFile }) {
  if (file.binary) {
    return (
      <p className="border-t border-border px-3 py-3 text-xs text-muted-foreground">
        Binary file changed
      </p>
    );
  }
  if (file.lines.length === 0) {
    return (
      <p className="border-t border-border px-3 py-3 text-xs text-muted-foreground">
        No text changes
      </p>
    );
  }
  // The transcript's own diff: the same lines, tints, numbers, gaps between hunks and cap.
  return (
    <div className="inbox-pr-diff border-t border-border">
      <DiffBody rows={prDiffRows(file.lines)} inset />
    </div>
  );
}

/** A file's patch lines as the diff body's rows: a hunk's head is the gap
 *  between hunks (none before the first), context is `ctx`. */
export function prDiffRows(lines: readonly PrDiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of lines) {
    if (line.kind === "hunk") {
      if (rows.length > 0) rows.push({ type: "gap", text: "" });
      continue;
    }
    rows.push({
      type: line.kind === "context" ? "ctx" : line.kind,
      oldNo: line.oldNumber ?? undefined,
      newNo: line.newNumber ?? undefined,
      text: line.text,
    });
  }
  return rows;
}
