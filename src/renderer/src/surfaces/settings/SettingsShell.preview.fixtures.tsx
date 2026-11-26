// Fixtures for `bun run ui:preview src/renderer/src/surfaces/settings/SettingsShell.preview.tsx#SettingsShellPreview`:
// the Settings list in each kind of window, then search with results, by an old name, and with no match.
export default [
  { name: "The list: a Mac linked to the box and a PC", props: { window: "mac", show: "list" } },
  { name: "The list: the box's web page", props: { window: "web", show: "list" } },
  { name: "The list: a Mac with no other computer, Work off", props: { window: "alone", show: "list" } },
  { name: "Search: a result list", props: { window: "mac", query: "away" } },
  { name: "Search: an old name", props: { window: "mac", query: "hosts" } },
  { name: "Search: a per-computer setting, once for each", props: { window: "mac", query: "largest attachment" } },
  { name: "Search: no match", props: { window: "mac", query: "zzzz" } },
  { name: "Search results alone (a narrow window)", props: { window: "mac", query: "harness", show: "page" } },
];
