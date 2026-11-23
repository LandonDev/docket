// A preview frame for `bun run ui:preview src/renderer/src/work/history/Compare.preview.tsx#CompareFormatting --width 864 --shot`:
// a compare of two versions of a document whose formatting changed (docs/agents/work-history.md "Compare"): each
// change says what it did beside the words under its block, and the page's own changes are one last step.
import { diffBlocks } from "work-kit/formats/diff";
import { paraText } from "work-kit/editor/para";
import { CompareDoc, type Layout } from "./Compare";

const text = (value: string, styles: Record<string, unknown> = {}) => ({ type: "text", text: value, styles });
const block = (id: string, type: string, props: Record<string, unknown>, ...content: unknown[]) => ({ id, type, props, content, children: [] });

const BEFORE = [
  block("t", "heading", { level: 1 }, text("Spring LAN run of show")),
  block("a", "paragraph", {}, text("Setup starts at 8:00 AM. Every station needs power and a wired line before the first team checks in.", { fontSize: "11" })),
  block("h", "heading", { level: 2 }, text("Match day")),
  block("b", "paragraph", {}, text("Matches start on the hour, and the bracket moves on without a team that is not seated.")),
  block("c", "paragraph", {}, text("Spare headsets are in the green room.")),
];
const AFTER = [
  block("t", "paragraph", { para: paraText({ style: "Title" }) }, text("Spring LAN run of show")),
  block("a", "paragraph", { para: paraText({ lineSpacing: 2 }) }, text("Setup starts at 7:30 AM. Every station needs power and a wired line before the first team checks in.", { fontSize: "14", fontFamily: "Cambria" })),
  block("h", "heading", { level: 2 }, text("Match day")),
  block("b", "paragraph", { textAlignment: "center" }, text("Matches start on the hour, and the bracket moves on without a team that is not seated.", { bold: true })),
  block("c", "paragraph", {}, text("Spare headsets are in the green room.")),
];
const PAGE = ["Margins become Narrow (0.5 in)", "Paper becomes A4", "Footer set to “Page 1 of 4”"];

export function CompareFormatting({ layout = "one", page = false }: { layout?: Layout; page?: boolean }) {
  const diff = diffBlocks(BEFORE, AFTER);
  // The page's change is the step after the last row.
  return <CompareDoc diff={page ? { ...diff, page: PAGE } : diff} layout={layout} current={page ? diff.rows.length : 1} title="Run of show" />;
}
