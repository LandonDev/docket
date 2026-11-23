// Fixtures for `bun run ui:preview src/renderer/src/work/history/Compare.preview.tsx#CompareFormatting --width 864`.
export default [
  { name: "One column: each formatting change said under its block", props: { layout: "one" } },
  { name: "Side by side: said once, on the newer side", props: { layout: "sxs" } },
  { name: "The page's own changes, the last step", props: { layout: "one", page: true } },
];
