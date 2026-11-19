import type { HistoryBranch } from "@shared/contract-work-history";
import type { DiffRow, InlineOp } from "@shared/contract-work-history";
import type { ReviewChange, ReviewGroup, ReviewMark } from "work-kit/editor";

/**
 * A document's pending branches as the editor's review (docs/agents/work-docs.md
 * "Suggestions"): one group a branch, labelled by whose it is; one change a
 * piece of a block's words (a replacement, words put in or taken away), so he
 * takes "8:00 becomes 7:30" without the rest of the line; a block put in,
 * taken away or moved, or a table whose cells changed, is one change. A
 * change's id names what Accept sends: the branch, then the block's id, or
 * `<block>#<n>` for a piece (work-kit `inlinePieces`' order).
 */

/** A change's id: `<branch>|<what work.history.decide takes>`. */
export const changeId = (branchId: string, which: string): string => `${branchId}|${which}`;
export function decided(change: ReviewChange): { branchId: string; which: string } {
  const at = change.id.indexOf("|");
  return { branchId: change.id.slice(0, at), which: change.id.slice(at + 1) };
}

/** Pieces of a block's words, as work-kit's `inlinePieces` cuts them: runs of ops with no kept words between. */
export function pieces(ops: readonly InlineOp[]): InlineOp[][] {
  const out: InlineOp[][] = [];
  let open: InlineOp[] | null = null;
  for (const op of ops) {
    if (op.text === "") continue;
    if (op.op === "=") {
      open = null;
      continue;
    }
    if (!open) out.push((open = []));
    open.push(op);
  }
  return out;
}

/** Each piece's marks, offsets counted in the shown (live) words. */
function pieceMarks(block: string, ops: readonly InlineOp[]): ReviewMark[][] {
  const out: ReviewMark[][] = [];
  let at = 0;
  let open: ReviewMark[] | null = null;
  for (const { op, text } of ops) {
    if (text === "") continue;
    if (op === "=") {
      open = null;
      at += text.length;
      continue;
    }
    if (!open) out.push((open = []));
    if (op === "+") open.push({ tone: "add", block, at, text });
    else {
      open.push({ tone: "del", block, from: at, to: at + text.length });
      at += text.length;
    }
  }
  return out;
}

function cellMarks(block: string, cells: NonNullable<DiffRow["cells"]>): ReviewMark[] {
  return cells.flatMap((row, r) => row.flatMap((ops, c) => (ops ? pieceMarks(block, ops).flat().map((m) => ({ ...m, cell: [r, c] as [number, number] })) : [])));
}

/** The live block a new block would follow: the nearest line before it that the live text has. */
function afterOf(branch: HistoryBranch, id: string): string | null {
  const lines = branch.diff.lines;
  const at = lines.findIndex((l) => l.id === id && l.right && !l.left);
  for (let i = (at < 0 ? lines.findIndex((l) => l.id === id) : at) - 1; i >= 0; i--) if (lines[i]!.left) return lines[i]!.id;
  return null;
}

export function reviewOf(branches: readonly HistoryBranch[], names: Record<string, string>): { changes: ReviewChange[]; groups: ReviewGroup[] } {
  const changes: ReviewChange[] = [];
  const groups: ReviewGroup[] = [];
  for (const branch of branches) {
    const by = branch.authors[0] ?? "owner";
    groups.push({ id: branch.id, label: names[by] ?? "Someone", by });
    for (const row of branch.diff.rows) {
      const whole = (marks: ReviewMark[]) => changes.push({ id: changeId(branch.id, row.id), group: branch.id, marks });
      if (row.kind === "removed") whole([{ tone: "del", block: row.id }]);
      else if (row.kind === "added") whole([{ tone: "add", after: afterOf(branch, row.id), text: row.right?.text ?? "" }]);
      else if (row.kind === "moved") whole([{ tone: "del", block: row.id }, { tone: "add", after: afterOf(branch, row.id), text: row.right?.text ?? "" }]);
      else if (row.cells) whole(cellMarks(row.id, row.cells));
      else if (row.inline && !row.right?.table) {
        const each = pieceMarks(row.id, row.inline);
        // A change of type or style beside the words is the block's own change: taken whole.
        if (row.typeChange || row.props || row.format || each.length === 0) whole(each.flat().length ? each.flat() : [{ tone: "add", block: row.id }]);
        else each.forEach((marks, n) => changes.push({ id: changeId(branch.id, `${row.id}#${n}`), group: branch.id, marks }));
      } else whole([{ tone: "add", block: row.id }]);
    }
  }
  return { changes, groups };
}
