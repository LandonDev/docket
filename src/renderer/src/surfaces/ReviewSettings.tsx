import { useEffect, useState } from "react";
import type { ReviewSettings } from "@server/shared/review";
import { loadReviewScope, ReviewFields, ReviewSkeleton, saveReviewSettings, useReviewScope, type ReviewRow } from "../chrome/ReviewFields";
import { DialogFooter } from "../chrome/ConfirmDialog";
import { Modal, ModalBody } from "../chrome/Modal";
import { ProjectSettingsDialog } from "../chrome/ProjectDialogs";
import { PageRow, PageRowsSkeleton, PageSection } from "../components/page";
import { withDeadline } from "../lib/connection/openRead";
import { registry } from "../lib/connection";
import { settingTitle } from "../lib/settings/map";
import { useLinkMay } from "../lib/linkMay";
import { useComputerName } from "../lib/settings/computerName";
import { ManagedLine } from "./settings/parts/ManagedLine";
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
  // A key that may read the set but not change it sees each value as words, and one line saying who can.
  const may = useLinkMay(environmentId, "review.set", { projectId: null, settings: null });
  const computer = useComputerName(environmentId);
  const change = (next: ReviewSettings, row: ReviewRow) => draft.change(saved[row], next, (set) => saveReviewSettings(environmentId, null, set));

  // A failed read is said at the page's head; no empty section stands under it.
  if (!draft.value && error) return <ReadFailure computer={environmentId} error={error} retry={retry} />;
  return (
    <>
      {/* Who can change the set is said first, above the section. */}
      {may ? null : <ManagedLine computer={scope?.home?.name ?? computer.name} />}
      <PageSection>
        {draft.value ? (
          <>
            <ReviewFields value={draft.value} onChange={change} environmentId={environmentId} saved={saved} disabled={blocked || draft.busy} readOnly={!may} />
            {/* Shown with Reviews off too: a project may keep reviews on of its own. */}
            <DifferentProjects />
          </>
        ) : (
          <ReviewSkeleton />
        )}
      </PageSection>
    </>
  );
}

/** A code project that keeps a review set of its own, and that set. */
export type OwnReview = { project: ProjectMeta; settings: ReviewSettings };

/**
 * The code projects that keep a review set of their own, each asked of the computer it lives on, each read with the
 * house's deadline. `pending` while any is out; `unread` the projects whose computer did not answer (with the reason),
 * so the list is partial until `retry` reads them again.
 */
export function useOwnReviewProjects(): {
  own: readonly OwnReview[];
  unread: readonly { project: ProjectMeta; error: string }[];
  pending: boolean;
  retry: () => void;
} {
  const { projects } = useWorkspaceCatalog();
  const [own, setOwn] = useState<readonly OwnReview[]>([]);
  const [unread, setUnread] = useState<readonly { project: ProjectMeta; error: string }[]>([]);
  const [pending, setPending] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const ids = projects.map((p) => `${p.environmentId}|${p.id}`).join();
  useEffect(() => {
    let live = true;
    setPending(true);
    void Promise.all(
      projects.map((project) =>
        withDeadline(loadReviewScope(project.environmentId, project.id)).then(
          (scope) => ({ project, own: scope.source === "project" ? { project, settings: scope.override ?? scope.settings } : null, error: null as string | null }),
          (err: unknown) => ({ project, own: null, error: err instanceof Error ? err.message : String(err) }),
        ),
      ),
    ).then((found) => {
      if (!live) return;
      setOwn(found.flatMap((f) => (f.own ? [f.own] : [])).sort((a, b) => a.project.name.localeCompare(b.project.name)));
      setUnread(found.flatMap((f) => (f.error === null ? [] : [{ project: f.project, error: f.error }])));
      setPending(false);
    });
    return () => {
      live = false;
    };
    // Asked again when the list of projects changes, and on Retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, attempt]);
  return { own, unread, pending, retry: () => setAttempt((n) => n + 1) };
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
  const { own, unread, pending, retry } = useOwnReviewProjects();
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<ProjectMeta | null>(null);
  const { workspaces } = useWorkspaceCatalog();
  const workspace = sheet ? workspaces.find((w) => w.id === sheet.workspaceId && w.environmentId === sheet.environmentId) : undefined;
  // Still reading: the row's shape, never a count it does not have.
  if (pending && !open && !sheet) return <PageRowsSkeleton rows={[{ description: true, control: "none" }]} />;
  // A computer that did not answer leaves the count a floor, the projects named, its failure at the page's head.
  const n = unread.length ? `at least ${own.length}` : own.length;
  const line = [own.length ? differentWords(own) : null, unread.length ? `Not heard from ${unread.map((u) => u.project.name).join(", ")}` : null].filter(Boolean).join(". ");
  return (
    <>
      {unread.map(({ project, error }) => (
        <ReadFailure key={`${project.environmentId}|${project.id}`} computer={project.environmentId} error={error} retry={retry} />
      ))}
      {own.length || unread.length ? (
        <SettingRow
          id="reviews.different"
          vars={{ n }}
          description={line}
          onOpen={own.length ? () => setOpen(true) : undefined}
          openLabel={own.length ? settingTitle("reviews.different", { n }) : undefined}
        />
      ) : null}
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
      {sheet && workspace ? (
        <ProjectSettingsDialog
          project={sheet}
          workspace={workspace}
          onClose={() => {
            setSheet(null);
            // What he changed in the sheet is read again, so the list says it.
            retry();
          }}
        />
      ) : null}
    </>
  );
}
