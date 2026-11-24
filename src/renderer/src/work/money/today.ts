import { useMemo } from "react";
import type { MoneyOwed } from "@shared/contract-work-money";
import { formatMoney, today } from "@shared/work/money";
import { goTo } from "../today/open";
import { readState, useEachWorkspace } from "../today/read";
import type { TodayAnswer, TodayEnv, TodayRow, TodaySource } from "../today/types";
import { sinceWords } from "./model";

/**
 * Money on Today (docs/agents/work-money.md "For others"): what is owed,
 * each open row of every job's ledger, the longest open first. It is drawn
 * only while something is owed, or while a job's ledger cannot be read (what
 * it is owed is then not known). A row opens its job's Money view, and
 * names that job, the very workspace its host answered for. What waits for
 * his accept is not counted here: a receipt to confirm is the digest's to
 * tell, under Also (digest/today.ts).
 */

/** A day as the section orders by it: local noon, so a row's place never turns on a time zone. */
const at = (day: string | null): number | undefined => (day ? Date.parse(`${day}T12:00:00`) : undefined);

export function owedRows(answers: ReturnType<typeof useEachWorkspace<MoneyOwed>>["answers"], now: string = today()): TodayRow[] {
  return answers.flatMap(({ workspace, value }) => [
    // A ledger that cannot be read owes an unknown sum, which is not nothing: the job says so, and opens where it is put right.
    ...(value.problems ?? []).map(
      (): TodayRow => ({
        key: `money:${workspace.environmentId}:${workspace.workspaceId}:problem`,
        section: "money",
        sector: workspace.sector,
        job: workspace.name,
        title: "What is owed is not known",
        detail: "The ledger's columns changed",
        open: () => goTo(workspace, { view: "money" }),
      }),
    ),
    ...value.rows.map((row): TodayRow => {
      const since = at(row.since);
      const waited = sinceWords(row.since, now);
      return {
        // A row he typed with money both ways is owed both ways, one entry a side: the way keeps the two keys apart, so Today keeps both.
        key: `money:${workspace.environmentId}:${workspace.workspaceId}:${row.row}:${row.way}`,
        section: "money",
        sector: workspace.sector,
        job: workspace.name,
        // A cost to be paid back: the shop he paid does not owe him, so the row leads with what it was for.
        title: row.reimburse ? row.what || row.who || "Entry" : row.who || "Entry",
        detail: `${row.reimburse ? "To be paid back" : row.way === "toHim" ? "Owes you" : "You owe"} ${formatMoney(row.amount)}`,
        ...(since !== undefined ? { at: since } : {}),
        ...(waited ? { when: waited } : {}),
        open: () => goTo(workspace, { view: "money" }),
      };
    }),
  ]);
}

function useOwed(env: TodayEnv): TodayAnswer {
  const read = useEachWorkspace<MoneyOwed>(env, "work.money.owed", (w) => ({ workspaceId: w.workspaceId }), { push: "work.money" });
  // The same answer while the read has not moved: a new one would wake the page for nothing.
  // The day is an input: a row's "Today" turns at midnight with no push. `stale`: the rows a reopen had, read again.
  const day = env.day.from;
  return useMemo(() => ({ rows: owedRows(read.answers, today(new Date(day))), ...readState(read) }), [read, day]);
}

export const source: TodaySource = {
  id: "money",
  // No line when nothing is owed: the section is drawn only while it has a row.
  section: { id: "money", title: "Owed", order: 60, empty: "", fold: 5 },
  use: useOwed,
};
