// Fixtures for `bun run ui:preview src/renderer/src/chrome/AwayRow.preview.tsx#AwayFootPreview`:
// the foot in a code place, with each of Away's four states.
const at = Date.UTC(2026, 10, 5, 14, 14);
export default [
  { name: "Off: muted like the foot's other rows", props: { code: false, work: false } },
  { name: "Code only: the track on, the label names Code", props: { code: true, work: false, at } },
  { name: "Work only: the moon and label say Work, this code place's track stays off", props: { code: false, work: true, at } },
  { name: "Both: the label names both kinds", props: { code: true, work: true, at } },
];
