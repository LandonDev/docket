// Fixtures for `bun run ui:preview src/renderer/src/work/meetings/MeetingCanvas.preview.tsx#MeetingPreview --width 864`.
export default [
  { name: "Read", props: { moment: "read" } },
  { name: "Notes", props: { moment: "notes" } },
  { name: "A stretch", props: { moment: "stretch" } },
  { name: "Tasks it found", props: { moment: "tasks" } },
  { name: "Transcribing", props: { moment: "busy" } },
  { name: "Nothing yet", props: { moment: "empty" } },
  { name: "3 hours, Find", props: { moment: "long" } },
  { name: "Could not transcribe", props: { moment: "error" } },
];
