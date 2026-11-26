// Fixtures for `bun run ui:preview src/renderer/src/chrome/BranchRows.tsx#BranchRows`:
// the branch picker's open body (the field and its list) in the popover's box.
// The current branch carries the check and the highlight a list opens on; a
// typed name offers the create row first; a busy switch holds the rows.
// Keys, the still pointer and the picks are DOM-tested (BranchPicker.dom.test.tsx).
import type { BranchRow } from "./BranchRows";

const branch = (name: string, remote: string | null = null, current = false): BranchRow => ({ kind: "branch", branch: { name, remote, current } });

const ROWS: BranchRow[] = [branch("master", null, true), branch("polish-the-rest-of-docket"), branch("perf2-land"), branch("release/1.0.400", "origin"), branch("a-very-long-branch-name-that-must-cut-inside-its-row", "origin")];

const frame = { search: { current: null }, onQuery: "fn", onPick: "fn", busy: false, emptyLabel: "No matching branches" };

export default [
  { name: "The branches, the current one checked", props: { ...frame, query: "", rows: ROWS } },
  { name: "A new name: the create row first", props: { ...frame, query: "fix-toast", rows: [{ kind: "create", name: "fix-toast" }, ...ROWS.slice(1, 3)] } },
  { name: "No match", props: { ...frame, query: "zzz", rows: [] } },
  { name: "Switching: the rows held", props: { ...frame, busy: true, query: "", rows: ROWS.slice(0, 3) } },
];
