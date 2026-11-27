import type { ReactNode } from "react";
import { Bone, Bones } from "../components/bones";
import { PAGE_SCROLLER, PAGE_WIDTH } from "../components/pageLayout";
import { BusyLabel, Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Spinner } from "../components/ui/spinner";
import { STATS_SECTIONS } from "./statsSkeletonShape";
import { COLUMN_MAX_CLASS } from "./transcriptOutlineModel";

/**
 * The state kit (docs/DESIGN.md "Loading and empty states"): the fallback a
 * lazy surface (lib/lazyChunk.tsx) shows while its chunk loads, the line a
 * small section shows while it waits on an answer, and the one empty state.
 *
 * A skeleton here is the surface's own frame drawn from sample words, in
 * bones (components/bones.tsx): the surface's pieces are in the chunk still
 * on its way, so the drawing is written out here, in the type and the boxes
 * the surface lands in, and Skullet measures it. A screen whose pieces are
 * in hand draws its bones from those pieces instead (a `Region` with a
 * sample; docs/agents/loading-bones.md).
 */
export type SkeletonKind =
  /** A full page with a list column beside its content (Inbox, Notes; `lines` 3 for Notes): the title strip, the list's head and rows, the detail. */
  | "page"
  /** Search: the title strip holding its field, then `count` result rows (none for a search opened empty). */
  | "search"
  /** A page in the one 672px column under the title strip (Settings, Stats). */
  | "column"
  /** The Stats page: its title over each section's heading and the bone its chart holds, as the page's own wait. */
  | "stats"
  /** The Accounts page: its title over its sections' rows, each as tall as the row that lands (the usage bars' bones are the page's own, once its chunk is here). */
  | "accounts"
  /** A pane of text lines (the editor, release notes, an issue body). */
  | "pane"
  /** A diff: a header strip and two hunks (a diff pane, a PR diff). */
  | "diff"
  /** An edit row's diff in its card: `count` 20px lines (the rows it will show, at most 8), no header, no border. */
  | "diff-rows"
  /** A terminal: the dark host with a prompt block (the terminal, the dev servers pane). */
  | "terminal"
  /** A framed document (an HTML render, an image, a file). */
  | "frame"
  /** A thread while its transcript loads: prompts on the right, answers under them. */
  | "transcript"
  /** A list in a panel or page: `count` rows of a title over a line (the Inbox's), or Notes' three-line cards. */
  | "rows";

/*
 * The sample words. Nobody reads them: their lengths give the bones the
 * shape of real work, so a row's title is a title's length and a line of
 * prose a line's. Fixed literals, cycled by row.
 */
const TITLES = ["Review the release notes", "Check what changed on the box", "Plan the next pass", "Ask about the tunnel's port", "Sort the reading list", "Write up the findings", "Trim the rail", "Answer the open review"];
const LINES = ["What changed, and what to check first", "Three things to ask before Friday", "Fewer rows, the same reach", "Two papers and a long thread", "Left over from the last pass", "A page, no more"];
const PLACES = ["Docket · 2h", "The box · 5h", "Tracker · 1d", "Notes · 3d"];
const PROSE = [
  "Every read has a region of its own, so no part waits for the slowest.",
  "What is known at once is drawn at once.",
  "A list keeps the shape it last showed, and its bones are drawn from that shape.",
  "A read that fails says so, with Retry.",
  "Content that lands while someone types lands at once.",
  "Nothing moves when the rows arrive.",
];
const CODE = ["export function resolve(path: string, root: string): string {", "  if (!path.startsWith(root)) return root;", "  const parts = path.slice(root.length).split(sep);", "  return join(root, ...parts);", "  const kept = parts.filter(Boolean);"];
const cycle = <T,>(list: readonly T[], at: number): T => list[at % list.length]!;

/** The Inbox's and Notes' list column at its default width; both views start there. */
export const PAGE_LIST_WIDTH = 280;
/** The 40px title strip every full surface opens with (Search, Inbox, Notes, the pages). Bare, it is marked
 *  `skullet-own`: an empty box is a leaf Skullet would hide, hairline and all. */
const STRIP = "h-10 shrink-0 border-b border-border";
/** The most lines a diff's skeleton draws: past them the fold is already a screen's worth. */
export const DIFF_ROWS_SKELETON_CAP = 8;
/** A 13px line on its 20px box and a 12px line on its 16px box: a drawn row is exactly as tall as the row that replaces it. */
const LINE_13 = "truncate text-[13px] leading-5";
const LINE_12 = "truncate text-xs leading-4";

