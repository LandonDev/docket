import type { MoneyOwed } from "@shared/contract-work-money";
import { formatMoney, today } from "@shared/work/money";
import { goTo } from "../today/open";
import { useEachWorkspace } from "../today/read";
import type { TodayAnswer, TodayEnv, TodayRow, TodaySource } from "../today/types";
import { sinceWords } from "./model";

/**
 * Money on Today (docs/agents/work-money.md "For others"): what is owed,
 * each open row of every job's ledger, the longest open first. It is drawn
 * only while something is owed, or while a job's ledger cannot be read (what
 * it is owed is then not known). A row opens its job's Money view. What
 * waits for his accept is not counted here: Today shows rows, and a receipt
 * to confirm is the digest's to tell.
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
        title: workspace.name,
        detail: "The ledger's columns changed, so what is owed is not known",
        open: () => goTo(workspace, { view: "money" }),
      }),
    ),
    ...value.rows.map((row): TodayRow => {
      const since = at(row.since);
      const waited = sinceWords(row.since, now);
      return {
        key: `money:${workspace.environmentId}:${workspace.workspaceId}:${row.row}`,
        section: "money",
        sector: workspace.sector,
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
  return { rows: owedRows(read.answers), loading: read.loading, failed: read.failed };
}

export const source: TodaySource = {
  id: "money",
  // No line when nothing is owed: the section is drawn only while it has a row.
  section: { id: "money", title: "Owed", order: 60, empty: "", fold: 5 },
  use: useOwed,
};
