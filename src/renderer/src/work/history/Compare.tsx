import type { ReactNode } from "react";
import { inlineSegments, type InlineSegment } from "work-kit/formats/diff";
import type { BlockDiff, DiffBlock, DiffLine, DiffRow, DiffRun } from "@shared/contract-work-history";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";

/**
 * A compare drawn from the block diff (docs/agents/work-history.md, the
 * approved history prototype): one column, where each change stands in its
 * sentence as a suggestion is drawn (taken words struck on `del-bg`, new
 * words on `add-bg`), or side by side, the older version left and the newer
 * right in one scroll, a blank holding the place where a side has nothing.
 * Read only: nothing here edits. A line's change carries `data-row` so the
 * stepper can bring it into view; the current one is outlined.
 */

export type Layout = "one" | "sxs";

/** Which side a block is drawn for: both (one column), or one side of a pair. */
type Side = "both" | "left" | "right";

const CUR = "rounded-[2px] outline-1 outline-offset-2 outline-[color-mix(in_srgb,var(--foreground)_40%,transparent)]";
const INS = "rounded-[2px] bg-(--add-bg) box-decoration-clone";
// Removed words keep 70% of the ink, so they read on the tint in both themes.
const DEL = "rounded-[2px] bg-(--del-bg) box-decoration-clone text-foreground/70 line-through decoration-[color-mix(in_srgb,var(--destructive)_70%,transparent)]";

function styled(run: Pick<DiffRun, "styles" | "href" | "kind">, text: ReactNode, key: number): ReactNode {
  if (run.kind) return <sup key={key} className="text-muted-foreground">*</sup>;
  const s = run.styles ?? {};
  const cls = cn(!!s.bold && "font-semibold", !!s.italic && "italic", !!s.underline && "underline underline-offset-2", !!s.strike && "line-through", !!s.code && "rounded-[4px] bg-muted px-1 font-mono text-[0.9em]", run.href && "text-accent underline underline-offset-2");
  return cls ? (
    <span key={key} className={cls}>
      {text}
    </span>
  ) : (
    <span key={key}>{text}</span>
  );
}

/** Words as they are: one block's runs, unchanged. */
const plain = (runs: readonly DiffRun[]): ReactNode => runs.map((r, i) => styled(r, r.text, i));

/** A changed block's words: on a side, only that side's runs; in one column, both, the taken first. */
function changed(segments: readonly InlineSegment[], side: Side, cur: boolean): ReactNode {
  return segments
    .filter((s) => side === "both" || (side === "left" ? s.op !== "+" : s.op !== "-"))
    .map((s, i, all) => {
      const inner = styled(s, s.text, i);
      if (s.op === "=") return inner;
      // Taken words then new ones read as two: a space's width between them, as the prototype draws it, with no space in the text.
      const after = s.op === "+" && all[i - 1]?.op === "-";
      return (
        <span key={i} className={cn(s.op === "+" ? INS : DEL, after && "ms-1.5", cur && CUR)}>
          {inner}
        </span>
      );
    });
}

