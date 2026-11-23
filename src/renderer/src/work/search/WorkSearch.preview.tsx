import { createRef } from "react";
import type { SearchAnswer, SearchGroup, SearchHit } from "@shared/work/search";
import { PickerFrame } from "../../chrome/PickerDialog";
import type { Job } from "./hosts";
import { activeOf, begin, busy, emptyModel, isOption, landInstant, landSource, rowsOf, step, type SearchHost, type SearchModel } from "./model";
import { FieldEnd, Results } from "./Picker";

/**
 * Work search in each of its states, with no dialog round it, for `bun run
 * ui:preview src/renderer/src/work/search/WorkSearch.preview.tsx#WorkSearchPreview --shot`
 * (docs/DESIGN.md "Work search"): Recent, results across jobs, one job, one
 * kind, a source still out, LifeOS signed out, nothing found. Made-up rows.
 * Rendered by nothing in the app.
 */

export type PreviewState = "recent" | "across" | "moved" | "one-job" | "one-kind" | "waiting" | "lifeos" | "nothing" | "nothing-in-job";

const box: SearchHost = { id: "box", name: "MacBook", home: true };
const JOBS: Job[] = [
  { key: "purdue", name: "Purdue", sector: "purdue", ids: ["w-purdue"] },
  { key: "unify", name: "Unify", sector: "unify", ids: ["w-unify"] },
  { key: "cosmic", name: "Cosmic", sector: "cosmic", ids: ["w-cosmic"] },
];
const NOW = Date.UTC(2026, 10, 23, 15, 0);
const DAY = 86_400_000;
const hit = (key: string, kind: string, title: string, over: Partial<SearchHit> = {}): SearchHit => ({ key, kind, title, workspaceId: "w-purdue", open: { to: "view", view: kind }, ...over });
const group = (kind: string, label: string, hits: SearchHit[], more = false, source = `search.${kind}`): SearchGroup => ({ source, kind, label, hits: hits.map((h) => ({ ...h, kind })), more });
const answer = (groups: SearchGroup[], pending: string[] = [], quiet: SearchAnswer["quiet"] = []): SearchAnswer => ({ groups, pending: pending.map((source) => ({ source, kind: source.split(".")[1] })), quiet });

const PEOPLE = group("person", "People", [hit("p1", "person", "Dana Kim", { detail: "dana.kim@example.edu" })]);
const MAIL = group(
  "mail",
  "Mail",
  [
    hit("m1", "mail", "Budget for the spring LAN", { detail: "Dana Kim", at: NOW - 2 * DAY }),
    hit("m2", "mail", "Re: budget sign-off", { detail: "Finance", at: NOW - 5 * DAY }),
    hit("m3", "mail", "Q4 budget draft", { detail: "Sam Ortiz", workspaceId: "w-unify", at: NOW - 21 * DAY }),
    hit("m4", "mail", "Server budget", { detail: "Ops", workspaceId: "w-cosmic", at: NOW - 33 * DAY }),
  ],
  true,
);
const TASKS = group("task", "Tasks", [hit("t1", "task", "Send the budget to Dana", { detail: "PUR-41", at: NOW + 4 * DAY })]);
const FILES = group("file", "Files", [hit("f1", "file", "Budget FY27.xlsx", { detail: "Esports › Finance", cloud: true, at: NOW - 7 * DAY, open: { to: "file", ref: null, name: "Budget FY27.xlsx" } })]);
const THREADS = group("thread", "Threads", [hit("th1", "thread", "Budget review for the LAN", { snippet: "…the budget lines for the venue and the prizes…", at: NOW - 3 * DAY })]);

