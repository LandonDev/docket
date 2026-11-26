// bun run ui:preview src/renderer/src/chrome/MenuBarView.tsx#MenuBar
// Static capture opens the real menu with Alt. Focus restoration and commands are covered by DOM tests.
import { menuChunk } from "../surfaces/chunks";
import { waitForPreview } from "../lib/previewHost.preview";

await menuChunk.load();
async function show(root: HTMLElement, menu?: string) {
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
  window.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Alt", bubbles: true }));
  const bar = await waitForPreview(() => root.querySelector('[role="menubar"]'));
  if (!menu) return;
  const trigger = [...bar.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === menu);
  if (!trigger) throw new Error(`Missing menu: ${menu}`);
  trigger.click();
}

export default [
  { name: "Menu bar after tapping Alt", props: { onCommand: "fn" }, prepare: show },
  { name: "Go menu open", props: { onCommand: "fn" }, prepare: (root: HTMLElement) => show(root, "Go") },
];