/** A table, cell by cell: a changed cell shows its words' change. */
function Table({ block, other, row, side, compact, cur }: { block: DiffBlock; other: DiffBlock | null; row: DiffRow | null; side: Side; compact: boolean; cur: boolean }) {
  const cells = block.table ?? [];
  return (
    <table className={cn("mt-2 w-full border-collapse", compact ? "text-[13px] leading-5" : "text-sm leading-5")}>
      <tbody>
        {cells.map((cellsOfRow, r) => (
          <tr key={r}>
            {cellsOfRow.map((cell, c) => {
              const ops = row?.cells?.[r]?.[c] ?? null;
              // `block` is the newer side unless this is the left column of a pair.
              const theirs = other?.table?.[r]?.[c] ?? cell;
              const left = side === "left" ? cell : theirs;
              const right = side === "left" ? theirs : cell;
              const content = ops ? changed(inlineSegments(left, right, ops), side, cur) : plain(cell);
              const Cell = r === 0 ? "th" : "td";
              return (
                <Cell key={c} className={cn("border border-border text-start align-top", compact ? "px-2 py-1" : "px-3 py-1.5", r === 0 && "bg-muted font-semibold")}>
                  {content}
                </Cell>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Text size and space for a block type, on the document scale (one column) or a step down (side by side). */
function shapeOf(type: string, level: number, compact: boolean): string {
  if (type === "heading")
    return level <= 1
      ? cn("mt-5 font-semibold tracking-[-0.01em]", compact ? "text-[15px] leading-[22px]" : "text-base leading-6")
      : cn("mt-5 font-medium", compact ? "text-sm leading-[22px]" : "text-[15px] leading-6", level >= 3 && "text-muted-foreground");
  return "mt-1";
}

interface BlockProps {
  block: DiffBlock;
  /** the same block on the other side, for a changed one */
  other: DiffBlock | null;
  row: DiffRow | null;
  /** whole-block tint: added or taken away */
  mark: "add" | "del" | null;
  side: Side;
  compact: boolean;
  /** the number a numbered item shows */
  number: number;
  /** the stepper is on this block's change: its changed words are outlined (the block, when no word changed) */
  cur: boolean;
}

function Block({ block, other, row, mark, side, compact, number, cur }: BlockProps) {
  const level = Number(block.props.level ?? 1);
  const indent = { paddingInlineStart: `${block.depth * 24}px` };
  if (block.type === "table")
    return (
      <div style={indent} className={cn(mark === "add" && INS, mark === "del" && DEL, cur && (mark || !row?.cells) && CUR)}>
        <Table block={block} other={other} row={row} side={side} compact={compact} cur={cur && !mark} />
      </div>
    );
  if (block.type === "pageBreak") return <hr style={indent} className="my-4 border-border" />;
  // A changed block draws its words' change: the older side's runs against the newer's.
  const ops = !mark && other ? row?.inline : undefined;
  const words = ops ? changed(side === "left" ? inlineSegments(block.runs, other!.runs, ops) : inlineSegments(other!.runs, block.runs, ops), side, cur) : plain(block.runs);
  const text = mark ? <span className={cn(mark === "add" ? INS : DEL, cur && CUR)}>{words}</span> : words;
  const media = ["image", "video", "audio", "file"].includes(block.type);
  const lead =
    block.type === "bulletListItem" ? (
      <span aria-hidden className={cn("absolute start-2 size-[5px] rounded-full", compact ? "top-[9px]" : "top-[10px]", mark === "add" ? "bg-success" : "bg-muted-foreground")} />
    ) : block.type === "numberedListItem" ? (
      <span aria-hidden className="absolute start-0 w-[18px] text-end text-muted-foreground tabular-nums">
        {number}.
      </span>
    ) : block.type === "checkListItem" ? (
      <span aria-hidden className={cn("absolute start-0.5 size-3.5 rounded-[4px] border border-border", compact ? "top-1" : "top-[5px]", block.props.checked === true && "bg-foreground")} />
    ) : null;
  return (
    <div style={indent}>
      <div
        className={cn(
          "relative",
          shapeOf(block.type, level, compact),
          lead && "ps-[22px]",
          block.type === "quote" && "ps-4 text-muted-foreground italic",
          block.type === "codeBlock" && "rounded-md bg-muted px-3 py-2 font-mono text-[13px] leading-5 whitespace-pre-wrap",
          media && "text-muted-foreground",
          // A change with no words of its own (a type, a colour, a move): the block is what is outlined.
          cur && !mark && !ops && CUR,
        )}
      >
        {lead}
        {media ? (block.props.caption || block.props.name || block.props.url ? String(block.props.caption || block.props.name || block.props.url) : block.type) : text}
        {block.text === "" && !media ? <br /> : null}
      </div>
    </div>
  );
}

/** A numbered item's number: its place in the run of numbered items before it at its depth, on its side. */
function numbering(lines: readonly DiffLine[], pick: (line: DiffLine) => DiffBlock | null): number[] {
  const out: number[] = [];
  let run = 0;
  let depth = -1;
  for (const line of lines) {
    const b = pick(line);
    if (!b) {
      out.push(0);
      continue;
    }
    if (b.type === "numberedListItem") {
      run = depth === b.depth ? run + 1 : Number(b.props.start ?? 1);
      depth = b.depth;
    } else {
      run = 0;
      depth = -1;
    }
    out.push(run);
  }
  return out;
}

/** One line of the compare in one column: the newer side's block, or the side that has it. */
function OneLine({ line, rows, current, number }: { line: DiffLine; rows: readonly DiffRow[]; current: number; number: number }) {
  const row = line.row === null ? null : rows[line.row]!;
  const block = line.right ?? line.left!;
  const mark = line.right && line.left ? null : line.row === null ? null : line.right ? "add" : "del";
  return (
    <div data-row={line.row ?? undefined}>
      <Block block={block} other={line.right && line.left ? line.left : null} row={row} mark={mark} side="both" compact={false} number={number} cur={line.row !== null && line.row === current} />
    </div>
  );
}

const Gap = () => <div aria-hidden className="mt-1 h-[calc(100%-4px)] min-h-[22px] rounded-[4px] bg-(--diff-gap)" />;

export function CompareDoc({ diff, layout, current, title }: { diff: BlockDiff; layout: Layout; current: number; title: string }) {
  const { lines, rows } = diff;
  if (layout === "one") {
    const numbers = numbering(lines, (l) => l.right ?? l.left);
    return (
      <div className="px-6 pt-6 pb-12">
        <div className="mx-auto max-w-[672px] text-[15px] leading-6 [overflow-wrap:anywhere] select-text">
          <div className="text-lg leading-[26px] font-semibold tracking-[-0.01em] text-balance">{title}</div>
          <div className="mt-4">
            {lines.map((line, i) => (
              <OneLine key={`${line.id}:${i}`} line={line} rows={rows} current={current} number={numbers[i]!} />
            ))}
          </div>
        </div>
      </div>
    );
  }
  const left = numbering(lines, (l) => l.left);
  const right = numbering(lines, (l) => l.right);
  const cell = (line: DiffLine, i: number, side: "left" | "right") => {
    const block = line[side];
    const other = line[side === "left" ? "right" : "left"];
    if (!block) return <Gap />;
    const row = line.row === null ? null : rows[line.row]!;
    const mark = other ? null : line.row === null ? null : side === "left" ? "del" : "add";
    return <Block block={block} other={other} row={row} mark={mark} side={side} compact number={(side === "left" ? left : right)[i]!} cur={line.row !== null && line.row === current} />;
  };
  return (
    // The rule between the columns runs the body's whole height, however short a side is.
    <div className="relative grid grow grid-cols-[minmax(0,1fr)_minmax(0,1fr)] content-start pb-12 text-sm leading-[22px] [overflow-wrap:anywhere] select-text before:absolute before:inset-y-0 before:start-1/2 before:w-px before:bg-border">
      <div className="px-4 pt-5 text-base leading-6 font-semibold tracking-[-0.01em]">{title}</div>
      <div className="px-4 pt-5 text-base leading-6 font-semibold tracking-[-0.01em]">{title}</div>
      {lines.map((line, i) => (
        <div key={`${line.id}:${i}`} className="contents">
          <div data-row={line.row ?? undefined} className="px-4">
            {cell(line, i, "left")}
          </div>
          <div data-row={line.row ?? undefined} className="px-4">
            {cell(line, i, "right")}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The shape of a compare while it loads: a document's lines, once or twice. */
export function CompareSkeleton({ layout }: { layout: Layout }) {
  const lines = (
    <div className="mx-auto flex w-full max-w-[672px] flex-col gap-3 p-6">
      {[
        [42, 18],
        [20, 16],
        [88, 14],
        [76, 14],
        [62, 14],
        [24, 16],
        [90, 14],
        [70, 14],
      ].map(([w, h], i) => (
        <Skeleton key={i} style={{ width: `${w}%`, height: `${h}px`, marginTop: h === 16 ? 12 : 0 }} />
      ))}
    </div>
  );
  if (layout === "one") return lines;
  return (
    <div className="grid grid-cols-2">
      {lines}
      <div className="border-s border-border">{lines}</div>
    </div>
  );
}
