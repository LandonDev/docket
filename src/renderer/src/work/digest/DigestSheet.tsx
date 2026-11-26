import { useEffect, useState } from "react";
import type { TellRow } from "@shared/work/tell";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { BusyLabel, Button } from "../../components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { Item, ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { Skeleton } from "../../components/ui/skeleton";
import { useEnvironmentStatuses, useEnvironments } from "../../lib/connection";
import { IDLE_STATUS, type EnvironmentStatus } from "../../lib/connection/types";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { cn } from "../../lib/cn";
import { asSentence, asSentences, emptyLine, listSections, rowWhen, tellDetail, unansweredLine } from "./notice";
import { linkDownWords, linkIsDown } from "../shell/hostLinkDown";
import { retryLink } from "../shell/linkRetry";
import { useJobName } from "../jobName";
import { routeOf } from "./open";
import { loadDigest, type DigestView } from "./store";

/**
 * The digest's one list (docs/DESIGN.md "The digest"): everything Work told
 * him, newest day first, whether it interrupted or waited. A sheet from the
 * right, so it opens over whatever he is doing and needs no place in the
 * rail. One flat list a day; the job's dot is the only colour.
 */

const ROW = "-mx-2 w-[calc(100%+1rem)] flex-nowrap items-start gap-2 rounded-md px-2 py-1.5";

function RowBody({ row, now, day }: { row: TellRow; now: number; day: string }) {
  const jobName = useJobName();
  // A clash's jobs by their workspaces' names, whatever word the host wrote.
  const detail = tellDetail(row, useWorkspaces());
  return (
    <>
      {/* On the title's line: a 16px box on a 20px line. */}
      <SectorDot sector={row.sector} className="mt-0.5" />
      {/* The list is the record: a long title or detail wraps, it is never cut. */}
      <span className="flex min-w-0 flex-1 flex-col wrap-anywhere">
        <span className="text-[13px] font-medium leading-5 text-foreground">
          {/* The dot is the job to the eye alone: a screen reader hears its name. */}
          {row.sector ? <span className="sr-only">{jobName(row.sector)}: </span> : null}
          {row.title}
        </span>
        {detail ? <span className="text-xs leading-4 text-muted-foreground">{detail}</span> : null}
      </span>
      <span className="shrink-0 ps-2 text-xs leading-5 text-muted-foreground tabular-nums">{rowWhen(row, now, undefined, day)}</span>
    </>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col">
      {/* On the titles' edge, where the day's heading lands. */}
      <div className="flex h-7 items-center ps-6">
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
  onRetry: () => Promise<void>;
}) {
  // A retry on its way says so, and cannot be pressed twice.
  const [retrying, setRetrying] = useState(false);
  const retry = (): void => {
    setRetrying(true);
    void onRetry().finally(() => setRetrying(false));
  };
  if (!view.loaded) return <ListSkeleton />;
  const sections = listSections(view, now);
  if (sections.length === 0) {
    // With a host unheard, nothing here is not known to be nothing; what the others said is.
    return unanswered ? (
      <Empty>
        <EmptyHeader>
          {/* A host that answered with nothing is heard: its nothing leads, the silent one under it. */}
          <EmptyTitle>{view.answered ? emptyLine(now) : "The digest did not load"}</EmptyTitle>
          <EmptyDescription>{asSentence(unanswered)}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="secondary" size="sm" disabled={retrying} onClick={retry}>
            <BusyLabel busy={retrying} label="Retry" />
          </Button>
        </EmptyContent>
      </Empty>
    ) : (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{emptyLine(now)}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      {sections.map((section) => (
        <section key={section.id} aria-label={section.title} className="flex flex-col">
          {/* On its rows' title edge, past the dot's box. */}
          <h3 className="flex h-7 items-center ps-6 text-xs font-medium text-muted-foreground">{section.title}</h3>
          <ul className="flex flex-col">
            {section.rows.map((row) => (
              <li key={`${row.host}:${row.id}`}>
                {routeOf(row).to === "none" ? (
                  <Item className={ROW}>
                    <RowBody row={row} now={now} day={section.day} />
                  </Item>
                ) : (
                  <ItemButton className={cn(ROW, ROW_PRESS)} onClick={() => onOpenRow(row)}>
                    <RowBody row={row} now={now} day={section.day} />
                  </ItemButton>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {unanswered ? (
        // On the titles' edge, past the dot's box, as the headings are.
        <div data-digest-foot className="flex items-center gap-2 ps-6">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">{unanswered}</p>
          {/* Its word ends where the rows' times end; its box overhangs the column as a row's does. */}
          <Button variant="ghost" size="xs" className="-me-2" disabled={retrying} onClick={retry}>
            <BusyLabel busy={retrying} label="Retry" align="end" />
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** The body's box: the sheet's 20px inset, groups 16px apart, its own scroll. */
export const DIGEST_BODY = "flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-5 pb-5";
export const DIGEST_WIDTH = 480;

/**
 * The foot's words and its Retry for the hosts whose read failed. A host whose link is down is said in the link's one
 * wording ("The box is offline", `linkDownWords`), and Retry asks its link first (`retryLink`), since a read over a
 * link that is down only fails again; "did not answer" is kept for a host whose link is open.
 */
export function footOf(errors: readonly { environmentId: string }[], name: (id: string) => string, status: (id: string) => EnvironmentStatus): { unanswered: string; retry: () => Promise<void> } {
  const down = errors.filter((e) => linkIsDown(status(e.environmentId)));
  const silent = errors.filter((e) => !down.includes(e));
  return {
    unanswered: asSentences([...down.map((e) => linkDownWords(name(e.environmentId), status(e.environmentId))), unansweredLine(silent.map((e) => name(e.environmentId)))]),
    retry: async () => {
      await Promise.all(down.map((e) => retryLink(e.environmentId)));
      await loadDigest();
    },
  };
}

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
  const statuses = useEnvironmentStatuses();
  const { unanswered, retry } = footOf(view.errors, (id) => environments.find((env) => env.id === id)?.name ?? "A host", (id) => statuses.get(id) ?? IDLE_STATUS);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" width={DIGEST_WIDTH}>
        <SheetHeader>
          <SheetTitle>Digest</SheetTitle>
        </SheetHeader>
        <div className={DIGEST_BODY}>
          <DigestList view={view} now={now} unanswered={unanswered} onOpenRow={onOpenRow} onRetry={retry} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
