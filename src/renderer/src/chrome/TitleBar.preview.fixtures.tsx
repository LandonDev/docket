// bun run ui:preview src/renderer/src/chrome/TitleBar.preview.tsx#TitleBarPreview --shot-widths 864,400,1440,800
// Captures the Linux controls and reserved Windows caption area. Native window actions need interaction.
export default [
  { name: "Linux window controls", props: {} },
  { name: "Windows caption space", props: { platform: "win32", railOpen: false } },
];
