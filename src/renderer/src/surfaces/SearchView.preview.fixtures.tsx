// bun run ui:preview src/renderer/src/surfaces/SearchView.preview.tsx#SearchPreview
// Static capture waits for the search debounce. Opening hits and cancellation need interaction.
const prepare = () => new Promise<void>((resolve) => setTimeout(resolve, 300));
export default [
  { name: "Search is empty", props: {} },
  { name: "Waiting on a host", props: { query: "field guide", pending: true }, prepare },
  { name: "No matching results", props: { query: "packing list" }, prepare },
  { name: "Threads, folded messages, files, content and notes from two hosts", props: { query: "cache" }, prepare },
];
