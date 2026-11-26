// bun run ui:preview src/renderer/src/chrome/ProjectDialogs.preview.tsx#ProjectSettings --shot --fresh
// Export ProjectSettings. Each sheet shows a fixed host answer or failure without reading a host.
export const fixturesByExport = {
  ProjectSettings: ["linked", "offline", "read-only", "read failed"].map((state) => ({ name: state, props: { state } })),
};