/** `count` lines of sample prose, one to a line box, in `className`'s type. */
function Prose({ count, className }: { count: number; className: string }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <p key={i} className={`truncate ${className}`}>
          {cycle(PROSE, i)}
        </p>
      ))}
    </>
  );
}

/**
 * List rows in the shape of what comes, line for line: one line (a search
 * hit: its 16px glyph, then the title, 28px), an inbox item (its 14px glyph
 * and title on a 20px line over a 16px line, 54px), or Notes' card (the
 * project and time on 16px, the title on 20px, the first words on 16px).
 */
function rowsOf(count: number, lines: 1 | 2 | 3): ReactNode {
  return Array.from({ length: count }, (_, i) =>
    lines === 3 ? (
      <div key={i} data-skeleton-row className="flex flex-col px-2 py-2">
        <p className={LINE_12}>{cycle(PLACES, i)}</p>
        <p className={`mt-1 ${LINE_13}`}>{cycle(TITLES, i)}</p>
        <p className={`mt-0.5 ${LINE_12}`}>{cycle(LINES, i)}</p>
      </div>
    ) : lines === 2 ? (
      <div key={i} data-skeleton-row className="flex flex-col gap-0.5 px-2 py-2">
        <div className="flex h-5 items-center gap-2">
          <Bone data-skeleton-glyph className="size-3.5 rounded-sm" />
          <p className={`min-w-0 ${LINE_13}`}>{cycle(TITLES, i)}</p>
        </div>
        <p className={`ps-[22px] ${LINE_12}`}>{cycle(LINES, i)}</p>
      </div>
    ) : (
      <div key={i} data-skeleton-row className="flex h-7 items-center gap-2 px-2">
        <Bone data-skeleton-glyph className="size-4 rounded-sm" />
        <p className={`min-w-0 ${LINE_13}`}>{cycle(TITLES, i)}</p>
      </div>
    ),
  );
}

/** A list of rows as the real lists hold them: 4px in, 2px apart. */
function listOf(count: number, lines: 2 | 3): ReactNode {
  return <div className="flex flex-col gap-0.5 p-1">{rowsOf(count, lines)}</div>;
}

