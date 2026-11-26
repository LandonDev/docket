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
import { computerInLine, useComputerNames } from "../lib/settings/computerName";
import { ReadFailure } from "./settings/parts/ReadFailure";
import { usePublishHome } from "../lib/settings/pageHome";
import { homeNote } from "../lib/settingsHome";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import type { ProjectMeta } from "../lib/tcserver/types";
import { OpenCue, SettingRow } from "./settings/parts/SettingRow";
import { andList } from "@shared/addons";
import { reviewerModel } from "../lib/reviewScope";
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
          {/* Shown with Reviews off too: a project may keep reviews on of its own. */}
          <DifferentProjects />
        </>
      ) : error ? (
        <ReadFailure computer={environmentId} error={error} retry={retry} />
      ) : (
        <ReviewSkeleton />
      )}
    </PageSection>
  );
}

/** A code project that keeps a review set of its own, and that set. */
export type OwnReview = { project: ProjectMeta; settings: ReviewSettings };

/**
 * The code projects that keep a review set of their own, each asked of the computer it lives on; `unread` the projects
 * whose computer did not answer, so the list is partial until `retry` reads them.
 */
export function useOwnReviewProjects(): { own: readonly OwnReview[]; unread: readonly ProjectMeta[]; retry: () => void } {
  const { projects } = useWorkspaceCatalog();
  const [own, setOwn] = useState<readonly OwnReview[]>([]);
  const [unread, setUnread] = useState<readonly ProjectMeta[]>([]);
  const [attempt, setAttempt] = useState(0);
  const ids = projects.map((p) => `${p.environmentId}|${p.id}`).join();
  useEffect(() => {
    let live = true;
    void Promise.all(
      projects.map((project) =>
        loadReviewScope(project.environmentId, project.id).then(
          (scope) => ({ project, own: scope.source === "project" ? { project, settings: scope.override ?? scope.settings } : null, read: true }),
          () => ({ project, own: null, read: false }),
        ),
      ),
    ).then((found) => {
      if (!live) return;
      setOwn(found.flatMap((f) => (f.own ? [f.own] : [])).sort((a, b) => a.project.name.localeCompare(b.project.name)));
      setUnread(found.flatMap((f) => (f.read ? [] : [f.project])));
    });
    return () => {
      live = false;
    };
    // Asked again when the list of projects changes, and on Retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, attempt]);
  return { own, unread, retry: () => setAttempt((n) => n + 1) };
}

/** A partial list's line, one a computer: "The box did not answer, so 2 of its projects are not counted." */
export function unreadWords(computer: string, count: number): string {
  return `${computer.charAt(0).toUpperCase()}${computer.slice(1)} did not answer, so ${count === 1 ? "1 of its projects is" : `${count} of its projects are`} not counted.`;
}

/** The open row's line: which projects have reviews off, then which keep a set of their own with reviews on. */
export function differentWords(own: readonly OwnReview[]): string {
  const off = own.filter((o) => !o.settings.beforeMerge).map((o) => o.project.name);
  const on = own.filter((o) => o.settings.beforeMerge).map((o) => o.project.name);
  return [
    off.length ? `${andList(off)} ${off.length === 1 ? "has" : "have"} reviews off` : null,
    on.length ? `${andList(on)} ${on.length === 1 ? "has its own review model" : "have their own review models"}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** "Different in N projects": a dialog of the projects with their own set, each saying how it differs and opening its
 *  sheet. */
function DifferentProjects() {
  const { own, unread, retry } = useOwnReviewProjects();
  const names = useComputerNames();
  const byComputer = [...new Set(unread.map((p) => p.environmentId))].map((id) => ({ id, count: unread.filter((p) => p.environmentId === id).length }));
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<ProjectMeta | null>(null);
  const { workspaces } = useWorkspaceCatalog();
  const workspace = sheet ? workspaces.find((w) => w.id === sheet.workspaceId && w.environmentId === sheet.environmentId) : undefined;
  return (
    <>
      {own.length ? (
        <SettingRow id="reviews.different" vars={{ n: own.length }} description={differentWords(own)} onOpen={() => setOpen(true)} openLabel={settingTitle("reviews.different", { n: own.length })} />
      ) : null}
      {/* A computer that did not answer leaves the count partial: said once for it, by name, with Retry. */}
      {byComputer.map(({ id, count }) => (
        <PageError
          key={id}
          data-unread={id}
          action={
            <Button variant="ghost" size="sm" onClick={retry}>
              Retry
            </Button>
          }
        >
          {unreadWords(computerInLine(names(id)), count)}
        </PageError>
      ))}
      {open ? (
        <Modal title="Different from Reviews" size="sm" onClose={() => setOpen(false)}>
          <ModalBody className="gap-0">
            {own.map(({ project, settings }) => (
              <PageRow
                key={`${project.environmentId}|${project.id}`}
                title={project.name}
                description={settings.beforeMerge ? `Reviews on, ${reviewerModel(settings, project.environmentId)?.name ?? "its own review model"}` : "Reviews off"}
                openLabel={project.name}
                onOpen={() => {
                  setOpen(false);
                  setSheet(project);
                }}
              >
                <OpenCue />
              </PageRow>
            ))}
          </ModalBody>
          <DialogFooter confirmLabel="Done" closeOnConfirm onConfirm={() => setOpen(false)} />
        </Modal>
      ) : null}
      {sheet && workspace ? <ProjectSettingsDialog project={sheet} workspace={workspace} onClose={() => setSheet(null)} /> : null}
    </>
  );
}
