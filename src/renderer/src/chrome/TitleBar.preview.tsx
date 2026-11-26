// bun run ui:preview src/renderer/src/chrome/TitleBar.preview.tsx#TitleBarPreview --shot --fresh --shot-widths 864,400,1440,800
// TitleBarPreview draws the strip, shelf, end group and caption space. The native Windows buttons and drag cannot appear here.
import { useLayoutEffect, useState } from "react";
import { previewCwd, previewNoop, previewNow, previewSession, previewWorkspace } from "../lib/previewHost.preview";
import { webApi } from "../lib/nativeWeb";
import type { StripChip } from "./ThreadHeaderStrip";
import { TitleBar } from "./TitleBar";
import { projectStore } from "../stores/project";
import { shellStore } from "../stores/shell";
import type { ThreadHeaderProps } from "./ThreadHeader";

function chip(id: string, title: string, live = true, status: StripChip["status"] = "idle"): StripChip {
  return {
    id, tabId: "tab-" + id, status, live, unread: status === "waiting", updatedAt: previewNow,
    thread: previewSession({ id, title, status }),
  };
}
const headerBase: Omit<ThreadHeaderProps, "railOpen"> = {
  workspaceId: previewWorkspace.id, cost: 1.24, running: 1, planReady: {}, archived: [],
  model: {
    activeId: "cache",
    live: [chip("cache", "Speed up the notes list"), chip("release", "Prepare the next release", true, "running"), chip("empty", "Pick wording for empty folders", true, "waiting"), chip("search", "Search other hosts")],
    dormant: [chip("export", "Export a folder", false), chip("archive", "Keep the archived drafts", false)],
  },
  onSelect: previewNoop, onRename: previewNoop, onArchive: previewNoop, onDelete: previewNoop,
  onSetRules: previewNoop, onRestore: previewNoop, onNew: previewNoop, onPauseAll: async () => {},
  onToggleRail: previewNoop, onSetType: previewNoop,
};

/** `home` draws the home with the rail folded: the Chats column beside the bar names the place. */
export function TitleBarPreview({ platform = "linux", railOpen = true, home = false }: { platform?: "linux" | "win32"; railOpen?: boolean; home?: boolean }) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const previous = window.api;
    window.api = { ...webApi, platform };
    if (home) {
      projectStore.setState({ projectCwd: "~" });
      shellStore.setState({ projectRailOpen: false });
    }
    setReady(true);
    return () => { window.api = previous; };
  }, [platform, home]);
  return ready ? (
    <TitleBar
      activeId={home ? "" : "cache"} cwd={home ? "~" : previewCwd}
      header={home ? { ...headerBase, railOpen: false, running: 0, model: { activeId: null, live: [], dormant: [] } } : { ...headerBase, railOpen }}
      onSelectProject={home ? previewNoop : undefined} onOpenInbox={home ? previewNoop : undefined}
      onOpenNotes={home ? previewNoop : undefined} onOpenSettings={home ? previewNoop : undefined}
      onToggleSidebar={previewNoop} onNew={previewNoop} onShowTerminal={previewNoop}
      onNewTerminal={previewNoop} onGoToFile={previewNoop}
    />
  ) : null;
}

/** The home with the rail folded, on a page of its own (it sets the shared stores). */
export function TitleBarHomePreview() {
  return <TitleBarPreview home />;
}
