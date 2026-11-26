// bun run ui:preview src/renderer/src/components/ui/toaster.preview.tsx#ToastPreview --shot --fresh
// Export ToastPreview. Static scenes hold the stack above a strip, a question, or a page corner.
export default ["approval", "host away", "failure", "batch", "loading", "allow", "code-only", "waiting question", "corner"].map((state) => ({ name: state, props: { state } }));
