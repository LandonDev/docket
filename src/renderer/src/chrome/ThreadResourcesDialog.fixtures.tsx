// bun run ui:preview src/renderer/src/chrome/ThreadResourcesDialog.fixtures.tsx#ResourcesPreview --shot --fresh
// Exports ResourcesPreview and ArchiveResources. The resource ledger is in memory;
// its pending removal never reaches a host.
import { useEffect } from "react";
import type { ThreadResource } from "@server/shared/contract-resources";
import { FIXTURE_ROWS } from "../surfaces/threads/master/boardFixture";
import { seedPreviewThreads } from "../surfaces/threads/previewThreads";
import { ArchiveThreadDialog, ThreadResourcesDialog } from "./ThreadResourcesDialog";
import { clickPreviewButton, ignorePreviewAction as noop, previewPending } from "./previewDialogData";

const thread = FIXTURE_ROWS[0].meta;
const resources: ThreadResource[] = [
  { id: "wt", kind: "worktree", label: "Spring edition", identifier: "/projects/spring-edition", environmentId: "local", sessionId: thread.id, createdAt: 1, branch: null, removeRequestedAt: null, removedAt: null, note: null },
  { id: "sim", kind: "simulator", label: "Phone simulator", identifier: "preview-simulator", environmentId: "local", sessionId: thread.id, createdAt: 1, branch: null, removeRequestedAt: null, removedAt: null, note: null },
];
const ids = ["listed", "removing", "loading"].map((state) => ({ ...thread, id: state }));
seedPreviewThreads(ids, {}, (method, params) => {
  if (method === "resources.list") return params.sessionId === "loading" ? previewPending : { resources };
  if (method === "resources.remove") return previewPending;
  return undefined;
});

export function ResourcesPreview({ state = "listed" }: { state?: string }) {
  useEffect(() => {
    if (state !== "removing") return;
    const timer = setTimeout(() => clickPreviewButton("Remove"), 15);
    return () => clearTimeout(timer);
  }, [state]);
  return <ThreadResourcesDialog sessionId={state} title="Check the bridge" onClose={noop} />;
}
export function ArchiveResources() { return <ArchiveThreadDialog sessionId={thread.id} title="Check the bridge" resources={resources} onCancel={noop} onArchived={noop} />; }

export const fixturesByExport = {
  ResourcesPreview: ["loading", "listed", "removing", "offline"].map((state) => ({ name: state, props: { state } })),
};
