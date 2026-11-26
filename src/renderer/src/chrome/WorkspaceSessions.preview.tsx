// bun run ui:preview src/renderer/src/chrome/WorkspaceSessions.preview.tsx#WorkspaceColumn
// WorkspaceColumn mounts the real column header and rows. Rename, restore and resize need interaction.
import { useLayoutEffect } from "react";
import { previewCwd, previewNoop, previewProject } from "../lib/previewHost.preview";
import { project } from "../stores/project";
import { shellStore } from "../stores/shell";
import { RailPreviewData, sizePreviewSidebar } from "./Rail.preview";
import { Sidebar } from "./Sidebar";

export function WorkspaceColumn({ archived = false, empty = false }: { archived?: boolean; empty?: boolean }) {
  useLayoutEffect(() => {
    project.setProjectCwd(archived ? previewCwd : "~");
    project.selectProject(archived ? previewProject.id : null);
    shellStore.setState({ projectRailOpen: false });
  }, [archived]);
  return (
    <RailPreviewData home={empty ? "empty" : "populated"} archived={archived}>
      {() => (
        <div ref={sizePreviewSidebar} className="flex h-[480px]">
          <Sidebar onOpenFile={previewNoop} onSelectSession={previewNoop} onNew={previewNoop} onNewChat={previewNoop} onSelectProjectCard={previewNoop} />
        </div>
      )}
    </RailPreviewData>
  );
}


export function HomeChats({ empty = false }: { empty?: boolean }) {
  return <WorkspaceColumn empty={empty} />;
}

export function ArchivedOpen() {
  return <WorkspaceColumn archived />;
}
