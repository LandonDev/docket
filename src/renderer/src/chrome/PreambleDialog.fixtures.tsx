// bun run ui:preview src/renderer/src/chrome/PreambleDialog.fixtures.tsx#PreamblePreview --shot --fresh
// Export PreamblePreview. Open dialog and markdown only. Saves and focus need a live page.
import { useState } from "react";
import { PreambleDialog, type PreambleScope } from "./PreambleDialog";
import { guideMacProject, guideMacWorkspace, guideProject, guideWorkspace, seedGuideCatalog, ignorePreviewAction as noop } from "./previewDialogData";

const scopes: Record<string, PreambleScope> = {
  project: { kind: "project", workspace: guideWorkspace, project: guideProject },
  workspace: { kind: "workspace", workspace: guideWorkspace },
  inherited: { kind: "project", workspace: guideWorkspace, project: { ...guideProject, preamble: "" } },
  offline: { kind: "project", workspace: guideMacWorkspace, project: guideMacProject },
  off: { kind: "workspace", workspace: { ...guideWorkspace, preambleEnabled: false } },
};

export function PreamblePreview({ state = "project" }: { state?: string }) {
  useState(() => { if (state === "offline") seedGuideCatalog({ offline: "local" }); });
  return <PreambleDialog scope={scopes[state]} onClose={noop} />;
}

export default Object.keys(scopes).map((state) => ({ name: state, props: { state } }));
