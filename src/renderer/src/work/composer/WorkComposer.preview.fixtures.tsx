// Fixtures for `bun run ui:preview src/renderer/src/work/composer/WorkComposer.preview.tsx#WorkComposerPreview`:
// a Work draft from a task, the same with words typed, and a Work thread's docked composer.
export default [
  { name: "Work draft, started from a task", props: { id: "preview-work-draft" } },
  { name: "Work draft, words typed", props: { id: "preview-work-typed", draft: "Ask Sam Ortiz whether we can borrow two 48-port switches again" } },
  { name: "Work thread", props: { id: "preview-work-thread", thread: true } },
];
