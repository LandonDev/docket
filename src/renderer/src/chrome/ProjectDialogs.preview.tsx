// bun run ui:preview src/renderer/src/chrome/ProjectDialogs.preview.tsx#NewGitProject --shot --fresh
// Exports NewGitProject, NewPlainProject, ExistingBranch, NewWorkspace, ArchiveProject,
// DeleteProject, DeleteProjectWithCopies, ProjectSettings, RemoveWorkspace, RenameWorkspace and MacRules. Captures the dialogs in place.
// No project is created, edited, archived or deleted by a static preview.
import { useEffect, useState, type ReactNode } from "react";
import { DEFAULT_REVIEW_SETTINGS } from "@server/shared/review";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { answerAs } from "../work/kit.preview";
import { MacBridgeRulesDialog } from "./MacBridgeRulesDialog";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { RenameWorkspaceDialog } from "./RenameWorkspaceDialog";
import { NewProjectDialog, NewWorkspaceDialog, ProjectSettingsDialog, ProjectTeardownDialog } from "./ProjectDialogs";
import { enterPreviewText, guideMacProject, guideMacWorkspace, guideProject, guideWorkspace, linkedGuideProject, seedGuideCatalog, ignorePreviewAction as noop } from "./previewDialogData";

const git = { current: "main", locals: ["main", "spring-edition"], remotes: ["origin/main"] };
let failing = false;
const link = answerAs((method) => {
  if (method === "workspace.list") return [guideWorkspace];
  if (method === "project.list") return [linkedGuideProject];
  if (method === "project.branches") return git;
  if (method === "macBridge.rules.list") return [];
  if (method === "review.get") {
    if (failing) throw new Error("The box did not answer.");
    return { global: DEFAULT_REVIEW_SETTINGS, override: null, settings: DEFAULT_REVIEW_SETTINGS, source: "global" };
  }
  return null;
});
seedGuideCatalog();
workspaceStore.attach(link);

function TallWindow({ children }: { children: ReactNode }) {
  return <div data-preview-stage className="h-[760px]">{children}</div>;
}
export function NewGitProject() { return <TallWindow><NewProjectDialog workspace={guideWorkspace} onClose={noop} onCreated={noop} /></TallWindow>; }
export function NewPlainProject() { return <NewProjectDialog workspace={{ ...guideWorkspace, git: false }} onClose={noop} onCreated={noop} />; }
export function ExistingBranch() {
  useEffect(() => {
    const timer = setTimeout(() => {
      enterPreviewText('input[placeholder="What are you working on?"]', "Spring edition");
      enterPreviewText('input[placeholder="Branch (automatic)"]', "spring-edition");
    }, 20);
    return () => clearTimeout(timer);
  }, []);
  return <NewGitProject />;
}
export function NewWorkspace() { return <NewWorkspaceDialog path={guideWorkspace.path} onClose={noop} onCreated={noop} />; }
export function ArchiveProject() { return <ProjectTeardownDialog project={guideProject} action="archive" onClose={noop} onDone={noop} />; }
export function DeleteProject() { return <ProjectTeardownDialog project={{ ...guideProject, mode: "local", branch: null }} action="delete" onClose={noop} onDone={noop} />; }
export function DeleteProjectWithCopies() {
  useState(() => seedGuideCatalog({ offline: "mac" }));
  return <ProjectTeardownDialog project={linkedGuideProject} action="delete" onClose={noop} onDone={noop} />;
}
export function ProjectSettings({ state = "linked" }: { state?: string }) {
  useState(() => {
    failing = state === "read failed";
    seedGuideCatalog({ offline: state === "offline" ? "local" : undefined, readOnly: state === "read-only" });
  });
  return <div data-preview-stage className="h-[900px]"><ProjectSettingsDialog project={guideMacProject} workspace={guideMacWorkspace} onClose={noop} /></div>;
}


export function RemoveWorkspace() { return <RemoveProjectDialog name={guideWorkspace.name} path={guideWorkspace.path} onCancel={noop} onConfirm={noop} onDone={noop} />; }
export function RenameWorkspace() { return <RenameWorkspaceDialog workspaceId={guideWorkspace.id} name={guideWorkspace.name} onClose={noop} />; }
export function MacRules() { return <MacBridgeRulesDialog sessionId="guide-thread" title="Check the bridge" onClose={noop} />; }
