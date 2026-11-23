// Fixtures for `bun run ui:preview src/renderer/src/work/sheets/ImportLine.preview.tsx#ImportLinePreview --width 864`.
export default [
  { name: "An .xls of his own: where edits go, what saving back drops, Save back", props: { moment: "xls" } },
  { name: "An .ods", props: { moment: "ods" } },
  { name: "A .tsv", props: { moment: "tsv" } },
  { name: "An .xls others can open: the copy lasts with its tab", props: { moment: "shared" } },
  { name: "The file changed under his edits: Save as Excel", props: { moment: "stale" } },
  { name: "A file with macros is not saved back: Save as Excel", props: { moment: "macros" } },
];
