import { useEffect, useState } from "react";
import type { ReviewSettings } from "@server/shared/review";
import { loadReviewScope, ReviewFields, ReviewSkeleton, saveReviewSettings, useReviewScope, type ReviewRow } from "../chrome/ReviewFields";
import { DialogFooter } from "../chrome/ConfirmDialog";
import { Modal, ModalBody } from "../chrome/Modal";
import { ProjectSettingsDialog } from "../chrome/ProjectDialogs";
import { PageError, PageRow, PageSection } from "../components/page";
import { Button } from "../components/ui/button";
import { registry } from "../lib/connection";
import { settingTitle } from "../lib/settings/map";
import { usePublishHome } from "../lib/settings/pageHome";
import { homeNote } from "../lib/settingsHome";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import type { ProjectMeta } from "../lib/tcserver/types";
import { SettingRow } from "./settings/parts/SettingRow";
import { useDraft } from "./settings/parts/useDraft";
import { useSaved, type Saved } from "./settings/parts/useSaved";

/**
 * Settings → Reviews (docs/agents/settings.md "The pages: Everywhere"): the one set every project follows unless its
 * own sheet sets one. Saves on every change, each row with its mark; while the box that keeps the set is out of reach
 * the controls are held. "Different in N projects" lists the projects that keep their own.
 */
export function ReviewsPage() {
  // The one set is asked of this window's own computer, which forwards it to the box.
  const environmentId = registry.primary().environmentId;
  const { scope, error, retry } = useReviewScope(environmentId, null);
  usePublishHome("reviews", scope ? (scope.home ?? null) : undefined);
  const draft = useDraft(scope?.settings);
  const saved: Record<ReviewRow, Saved> = { on: useSaved(), model: useSaved(), effort: useSaved(), stop: useSaved(), wait: useSaved() };
  const { blocked } = homeNote(scope?.home);
  const change = (next: ReviewSettings, row: ReviewRow) => draft.change(saved[row], next, (set) => saveReviewSettings(environmentId, null, set));

  return (
    <PageSection>
      {draft.value ? (
        <>
          <ReviewFields value={draft.value} onChange={change} environmentId={environmentId} saved={saved} disabled={blocked} />
          {draft.value.beforeMerge ? <DifferentProjects /> : null}
        </>
      ) : error ? (
        <PageError
          action={
            <Button variant="ghost" size="sm" onClick={retry}>
              Retry
            </Button>
          }
        >
          {error}
        </PageError>
      ) : (
        <ReviewSkeleton />
      )}
    </PageSection>
  );
}

/** The code projects that keep a review set of their own, each asked of the computer it lives on. */
export function useOwnReviewProjects(): readonly ProjectMeta[] {
  const { projects } = useWorkspaceCatalog();
  const [own, setOwn] = useState<readonly ProjectMeta[]>([]);
  const ids = projects.map((p) => `${p.environmentId}|${p.id}`).join();
  useEffect(() => {
    let live = true;
    void Promise.all(projects.map((p) => loadReviewScope(p.environmentId, p.id).then((s) => (s.source === "project" ? p : null), () => null))).then((found) => {
      if (live) setOwn(found.filter((p): p is ProjectMeta => p !== null).sort((a, b) => a.name.localeCompare(b.name)));
    });
    return () => {
      live = false;
    };
    // Asked again only when the list of projects changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  return own;
}

/** "Different in N projects": a dialog of the projects with their own set, each opening its sheet. */
function DifferentProjects() {
  const own = useOwnReviewProjects();
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<ProjectMeta | null>(null);
  const { workspaces } = useWorkspaceCatalog();
  const workspace = sheet ? workspaces.find((w) => w.id === sheet.workspaceId && w.environmentId === sheet.environmentId) : undefined;
  return (
    <>
      {own.length ? (
        <SettingRow
          id="reviews.different"
          vars={{ n: own.length }}
          description={own.map((p) => p.name).join(", ")}
          onOpen={() => setOpen(true)}
          openLabel={settingTitle("reviews.different", { n: own.length })}
        />
      ) : null}
      {open ? (
        <Modal title="Different from Reviews" size="sm" onClose={() => setOpen(false)}>
          <ModalBody className="gap-0">
            {own.map((project) => (
              <PageRow
                key={`${project.environmentId}|${project.id}`}
                title={project.name}
                description={workspaces.find((w) => w.id === project.workspaceId && w.environmentId === project.environmentId)?.name}
                openLabel={project.name}
                onOpen={() => {
                  setOpen(false);
                  setSheet(project);
                }}
              />
            ))}
          </ModalBody>
          <DialogFooter confirmLabel="Done" closeOnConfirm onConfirm={() => setOpen(false)} />
        </Modal>
      ) : null}
      {sheet && workspace ? <ProjectSettingsDialog project={sheet} workspace={workspace} onClose={() => setSheet(null)} /> : null}
    </>
  );
}
