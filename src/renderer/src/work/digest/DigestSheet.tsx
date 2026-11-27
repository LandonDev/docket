import { useEffect, useState } from "react";
import type { TellRow } from "@shared/work/tell";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { BusyLabel, Button } from "../../components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { Item, ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { Region } from "../../components/bones";
import { useEnvironmentStatuses, useEnvironments } from "../../lib/connection";
import { IDLE_STATUS, type EnvironmentStatus } from "../../lib/connection/types";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { cn } from "../../lib/cn";
import { asSentence, asSentences, emptyLine, listSections, rowWhen, tellDetail, unansweredLine, type ListSection } from "./notice";
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
  return <RowLine row={row} now={now} day={day} job={row.sector ? jobName(row.sector) : null} detail={tellDetail(row, useWorkspaces())} />;
}

/** A row's words: its job's dot, its title and detail, its time. */
function RowLine({ row, now, day, job, detail }: { row: TellRow; now: number; day: string; job: string | null; detail: string | undefined }) {
  return (
    <>
      {/* On the title's line: a 16px box on a 20px line. */}
      <SectorDot sector={row.sector} className="mt-0.5" />
      {/* The list is the record: a long title or detail wraps, it is never cut. */}
      <span className="flex min-w-0 flex-1 flex-col wrap-anywhere">
        <span className="text-[13px] font-medium leading-5 text-foreground">
          {/* The dot is the job to the eye alone: a screen reader hears its name. */}
          {job ? <span className="sr-only">{job}: </span> : null}
          {row.title}
        </span>
        {detail ? <span className="text-xs leading-4 text-muted-foreground">{detail}</span> : null}
      </span>
      <span className="shrink-0 ps-2 text-xs leading-5 text-muted-foreground tabular-nums">{rowWhen(row, now, undefined, day)}</span>
    </>
  );
}

/** The bones' row: its words as the sample holds them, read from no store. */
const SampleRowBody = ({ row, now, day }: { row: TellRow; now: number; day: string }) => <RowLine row={row} now={now} day={day} job={null} detail={row.detail} />;

/** What the list's bones are drawn from: one day of four rows, every other one with a detail line. */
const SAMPLE_NOW = Date.UTC(2026, 10, 24, 15);
const sampleRow = (n: number, title: string, detail?: string): TellRow => ({
  id: `sample:${n}`,
  host: "sample:host",
  kind: "sample",
  workspaceId: null,
  group: "results",
  sector: "cosmic",
  title,
  ...(detail ? { detail } : {}),
  at: SAMPLE_NOW - n * 1_800_000,
  how: "digest",
  day: "2026-11-24",
  toldAt: null,
});
const SAMPLE_SECTIONS: ListSection[] = [
  {
    id: "sample:today",
    title: "Today, 8:00 AM",
    day: "2026-11-24",
    rows: [sampleRow(1, "Receipts to confirm", "3 from Friday"), sampleRow(2, "Morning summary of the build"), sampleRow(3, "Held: Invite Dana Reyes to review", "Waits for your press"), sampleRow(4, "Sign-in to Frame.io ends soon")],
  },
];

/** The day sections, the list's and its bones'. */
function Sections({ sections, now, onOpenRow, Body }: { sections: readonly ListSection[]; now: number; onOpenRow: (row: TellRow) => void; Body: typeof RowBody }) {
  return sections.map((section) => (
    <section key={section.id} aria-label={section.title} className="flex flex-col">
      {/* On its rows' title edge, past the dot's box. */}
      <h3 className="flex h-7 items-center ps-6 text-xs font-medium text-muted-foreground">{section.title}</h3>
      <ul className="flex flex-col">
        {section.rows.map((row) => (
          <li key={`${row.host}:${row.id}`}>
            {routeOf(row).to === "none" ? (
              <Item className={ROW}>
                <Body row={row} now={now} day={section.day} />
              </Item>
            ) : (
              <ItemButton className={cn(ROW, ROW_PRESS)} onClick={() => onOpenRow(row)}>
                <Body row={row} now={now} day={section.day} />
              </ItemButton>
            )}
          </li>
        ))}
      </ul>
    </section>
  ));
}

const STILL = (): void => {};

/**
 * The list itself, as the sheet's body draws it: its bones until every
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
  view: Pick<DigestView, "days" | "rows" | "loaded" | "answered">;
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
  return (
    // Until every host has answered, the sections themselves drawn from a sample day. It grows to the body's room, so an empty state centres in it.
    <Region className="flex-1" loading={!view.loaded} label="Loading" bones={() => <Sections sections={SAMPLE_SECTIONS} now={SAMPLE_NOW} onOpenRow={STILL} Body={SampleRowBody} />}>
      {view.loaded ? (
        <div className="flex flex-1 flex-col gap-4">
          <ListBody view={view} now={now} unanswered={unanswered} onOpenRow={onOpenRow} retrying={retrying} retry={retry} />
        </div>
      ) : null}
    </Region>
  );
}

function ListBody({
  view,
  now,
  unanswered,
  onOpenRow,
  retrying,
  retry,
}: {
  view: Pick<DigestView, "days" | "rows" | "answered">;
  now: number;
  unanswered: string;
  onOpenRow: (row: TellRow) => void;
  retrying: boolean;
  retry: () => void;
}) {
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
      <Sections sections={sections} now={now} onOpenRow={onOpenRow} Body={RowBody} />
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
