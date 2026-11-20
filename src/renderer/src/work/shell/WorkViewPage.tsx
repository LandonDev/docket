import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SectorKey } from "@shared/work";
import type { LifeosStateName } from "@shared/contract-work-lifeos";
import { BusyLabel, Button } from "../../components/ui/button";
import { EmptyState, SurfaceSkeleton } from "../../surfaces/SurfaceSkeleton";
import { errorText } from "../../chrome/ConfirmDialog";
import { loadToast } from "../../components/ui/toaster";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { openWorkView, useWorkView } from "../../lib/workSwitch";
import { useSelectedWorkspaceIds } from "../../stores/project";
import { StatusMark } from "../../components/ui/status";
import { WORK_VIEWS, type WorkViewId, type WorkViewProps } from "../views/registry";
import { openWorkSettings } from "./open";
import { reopenLifeos, useLifeosSession, useLifeosStatus } from "./lifeos";
import { startThreadAbout } from "./WorkColumn";
import { clockTime } from "../../lib/duration";

/**
 * The main pane while one of a Work workspace's views is open (App mounts it
 * over the thread panes, under the strip): the view's 40px header (its glyph,
 * its name, the controls the view's chunk puts there), then the view, which
 * reads LifeOS through the workspace's own sector. Signed out it is one
 * sign-in; unreachable, one state line over what was last shown. While the
 * view's chunk loads it is a column of rows; a view that throws (a LifeOS
 * read refused) is its own error with Retry, never the window's.
 */
export function WorkViewSurface() {
  const open = useWorkView();
  const workspace = useWorkspaces().find((w) => w.id === open?.workspaceId);
  // The window moved to another workspace (or the Work Chats): this one's view goes with it.
  const selected = useSelectedWorkspaceIds();
  const elsewhere = !!open && !selected?.includes(open.workspaceId);
  useEffect(() => {
    if (elsewhere) openWorkView(null);
  }, [elsewhere]);
  if (elsewhere) return null;
  if (!open || !workspace?.sector) return null;
  const def = WORK_VIEWS[open.view as WorkViewId];
  if (!def) return null;
  return <ViewFrame key={`${workspace.id}:${def.id}`} view={def.id} environmentId={workspace.environmentId} workspaceId={workspace.id} sector={workspace.sector as SectorKey} />;
}

export function ViewFrame({ view, environmentId, workspaceId, sector }: { view: WorkViewId; environmentId: string; workspaceId: string; sector: SectorKey }) {
  const def = WORK_VIEWS[view];
  const workspace = useWorkspaces().find((w) => w.id === workspaceId)!;
  const status = useLifeosStatus(environmentId);
  const session = useLifeosSession(environmentId, sector);
  const state: LifeosStateName | null = status?.lifeos.state ?? null;
  // The header's controls come from the chunk: draw again once it lands, or they never show.
  const [, landed] = useState(0);
  useEffect(() => {
    if (!def.chunk.loaded()) void def.chunk.load().then(() => landed((n) => n + 1), () => {});
  }, [def]);
  const loaded = def.chunk.loaded();
  const Head = loaded?.Head;
  const Title = loaded?.Title;
  const props = useMemo<WorkViewProps>(
    () => ({ env: environmentId, workspace, sector, lifeos: session, startThread: (about, at) => startThreadAbout(about, at?.projectId ?? null, at?.cwd) }),
    [environmentId, workspace, sector, session],
  );
  // React.lazy keeps a rejection for good: the boundary's Retry makes a fresh one, which imports again.
  const [attempt, setAttempt] = useState(0);
  const View = useMemo(() => lazy(() => def.chunk.load().then((m) => ({ default: m.View }))), [def, attempt]);
  const Icon = def.icon;
  // A view that reads the host alone (Routines) is never behind LifeOS's sign-in or its line.
  const gated = def.readsLifeos;
  // The session's own state counts too: its JWT can be refused or go unanswered while the host says connected.
  const signedOut = gated && (state === "signed-out" || state === "refused" || session.state === "signed-out" || session.state === "refused");
  const unreachable = gated && (state === "unreachable" || session.state === "unreachable");
  const [retrying, setRetrying] = useState(false);
  const retry = (): void => {
    setRetrying(true);
    reopenLifeos(environmentId, sector)
      .catch((err: unknown) => void loadToast().then((toast) => toast.error("LifeOS did not answer", { description: errorText(err) })))
      .finally(() => setRetrying(false));
  };
  return (
    // Over every layer a thread's pane raises (its composer and queue reach z-30), under dialogs and menus (--layer-dialog 90):
    // the draft composer must not float over a view's body.
    <div role="region" aria-label={def.label} className="absolute inset-0 z-40 flex min-h-0 min-w-0 flex-col bg-background">
      <div className="@container/viewhead flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-[13px]">
        <Icon className="size-3.5 text-muted-foreground" />
        {Title && !signedOut ? <Title {...props} /> : <span className="font-medium text-foreground">{def.label}</span>}
        <span className="flex-1" />
        {Head && !signedOut ? <Head {...props} /> : null}
      </div>
      {unreachable && !signedOut ? (
        // The state line's shape (DESIGN.md "The state line"): 32px, glyph, the word in its tone, a muted detail, one action.
        <div data-view-state="failed" role="status" className="flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[13px] leading-5">
          <StatusMark
            state="failed"
            word="LifeOS did not answer"
            detail={status?.lifeos.state === "unreachable" ? `As of ${clockTime(status.lifeos.since)}` : undefined}
            className="min-w-0 flex-1"
          />
          <Button variant="ghost" size="xs" disabled={retrying} onClick={retry}>
            <BusyLabel busy={retrying} label="Retry" />
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {signedOut ? (
          <EmptyState title="Sign in to LifeOS" action={{ label: "Sign in", onClick: openWorkSettings }} />
        ) : (
          <ViewBoundary label={def.label} onRetry={() => setAttempt((n) => n + 1)}>
            <Suspense fallback={<ViewSkeleton label={def.label} />}>
              <View {...props} />
            </Suspense>
          </ViewBoundary>
        )}
      </div>
    </div>
  );
}

/** A view's chunk on its way: the one-column rows Tasks, Agenda, Docs and the lists start as, under the view's own header. */
function ViewSkeleton({ label }: { label: string }) {
  return (
    <div className="mx-auto w-full max-w-[720px] px-5 py-5">
      <SurfaceSkeleton kind="rows" count={6} label={`Loading ${label}`} />
    </div>
  );
}

/** A view that throws (a LifeOS read refused, a chunk that did not load) is the view's error with Retry, which mounts it again. */
export class ViewBoundary extends Component<{ label: string; children: ReactNode; onRetry?: () => void }, { error: string | null; attempt: number }> {
  override state = { error: null as string | null, attempt: 0 };
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: errorText(error) };
  }
  override render(): ReactNode {
    if (this.state.error !== null)
      return (
        <EmptyState
          title={`${this.props.label} did not load`}
          line={this.state.error}
          action={{
            label: "Retry",
            onClick: () => {
              this.props.onRetry?.();
              this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
            },
          }}
        />
      );
    return <ViewAttempt key={this.state.attempt}>{this.props.children}</ViewAttempt>;
  }
}

function ViewAttempt({ children }: { children: ReactNode }) {
  return children;
}
