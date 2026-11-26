// bun run ui:preview src/renderer/src/chrome/SwitchBranchDialog.fixtures.tsx#SwitchBranchPreview --shot --fresh
// Export SwitchBranchPreview. Pending states stay still; there is no working checkout in this preview.
import { useEffect } from "react";
import { SwitchBranchDialog } from "./SwitchBranchDialog";
import { answerAs } from "../work/kit.preview";
import { clickPreviewButton, enterPreviewText, ignorePreviewAction as noop, previewPending } from "./previewDialogData";

answerAs(() => previewPending);

export function SwitchBranchPreview({ state = "rest" }: { state?: string }) {
  useEffect(() => {
    if (state === "typed" || state === "commit") enterPreviewText('[role=dialog] textarea', "Update the route notes");
    if (state === "generating") clickPreviewButton("Generate commit message");
  }, [state]);
  return <SwitchBranchDialog cwd="/projects/field-guide" branch="spring-edition" busy={state === "stash" || state === "commit" ? state : null} error={state === "failed" ? "The checkout still has changes." : null} onStash={() => new Promise<boolean>(() => {})} onCommit={() => new Promise<boolean>(() => {})} onSwitched={noop} onCancel={noop} />;
}

export default ["rest", "typed", "stash", "commit", "generating", "failed"].map((state) => ({ name: state, props: { state } }));
