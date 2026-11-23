import { useEffect } from "react";
import type { TellRow } from "@shared/work/tell";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { Button } from "../../components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { Item, ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { Skeleton } from "../../components/ui/skeleton";
import { useEnvironments } from "../../lib/connection";
import { cn } from "../../lib/cn";
import { emptyLine, listSections, rowWhen } from "./notice";
import { routeOf } from "./open";
import { loadDigest, type DigestView } from "./store";

/**
 * The digest's one list (docs/DESIGN.md "The digest"): everything Work told
 * him, newest day first, whether it interrupted or waited. A sheet from the
 * right, so it opens over whatever he is doing and needs no place in the
 * rail. One flat list a day; the job's dot is the only colour.
 */

/** "The Mac did not answer", "The Mac and the box did not answer". */
export function unansweredLine(names: readonly string[]): string {
  if (names.length === 0) return "";
  const said = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${said} did not answer`;
}

const ROW = "-mx-2 w-[calc(100%+1rem)] flex-nowrap items-start gap-2 rounded-md px-2 py-1.5";

function RowBody({ row, now }: { row: TellRow; now: number }) {
  return (
    <>
      {/* On the title's line: a 16px box on a 20px line. */}
      <SectorDot sector={row.sector} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium leading-5 text-foreground">{row.title}</span>
        {row.detail ? <span className="truncate text-xs leading-4 text-muted-foreground">{row.detail}</span> : null}
      </span>
      <span className="shrink-0 ps-2 text-xs leading-5 text-muted-foreground tabular-nums">{rowWhen(row, now)}</span>
    </>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col">
      <div className="flex h-7 items-center">
        <Skeleton className="h-3 w-24" />
      </div>
      {[52, 44, 60, 40].map((width, i) => (
        <div key={i} className="flex items-start gap-2 py-1.5">
          <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
            <Skeleton className="size-2 rounded-full" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex h-5 items-center">
              <Skeleton className="h-3.5" style={{ width: `${width}%` }} />
            </span>
            {i % 2 === 0 ? (
              <span className="flex h-4 items-center">
                <Skeleton className="h-3 w-28" />
              </span>
            ) : null}
          </span>
          <span className="flex h-5 shrink-0 items-center ps-2">
            <Skeleton className="h-3 w-12" />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The list itself, as the sheet's body draws it: a skeleton until every
 * host has answered, one empty state, else the sections; a host that did
 * not answer is one muted line at the foot.
 */
export function DigestList({
  view,
  now,
  unanswered,
  onOpenRow,
  onRetry,
}: {
  view: Pick<DigestView, "days" | "rows" | "loaded">;
  now: number;
  /** "The Mac did not answer", or "" when every host did */
  unanswered: string;
  onOpenRow: (row: TellRow) => void;
  onRetry: () => void;
}) {
  if (!view.loaded) return <ListSkeleton />;
  const sections = listSections(view, now);
  if (sections.length === 0) {
    // With a host unheard, nothing here is not known to be nothing.
    return unanswered ? (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>The digest did not load</EmptyTitle>
          <EmptyDescription>{unanswered}.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </EmptyContent>
      </Empty>
    ) : (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing waited</EmptyTitle>
          <EmptyDescription>{emptyLine(now)}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      {sections.map((section) => (
        <section key={section.id} aria-label={section.title} className="flex flex-col">
          <h3 className="flex h-7 items-center text-xs font-medium text-muted-foreground">{section.title}</h3>
          <ul className="flex flex-col">
            {section.rows.map((row) => (
              <li key={`${row.host}:${row.id}`}>
                {routeOf(row).to === "none" ? (
                  <Item className={ROW}>
                    <RowBody row={row} now={now} />
                  </Item>
                ) : (
                  <ItemButton className={cn(ROW, ROW_PRESS)} onClick={() => onOpenRow(row)}>
                    <RowBody row={row} now={now} />
                  </ItemButton>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {unanswered ? (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">{unanswered}</p>
          <Button variant="ghost" size="xs" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** The body's box: the sheet's 20px inset, groups 16px apart, its own scroll. */
export const DIGEST_BODY = "flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-5 pb-5";
export const DIGEST_WIDTH = 480;

export function DigestSheet({
  open,
  onOpenChange,
  view,
  now,
  onOpenRow,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: DigestView;
  now: number;
  /** A row's press: its target opens and the sheet closes. */
  onOpenRow: (row: TellRow) => void;
}) {
  const environments = useEnvironments();
  // What a push missed while the sheet was shut is read as it opens.
  useEffect(() => {
    if (open) void loadDigest();
  }, [open]);
  const unanswered = unansweredLine(view.errors.map((e) => environments.find((env) => env.id === e.environmentId)?.name ?? "A host"));
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" width={DIGEST_WIDTH}>
        <SheetHeader>
          <SheetTitle>Digest</SheetTitle>
        </SheetHeader>
        <div className={DIGEST_BODY}>
          <DigestList view={view} now={now} unanswered={unanswered} onOpenRow={onOpenRow} onRetry={() => void loadDigest()} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
