// bun run ui:preview src/renderer/src/chrome/ShellFrame.preview.tsx#ShellFrame
// ShellFrame draws Sidebar, TitleBar and a thread stub. Resizing and window controls need interaction.
import { useLayoutEffect } from "react";
import { previewCwd, previewNoop, previewProject } from "../lib/previewHost.preview";
import { project } from "../stores/project";
import { shellStore } from "../stores/shell";
import { RailPreviewData, sizePreviewSidebar } from "./Rail.preview";
import { Sidebar } from "./Sidebar";
import { TitleBarPreview } from "./TitleBar.preview";

export function ShellFrame({ railOpen = true }: { railOpen?: boolean }) {
  useLayoutEffect(() => {
    project.setProjectCwd(previewCwd);
    project.selectProject(previewProject.id);
    shellStore.setState({ projectRailOpen: railOpen });
  }, [railOpen]);
  return (
    <RailPreviewData>
      {() => (
        <div ref={sizePreviewSidebar} className="app-shell flex h-[520px] w-full max-w-[800px] overflow-hidden border border-border bg-background">
          <Sidebar
            onOpenFile={previewNoop} onSelectSession={previewNoop} onSelectProject={previewNoop} onOpenProject={previewNoop}
            onNew={previewNoop} onNewChat={previewNoop} onSelectProjectCard={previewNoop}
            onSearch={previewNoop} onOpenInbox={previewNoop} onOpenNotes={previewNoop}
            onOpenChats={previewNoop} onOpenAccountsPage={previewNoop}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <TitleBarPreview railOpen={railOpen} />
            <div className="min-w-0 px-4 pt-4 text-sm text-muted-foreground">The last notes page stays visible while the next one loads.</div>
          </div>
        </div>
      )}
    </RailPreviewData>
  );
}
