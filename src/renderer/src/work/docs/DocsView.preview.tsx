import type { FindAnswer } from "@shared/contract-work-docs";
import type { FindEntry, FindSpec } from "@shared/work/docFind";
import { Doc } from "../icons";
import type { WorkViewProps } from "../views/registry";
import { Head, View } from "./DocsView";
import { setFinder, setFound } from "./finder";

/**
 * The Docs view over fixed entries, for `bun run ui:preview
 * src/renderer/src/work/docs/DocsView.preview.tsx#DocsPreview --props '{"state":"list"}'`:
 * `list` (grouped by project), `search` (a text match with its words),
 * `table` (grouped by kind), `picked` (two rows picked). Rendered by nothing in the app.
 */

const NOW = new Date(2026, 10, 19, 15, 0).getTime();
const DAY = 86_400_000;
const e = (o: Partial<FindEntry> & Pick<FindEntry, "key" | "title">): FindEntry => ({
  kind: "document",
  where: "lifeos",
  source: { at: "lifeos", table: "docs", id: o.key },
  editedAt: NOW,
  createdAt: NOW - 30 * DAY,
  shared: false,
  guest: false,
  comments: 0,
  waiting: 0,
  held: 0,
  ...o,
});
const ANSWER: FindAnswer = {
  entries: [
    e({ key: "d1", title: "Spring LAN run of show", projectId: "p1", editedAt: NOW - 2 * 3_600_000, lastBy: "owner", comments: 2 }),
    e({ key: "s1", title: "Spring LAN budget", kind: "sheet", source: { at: "lifeos", table: "sheets", id: "s1" }, projectId: "p1", editedAt: NOW - 3 * DAY, lastBy: "agent", waiting: 1 }),
    e({ key: "d2", title: "Vendor shortlist", projectId: "p1", editedAt: NOW - 9 * DAY, lastBy: "guest", guest: true }),
    e({ key: "d3", title: "Scrim policy", projectId: "p2", editedAt: NOW - DAY, lastBy: "owner" }),
    e({ key: "f1", title: "Ballroom floor plan.pdf", kind: "pdf", where: "folder", source: { at: "file", host: "box", path: "/w/plan.pdf" }, editedAt: NOW - 5 * DAY, held: 1 }),
    e({ key: "g1", title: "Player roster", kind: "sheet", where: "google", source: { at: "google", account: "a", fileId: "g1", mime: "application/vnd.google-apps.spreadsheet" }, editedAt: NOW - 12 * DAY, shared: true }),
    e({ key: "m1", title: "Kickoff call", kind: "meeting", where: "folder", source: { at: "file", host: "box", path: "/w/kickoff.m4a" }, editedAt: NOW - 20 * DAY }),
  ],
  projects: [
    { id: "p1", name: "Spring LAN" },
    { id: "p2", name: "Varsity season" },
  ],
  hits: [],
  complete: true,
};

const STATES: Record<string, { spec: Partial<FindSpec>; hits?: [string, string][]; picked?: string[] }> = {
  list: { spec: {} },
  search: { spec: { query: "budget" }, hits: [["d1", "…the AV rental comes out of the budget line for Saturday, so ask Dana before…"]] },
  table: { spec: { layout: "table", group: "kind" } },
  picked: { spec: {}, picked: ["d1", "s1"] },
};

export function DocsPreview({ state = "list" }: { state?: string }) {
  const s = STATES[state] ?? STATES.list!;
  const ws = `preview-${state}`;
  setFinder(ws, (f) => ({ spec: { ...f.spec, ...s.spec }, selected: new Set(s.picked ?? []) }));
  setFound(ws, { answer: ANSWER, hits: new Map(s.hits ?? []), hitsFor: s.spec.query ?? "" });
  const props = { env: "box", workspace: { id: ws, environmentId: "box" }, sector: "purdue", lifeos: {}, startThread: () => {} } as unknown as WorkViewProps;
  return (
    <div className="flex w-[864px] flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-[13px]">
        <Doc className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground">Docs</span>
        <span className="flex-1" />
        <Head {...props} />
      </div>
      <View {...props} />
    </div>
  );
}
