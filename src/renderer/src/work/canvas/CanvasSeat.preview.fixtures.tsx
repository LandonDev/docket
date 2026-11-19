// Fixtures for `bun run ui:preview src/renderer/src/work/canvas/CanvasSeat.preview.tsx#CanvasPreview --width 864`.
export default [
  { name: "Three items, changes to review, a selection asked about", props: { moment: "three" } },
  { name: "One item", props: { moment: "one" } },
  { name: "The thread folded", props: { moment: "folded" } },
  { name: "The agent wrote directly", props: { moment: "written" } },
  { name: "Loading", props: { moment: "loading" } },
  { name: "LifeOS unreachable", props: { moment: "unreachable" } },
  { name: "Couldn't open", props: { moment: "failed" } },
];