function body(kind: SkeletonKind, count: number, lines: 2 | 3): ReactNode {
  switch (kind) {
    case "page":
      // The Inbox's and Notes' frame: the strip; the list column at its
      // default width, its head (the Inbox's source tabs over its field, or
      // Notes' field alone) and its rows; then the detail's meta line,
      // title and lines in the detail's own column.
      return (
        <>
          <div data-skeleton-strip skullet-own="" className={STRIP} />
          <div className="flex min-h-0 flex-1">
            <div data-skeleton-list className="flex shrink-0 flex-col border-r border-border" style={{ width: PAGE_LIST_WIDTH }}>
              <div data-skeleton-head className="flex shrink-0 flex-col gap-2 border-b border-border p-2">
                {lines === 2 ? <Bone data-skeleton-field className="h-8 w-full rounded-lg" /> : null}
                <Bone data-skeleton-field className="h-8 w-full rounded-lg" />
              </div>
              {listOf(8, lines)}
            </div>
            {/* Padded inside the detail's 1,024px column, as the Inbox's and Notes' details are. */}
            <div data-skeleton-detail className="@container/detail min-w-0 flex-1">
              <div className="mx-auto w-full max-w-5xl px-4 pt-8 @xl/detail:px-8">
                <p className={LINE_12}>{PLACES[0]}</p>
                <p className="mt-2 truncate text-base font-semibold leading-6 tracking-[-0.01em]">{TITLES[0]}</p>
                <div className="mt-6 flex flex-col gap-1">
                  <Prose count={6} className="text-[13px] leading-5" />
                </div>
              </div>
            </div>
          </div>
        </>
      );
    case "search":
      // The strip is the search's field, 12px in as the field is; rows only
      // where a query is set, since an empty search lands as the field alone.
      return (
        <>
          <div data-skeleton-strip className={`${STRIP} flex items-center px-3`}>
            <Bone data-skeleton-field className="h-8 flex-1 rounded-lg" />
          </div>
          {count > 0 ? <div className="flex flex-col p-1">{rowsOf(count, 1)}</div> : null}
        </>
      );
    case "accounts":
      // The page's frame and its title in words (known before anything loads, as Stats'), then its sections' rows where the page
      // draws them from its sample (aliax/views/accounts/samples.ts, AccountsAtRest):
      // no line, since the page has none. The usage bars' bones stay with the
      // page's chunk (6 kB the first paint does not carry); an empty box their
      // height holds each row's, so nothing moves when the chunk lands.
      return (
        <>
          <div data-skeleton-strip skullet-own="" className={STRIP} />
          <div data-skeleton-scroller className={PAGE_SCROLLER}>
            <div data-skeleton-column className={`mx-auto w-full p-6 ${PAGE_WIDTH.table}`}>
              <p skullet-own="" className="text-base font-semibold leading-6 tracking-[-0.01em] text-foreground">
                Accounts
              </p>
              <div className="@container/accounts mt-6 flex flex-col gap-6">
                {["Claude accounts", "Codex accounts", "Other accounts"].map((section) => (
                  <div key={section} className="flex flex-col">
                    <p className="flex h-5 items-center text-xs font-medium">{section}</p>
                    <div className="mt-2 flex flex-col">
                      {["Personal account", "Work account"].map((row) => (
                        <div key={row} data-slot="account-row-skeleton" className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                          <Bone className="size-2 rounded-full" />
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <p className={`${LINE_13} font-medium`}>{row}</p>
                            <p className={LINE_12}>name@example.com</p>
                          </div>
                          <span aria-hidden skullet-ignore="" data-skeleton-bars className="order-last h-14 basis-full @3xl/accounts:order-none @3xl/accounts:basis-auto" />
                          <span className="flex items-center gap-2">
                            <Bone data-skeleton-switch className="h-[18px] w-8 rounded-full" />
                            <Bone className="size-7 rounded-md" />
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      );
    case "column":
      // components/page.tsx's frame: the strip, then Page's column in the
      // page's own scroller, with its title, its line and rows in the shape
      // of the page it stands in for.
      return (
        <>
          <div data-skeleton-strip skullet-own="" className={STRIP} />
          <div data-skeleton-scroller className={PAGE_SCROLLER}>
            <div data-skeleton-column className={`mx-auto w-full p-6 ${PAGE_WIDTH.column}`}>
              <p className="truncate text-base font-semibold leading-6 tracking-[-0.01em]">Appearance</p>
              <p className={`mt-1 ${LINE_12}`}>How the window looks and moves on this computer</p>
              <div className="mt-6 flex flex-col">
                {Array.from({ length: count }, (_, i) => (
                  <div key={i} className="flex items-center gap-3 py-3">
                    <p className={`min-w-0 flex-1 ${LINE_13}`}>{cycle(TITLES, i)}</p>
                    <Bone className="h-8 w-40 rounded-lg" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      );
    case "stats":
      // The page's frame and title, then the page's own wait (aliax/views/stats.tsx SectionBones): each section's
      // heading over the bone its chart holds, in words, so the page's wait lands on the same lines. No line under
      // the title: the page has none until its first read.
      return (
        <>
          <div data-skeleton-strip skullet-own="" className={STRIP} />
          <div data-skeleton-scroller className={PAGE_SCROLLER}>
            <div data-skeleton-column className={`mx-auto w-full p-6 ${PAGE_WIDTH.column}`}>
              <p skullet-own="" className="text-base font-semibold leading-6 tracking-[-0.01em] text-foreground">
                Stats
              </p>
              <div className="mt-6 flex flex-col gap-6">
                {STATS_SECTIONS.map((s) => (
                  <div key={s.title} className="min-w-0">
                    <p skullet-own="" className="flex h-5 items-center text-xs font-medium text-muted-foreground">
                      {s.title}
                    </p>
                    {s.description ? <p className={LINE_12}>What this chart counts, in one line</p> : null}
                    <Bone data-section-skeleton={s.title} className="mt-2 w-full rounded-lg" style={{ height: s.height }} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      );
    case "pane":
      return (
        <div className="flex max-w-2xl flex-col p-4">
          <Prose count={12} className="text-xs leading-5" />
        </div>
      );
    case "diff":
      return (
        <>
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
            <p className="min-w-0 truncate font-mono text-xs">src/main/server/paths.ts</p>
            <p className="ms-auto shrink-0 text-xs">+12 −4</p>
          </div>
          <div className="flex max-w-2xl flex-col gap-4 p-3">
            {[0, 1].map((hunk) => (
              <div key={hunk} className="flex flex-col">
                <p className="truncate font-mono text-xs leading-5">@@ -24,7 +24,9 @@</p>
                {CODE.map((line) => (
                  <p key={line} className="truncate font-mono text-xs leading-5 whitespace-pre">
                    {line}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </>
      );
    case "diff-rows":
      // DiffBody's geometry: 4px top and bottom, 20px lines, the code 12px
      // in past the inset, the number column and the mark.
      return Array.from({ length: Math.min(Math.max(count, 1), DIFF_ROWS_SKELETON_CAP) }, (_, i) => (
        <div key={i} data-skeleton-row className="flex h-5 items-center ps-13 pe-3">
          <p className="truncate font-mono text-xs whitespace-pre">{cycle(CODE, i)}</p>
        </div>
      ));
    case "terminal":
      return (
        <div className="min-h-0 flex-1 p-2">
          <p className="font-mono text-xs leading-4">~/work/docket $</p>
        </div>
      );
    case "frame":
      return <Bone className="min-h-24 w-full flex-1 rounded-xl" />;
    case "transcript":
      return (
        <div className={`mx-auto flex w-full min-w-0 ${COLUMN_MAX_CLASS} flex-col gap-8`}>
          {[3, 4, 5].map((answer, i) => (
            <div key={i} className="flex flex-col gap-4">
              <Bone data-skeleton-prompt className="h-9 w-2/5 self-end rounded-xl" />
              <div className="flex flex-col gap-1">
                <Prose count={answer} className="text-[13px] leading-5" />
              </div>
            </div>
          ))}
        </div>
      );
    case "rows":
      return listOf(count, lines);
  }
}

const FRAME: Record<SkeletonKind, string> = {
  page: "flex min-h-0 min-w-0 flex-1 flex-col",
  search: "flex min-h-0 min-w-0 flex-1 flex-col",
  column: "flex min-h-0 min-w-0 flex-1 flex-col",
  stats: "flex min-h-0 min-w-0 flex-1 flex-col",
  accounts: "flex min-h-0 min-w-0 flex-1 flex-col",
  pane: "flex h-full min-h-0 w-full flex-col overflow-hidden",
  diff: "flex h-full min-h-0 w-full flex-col overflow-hidden",
  "diff-rows": "w-full py-1",
  terminal: "docket-terminal flex h-full min-h-0 w-full flex-col",
  frame: "flex h-full min-h-0 w-full flex-col p-3",
  transcript: "flex h-full min-h-0 w-full flex-col overflow-hidden px-4 pt-6",
  rows: "w-full",
};
/** The kinds that fill the room they are given; the rest are as tall as their rows. */
const FILLS: ReadonlySet<SkeletonKind> = new Set(["page", "search", "column", "stats", "accounts", "pane", "diff", "terminal", "frame", "transcript"]);

export function SurfaceSkeleton({
  kind,
  label,
  count = 4,
  lines = 2,
}: {
  kind: SkeletonKind;
  label?: string;
  count?: number;
  /** `rows` and `page`: 2 draws the Inbox's two-line rows (and, on a page,
   *  its source tabs over the field), 3 Notes' three-line cards. */
  lines?: 2 | 3;
}) {
  return (
    // The frame names the wait; the bones inside it say nothing more (an empty label).
    <div role="status" aria-label={label ?? "Loading"} aria-busy data-surface-skeleton={kind} className={FRAME[kind]}>
      <Bones label="" fill={FILLS.has(kind)}>
        {body(kind, count, lines)}
      </Bones>
    </div>
  );
}

/** A small section waiting on an answer whose shape is unknown: a spinner
 *  beside its word, centred. */
export function LoadingLine({ label }: { label: string }) {
  return (
    <div role="status" aria-busy className="flex select-none items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
      <Spinner aria-hidden className="size-3.5" />
      <span>{label}</span>
    </div>
  );
}

/** The one empty state of a panel, pane or page: a title, at most one line
 *  and one action. A picker's "no match" is a muted row, never this. */
export function EmptyState({ title, line, action }: { title: string; line?: string; action?: { label: string; onClick: () => void; /** the press is out: it spins in place, held */ busy?: boolean } }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {line ? <EmptyDescription>{line}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? (
        <Button size="sm" variant="secondary" disabled={action.busy} onClick={action.onClick}>
          {/* Only a press that can be out draws the busy label: every other one is the plain label it always was. */}
          {action.busy === undefined ? action.label : <BusyLabel busy={action.busy} label={action.label} />}
        </Button>
      ) : null}
    </Empty>
  );
}