function modelOf(state: PreviewState): { model: SearchModel; job: Job | null } {
  const typed = (text: string, kind: string | null = null): SearchModel => begin(emptyModel(), { text, kind, hosts: [box] });
  switch (state) {
    case "recent": {
      const m = typed("");
      const recent = group("recent", "Recent", [
        hit("m1", "mail", "Budget for the spring LAN"),
        hit("th1", "thread", "Budget review for the LAN"),
        hit("f1", "file", "Budget FY27.xlsx", { open: { to: "file", ref: null, name: "Budget FY27.xlsx" } }),
        hit("p1", "person", "Dana Kim", { workspaceId: "w-unify" }),
      ]).hits.map((h, i) => ({ ...h, kind: ["mail", "thread", "file", "person"][i] }));
      return { model: landInstant(m, m.gen, "box", answer([{ source: "search.recent", kind: "recent", label: "Recent", hits: recent, more: false }])).model, job: null };
    }
    case "across":
    case "moved": {
      let m = typed("budget");
      m = landInstant(m, m.gen, "box", answer([PEOPLE, MAIL, TASKS, FILES, THREADS])).model;
      if (state === "moved") for (let i = 0; i < 6; i++) m = step(m, rowsOf(m), 1);
      return { model: m, job: null };
    }
    case "one-job": {
      const m = typed("budget");
      const mine = (g: SearchGroup): SearchGroup => ({ ...g, hits: g.hits.filter((h) => h.workspaceId === "w-purdue"), more: false });
      return { model: landInstant(m, m.gen, "box", answer([PEOPLE, mine(MAIL), TASKS, FILES, THREADS])).model, job: JOBS[0] };
    }
    case "one-kind": {
      const m = typed("budget", "mail");
      const more = [
        hit("m5", "mail", "Budget: travel for regionals", { detail: "Dana Kim", at: NOW - 40 * DAY }),
        hit("m6", "mail", "Fwd: budget template", { detail: "Sam Ortiz", workspaceId: "w-unify", at: NOW - 62 * DAY }),
        hit("m7", "mail", "Jersey order", { detail: "Vendor", snippet: "…fits the budget if we order forty…", at: NOW - 75 * DAY }),
      ];
      return { model: landInstant(m, m.gen, "box", answer([{ ...MAIL, hits: [...MAIL.hits, ...more], more: false }])).model, job: null };
    }
    case "waiting": {
      const m = typed("budget");
      return { model: landInstant(m, m.gen, "box", answer([FILES, THREADS], ["search.person", "search.mail", "search.task"])).model, job: null };
    }
    case "lifeos": {
      const m = typed("budget");
      return { model: landInstant(m, m.gen, "box", answer([FILES, THREADS], [], [{ cause: "lifeos", line: "This host is not signed in to LifeOS" }])).model, job: null };
    }
    case "nothing":
    case "nothing-in-job": {
      let m = typed("zebra crossing");
      m = landInstant(m, m.gen, "box", answer([], ["search.mail"])).model;
      return { model: landSource(m, m.gen, "box", "search.mail", answer([])), job: state === "nothing" ? null : JOBS[0] };
    }
  }
}

const noop = (): void => {};

export function WorkSearchPreview({ state = "across" }: { state?: PreviewState }) {
  const { model, job } = modelOf(state);
  const rows = rowsOf(model, { scoped: job !== null });
  return (
    // The dialog's own box (components/ui/dialog.tsx), still: 560px, a 16px radius, a 4px inset.
    <div data-work-search className="w-full max-w-[560px] rounded-2xl bg-popover p-1 text-[13px] text-popover-foreground shadow-overlay ring-1 ring-border">
      <PickerFrame
        label="Search Work"
        search={createRef()}
        query={model.text}
        onQuery={noop}
        onSearchKey={noop}
        leading={model.kind ? "Mail" : undefined}
        trailing={<FieldEnd busy={busy(model)} jobs={JOBS} job={job} onPick={noop} />}
      >
        <Results
          rows={rows}
          options={rows.filter(isOption)}
          active={activeOf(model, rows)}
          moved={model.moved}
          text={model.text}
          mixed={job === null}
          jobOf={(h) => JOBS.find((j) => j.ids.includes(h.workspaceId ?? "")) ?? null}
          now={NOW}
          onPoint={noop}
          onTake={noop}
        />
      </PickerFrame>
    </div>
  );
}
