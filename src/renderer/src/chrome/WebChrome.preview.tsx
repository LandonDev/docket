// bun run ui:preview src/renderer/src/chrome/WebChrome.preview.tsx#WebChrome --shot --fresh --shot-widths 864,400,390,1280
// Export WebChrome. A lone Alt opens the real web menu bar before capture;
// window controls, menu navigation and tab scrolling require a live page.
import { useEffect } from "react";
import { MenuBar } from "./MenuBarView";
import { TitleBar } from "./TitleBar";

const noop = () => {};
export function WebChrome() {
  useEffect(() => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Alt", code: "AltLeft", altKey: true, bubbles: true }));
    window.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Alt", code: "AltLeft", bubbles: true }));
  }, []);
  return (
    <div className="flex min-w-0 flex-col bg-sidebar">
      <MenuBar onCommand={noop} />
      <TitleBar activeId="" cwd="~" onToggleSidebar={noop} onNew={noop} header={{
        model: { live: [], dormant: [], activeId: null }, planReady: {}, archived: [], workspaceId: null, cost: null, running: 0,
        railOpen: true, onSelect: noop, onRename: noop, onArchive: noop, onDelete: noop, onSetRules: noop,
        onRestore: noop, onNew: noop, onPauseAll: async () => {}, onToggleRail: noop, onSetType: noop,
      }} />
    </div>
  );
}
