import { useMemo } from "react";
import type { MsFormView } from "@shared/contract-work-msforms";
import { sayError } from "../canvas/frame";
import { openInFiles } from "../files/openFrom";
import { readState, useEachWorkspace } from "../today/read";
import type { TodayAnswer, TodayEnv, TodayRow, TodaySource, TodayWorkspace } from "../today/types";

/**
 * Microsoft forms on Today (docs/agents/work-msforms.md "Answers as data in
 * Work"): one row a form with answers he has not seen, opening the form in
 * its Files tab as the Forms view does. Drawn only while some form has one.
 * Counts and titles alone: no answer and no name is on the page.
 */

export function responseRows(answers: readonly { workspace: TodayWorkspace; value: { forms: MsFormView[] } }[]): TodayRow[] {
  return answers.flatMap(({ workspace, value }) =>
    value.forms
      .filter((f) => f.unseen > 0)
      .map(
        (f): TodayRow => ({
          key: `msforms:${workspace.environmentId}:${workspace.workspaceId}:${f.formId}`,
          section: "msforms",
          sector: workspace.sector,
          job: workspace.name,
          title: f.title,
          detail: `${f.unseen} new ${f.unseen === 1 ? "response" : "responses"}`,
          // the longest waiting first
          ...(f.lastAnswerAt !== null ? { at: f.lastAnswerAt } : {}),
          open: () =>
            void openInFiles(
              { id: workspace.workspaceId, environmentId: workspace.environmentId },
              { ref: { at: "msform", host: workspace.environmentId, workspaceId: workspace.workspaceId, formId: f.formId, tenant: f.tenant }, name: f.title },
            ).catch((err: unknown) => sayError(err, "Couldn't open the form")),
        }),
      ),
  );
}

function useResponses(env: TodayEnv): TodayAnswer {
  const read = useEachWorkspace<{ forms: MsFormView[] }>(env, "work.msforms.list", (w) => ({ workspaceId: w.workspaceId }), { push: "work.msforms" });
  return useMemo(() => ({ rows: responseRows(read.answers), ...readState(read) }), [read]);
}

export const source: TodaySource = {
  id: "msforms",
  // No line when nothing is new: the section is drawn only while it has a row.
  section: { id: "msforms", title: "Responses", order: 70, empty: "", fold: 5 },
  use: useResponses,
};
