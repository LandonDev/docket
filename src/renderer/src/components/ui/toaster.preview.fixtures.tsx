// bun run ui:preview src/renderer/src/components/ui/toaster.preview.tsx#ToastPreview --shot --fresh
// Export ToastPreview. Static scenes hold the stack above a strip, a question, or a page corner.
export default ["approval", "long title", "host away", "read key", "failure", "batch", "loading", "allow", "code-only", "waiting question", "mention menu", "corner"].map((state) => ({ name: state, props: { state } }));
