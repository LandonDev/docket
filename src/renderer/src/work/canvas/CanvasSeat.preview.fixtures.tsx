// Fixtures for `bun run ui:preview src/renderer/src/work/canvas/CanvasSeat.preview.tsx#CanvasPreview --width 864`.
export default [
  { name: "Three items, changes to review, a selection asked about", props: { moment: "three" } },
  { name: "One item", props: { moment: "one" } },
  { name: "The thread folded", props: { moment: "folded" } },
  { name: "The agent wrote directly", props: { moment: "written" } },
  { name: "Loading", props: { moment: "loading" } },
  { name: "LifeOS unreachable", props: { moment: "unreachable" } },
  { name: "Couldn't open", props: { moment: "failed" } },
  { name: "A dropped file opening, no item yet", props: { moment: "opening" } },
  { name: "A big dropped file going up beside an item", props: { moment: "uploading" } },
  { name: "A mail's attachment on its way", props: { moment: "attachment" } },
  { name: "A mail's attachment the host could not get", props: { moment: "attachment-failed" } },
  { name: "A mail's attachment, opened", props: { moment: "attachment-open" } },
];
