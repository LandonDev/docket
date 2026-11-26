// bun run ui:preview src/renderer/src/chrome/DeleteThreadDialog.tsx#DeleteThreadDialog --shot --fresh
// Export DeleteThreadDialog. The open confirms show the copy for each state without deleting anything.
const base = { title: "Check the bridge", onCancel: "fn", onConfirm: "fn", onDone: "fn" };
export default ["running", "queued", "idle"].map((status) => ({ name: status, props: { ...base, status } }));
