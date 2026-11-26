// bun run ui:preview src/renderer/src/chrome/menuRows.preview.tsx#ThreadMenus --shot --fresh
// Export ThreadMenus. Open menus hold the working, paused, queued and master rows without actions.
export const fixturesByExport = {
  ThreadMenus: [
    { name: "Working", props: { status: "running" } },
    { name: "Paused", props: { status: "paused" } },
    { name: "Queued", props: { status: "queued" } },
    { name: "Master", props: { status: "running", master: true } },
  ],
};
