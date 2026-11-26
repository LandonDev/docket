// bun run ui:preview src/renderer/src/chrome/ShellFrame.preview.tsx#ShellFrame
// The shell is 800×520 when the capture has room. Resize and window actions need interaction.
export default [
  { name: "Rail open", props: { railOpen: true } },
  { name: "Rail collapsed", props: { railOpen: false } },
];
