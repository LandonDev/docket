// bun run ui:preview src/renderer/src/surfaces/threads/dialogs.preview.tsx#StartBuild --shot --fresh
// Exports StartBuild, OrchestrateBuild, RevisePlan, NewPass, BatchRules, ShellStep,
// AdoptThread, AddThread, ArchiveBatch, DeleteThread and RenameThread.
// Static shots hold the portals open. Focus, Escape and submitting need a live page.
import { useEffect } from "react";
import { selectChunk } from "../chunks";
import { clickPreviewButton } from "../../chrome/previewDialogData";
import { DeleteThreadDialog } from "../../chrome/DeleteThreadDialog";
import { SessionActionsContext, type SessionActions } from "../threadChat";
import { sessionFromMeta } from "../../lib/tcserver/store";
import { RevisePlanDialog } from "./RevisePlanDialog";
import { StartBuildDialog } from "./StartBuildDialog";
import { AddThreadDialog } from "./master/AddThreadDialog";
import { AdoptThreadDialog } from "./master/AdoptThreadDialog";
import { ArchiveBatchDialog } from "./master/ArchiveBatchDialog";
import { FIXTURE_BATCH, FIXTURE_ROWS } from "./master/boardFixture";
import { NewPassDialog } from "./master/NewPassDialog";
import { RenameThreadDialog } from "./master/RenameThreadDialog";
import { RulesDialog } from "./master/RulesDialog";
import { previewCwd, seedPreviewThreads } from "./previewThreads";

await selectChunk.load();
const noop = () => {};
const done = async () => {};
const master = { ...FIXTURE_ROWS[0].meta, id: "guide-batch", title: "Field guide", threadType: "orchestration" as const, cwd: previewCwd };
const plan = { ...sessionFromMeta(master), id: "guide-plan", threadType: "planning" as const };
const children = FIXTURE_ROWS.slice(0, 3).map((row) => row.meta);
seedPreviewThreads([master, ...children], { [master.id]: { blocks: [{ id: "ask", role: "user", text: "Update the field guide." }] } });

export function StartBuild() {
  return <StartBuildDialog session={plan} tasks={["Map the west trail", "Check the bridge", "Update the guide"]} open onOpenChange={noop} />;
}
export function OrchestrateBuild() {
  useEffect(() => {
    const timer = setTimeout(() => clickPreviewButton("Orchestrate"), 20);
    return () => clearTimeout(timer);
  }, []);
  return <StartBuild />;
}
export function RevisePlan() { return <RevisePlanDialog open onOpenChange={noop} onSend={done} />; }
export function NewPass() {
  return <SessionActionsContext.Provider value={{} as SessionActions}><NewPassDialog sessionId={master.id} landed onClose={noop} /></SessionActionsContext.Provider>;
}
export function BatchRules() { return <RulesDialog rules={FIXTURE_BATCH.rules} onClose={noop} onSave={done} />; }
export function ShellStep() {
  useEffect(() => {
    const open = setTimeout(() => clickPreviewButton("Add a step"), 20);
    const pick = setTimeout(() => {
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.trim() === "Shell command");
      option?.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
      option?.click();
    }, 50);
    return () => { clearTimeout(open); clearTimeout(pick); };
  }, []);
  return <BatchRules />;
}
export function AdoptThread() { return <AdoptThreadDialog candidates={children} onClose={noop} onAdopt={done} />; }
export function AddThread() { return <AddThreadDialog master={master} siblings={children} onClose={noop} />; }
export function ArchiveBatch() { return <ArchiveBatchDialog which="all" count={4} resources={3} onCancel={noop} onConfirm={done} />; }
export function DeleteThread() { return <DeleteThreadDialog title="Check the bridge" status="running" onCancel={noop} onDone={noop} onConfirm={done} />; }
export function RenameThread() { return <RenameThreadDialog sessionId={master.id} title={master.title} onClose={noop} />; }
