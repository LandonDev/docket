import type { CanvasSource } from "@shared/work";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { saveAsWordTo } from "./acts";
import { MoveDialog } from "./MoveDialog";
import { openInFiles } from "./openFrom";
import { useReach } from "./store";
import type { Sidebar } from "./model";

/**
 * Save as Word to… (docs/agents/work-files.md "Save as Word to a folder"): the Move to… dialog over his places (the
 * workspace's folder, each Teams and OneDrive library of every computer it may use), opening on the places. Save
 * Here asks the workspace's host to export the document and make it a new .docx in that folder; one toast says
 * where it went, with Show. The document kind's More, File → Save as Word to… and a Files tab's ⋯ open it.
 */

const NO_PLACES: Sidebar = { home: null, marks: [], lenses: [], folder: null, lifeos: null, drives: [], projects: [], places: [], rows: [] };

export function SaveAsWordDialog({ workspace, source, name, onClose }: { workspace: WorkspaceMeta; source: CanvasSource; name: string; onClose(): void }) {
  const reach = useReach(workspace, 0);
  return (
    <MoveDialog
      verb="word"
      entries={[]}
      what={name}
      start={null}
      waiting={!reach || reach.waiting}
      sidebar={reach?.sidebar ?? NO_PLACES}
      workspace={workspace}
      onPick={(to) => saveAsWordTo({ workspaceId: workspace.id, home: workspace.environmentId }, source, to, () => void openInFiles(workspace, { page: { at: to.at, name: to.name } }))}
      onClose={onClose}
    />
  );
}

