// Fixtures for `bun run ui:preview src/renderer/src/work/history/HistoryCanvas.preview.tsx#HistoryPreview --width 864`.
export default [
  { name: "The versions by who and why", props: { moment: "list" } },
  { name: "Suggestions waiting for him over the versions", props: { moment: "waiting" } },
  { name: "No versions yet", props: { moment: "empty" } },
  { name: "The versions did not load", props: { moment: "failed" } },
  { name: "A compare that did not load", props: { moment: "compare-failed" } },
];
