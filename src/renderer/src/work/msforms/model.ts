import type { MsFormResponses } from "@shared/contract-work-msforms";
import { isOther, type MsAnyQuestion, type MsQuestion } from "@shared/work/msforms";

/**
 * The Responses half's sums for a Microsoft form (docs/agents/work-msforms.md
 * "Answers as data in Work"), over the rows the workbook gave: the one choice
 * question drawn as bars, and the column that holds the time each answer came.
 */

const lower = (s: string): string => s.trim().toLowerCase();

/** The column the Responses table draws as the time: Completion time, else Start time. */
export function timeColumnOf(got: Pick<MsFormResponses, "columns">): number | null {
  const i = got.columns.findIndex((c) => lower(c.label) === "completion time");
  if (i >= 0) return i;
  const j = got.columns.findIndex((c) => lower(c.label) === "start time");
  return j >= 0 ? j : null;
}

/** The first single choice question whose column the workbook has: the one drawn as bars. */
export function chartOf(questions: readonly MsAnyQuestion[], got: Pick<MsFormResponses, "columns">): (MsQuestion & { label: string; column: number }) | null {
  for (const q of questions) {
    if (isOther(q) || q.type !== "choice" || q.multiple) continue;
    const column = got.columns.findIndex((c) => lower(c.label) === lower(q.title));
    if (column >= 0) return { ...q, label: q.title, column };
  }
  return null;
}

/** Each option's count in that column, in the question's order, then any answer the options do not hold. */
export function answerBarsOf(got: Pick<MsFormResponses, "rows">, chart: { options?: string[]; column: number }): { label: string; count: number }[] {
  const counts = new Map<string, number>((chart.options ?? []).map((o) => [o, 0]));
  for (const row of got.rows) {
    const v = (row[chart.column] ?? "").trim();
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count }));
}
