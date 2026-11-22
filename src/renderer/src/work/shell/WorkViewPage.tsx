import { Component, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { WORK_VIEWS, type WorkViewId, type WorkViewModule, type WorkViewProps } from "../views/registry";
import { registry, useEnvironmentStatus } from "../../lib/connection";
import { openWorkSettings } from "./open";
import { reopenLifeos, useLifeosSession, useLifeosStatus } from "./lifeos";
import { startThreadAbout } from "./WorkColumn";
import { clockTime } from "../../lib/duration";

// The sign-in dialog Connections uses, loaded on the press: a view's sign-in opens it in place, never a page without it.
const SignInDialog = lazy(() => import("./settings").then((m) => ({ default: m.SignInDialog })));

/**
 * The main pane while one of a Work workspace's views is open (App mounts it
 * over the thread panes, under the strip): the view's 40px header (its glyph,
 * its name, the controls the view's chunk puts there; none for a view that
 * draws its own head, as Mail does), then the view, which
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
  // The header's controls come from the chunk. The module is kept in state: read from the chunk while rendering it is a
  // constant to the React Compiler, so a first render before the chunk landed kept its null and the controls never showed.
  const [loaded, setLoaded] = useState<WorkViewModule | null>(() => def.chunk.loaded());
  useEffect(() => {
    if (loaded) return;
    let live = true;
    void def.chunk.load().then((module) => live && setLoaded(module), () => {});
    return () => {
      live = false;
    };
  }, [def, loaded]);
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
  // A sign-in he started and has not approved yet, and a host whose Work is off: each says so, with its own press.
  const pairing = gated && state === "pairing";
  const off = gated && state === "off";
  // A host never heard from (asleep, offline): its name and Retry, never bones that pulse for ever.
  const link = useEnvironmentStatus(environmentId);
  const away = gated && state === null && link.transport !== "open" && link.transport !== "connecting" && link.transport !== "reconnecting";
  const [signingIn, setSigningIn] = useState(false);
  const host = registry.environment(environmentId)?.name ?? "This host";
  // A view with its own head (Mail) has no header over it, but the sign-in has no head and keeps the header.
  const blocked = signedOut || pairing || off || away;
  const headless = !!def.ownHead && !blocked;
  // The view covers the thread's pane, which goes inert under it (App.tsx): focus that was in the pane, or fell to the
  // page with it, lands on the view's heading, never on a composer or canvas control no one can see.
  const region = useRef<HTMLDivElement | null>(null);
  const heading = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const at = document.activeElement;
    const covered = region.current?.parentElement;
    if (!covered) return;
    if (!at || at === document.body || (covered.contains(at) && !region.current!.contains(at))) (heading.current ?? region.current)?.focus({ preventScroll: true });
  }, []);
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
    <div
      ref={region}
      role="region"
      aria-label={def.label}
      // Headless, the region itself takes the focus the heading would have, and says the view's name.
      tabIndex={headless ? -1 : undefined}
      // A file dropped on a view opens in a new thread of the workspace (work/canvas/fileDrop.tsx).
      data-file-opens
      className="absolute inset-0 z-40 flex min-h-0 min-w-0 flex-col bg-background outline-none"
    >
      {headless ? null : (
        <div className="@container/viewhead flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-[13px]">
          <Icon className="size-3.5 text-muted-foreground" />
          <span ref={heading} tabIndex={-1} data-view-heading className="focus-ring flex min-w-0 items-center rounded-sm">
            {Title && !blocked ? <Title {...props} /> : <span className="font-medium text-foreground">{def.label}</span>}
          </span>
          <span className="flex-1" />
          {Head && !blocked ? <Head {...props} /> : null}
        </div>
      )}
      {unreachable && !blocked ? (
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
        {away ? (
          <EmptyState title={`${host} is not connected`} action={{ label: "Retry", onClick: () => registry.retry(environmentId) }} />
        ) : off ? (
          <EmptyState title={`Work is off on ${host}`} action={{ label: "Open Settings", onClick: openWorkSettings }} />
        ) : signedOut || pairing ? (
          <EmptyState
            title={pairing ? "The LifeOS sign-in waits for your approval" : state === "refused" || session.state === "refused" ? "LifeOS refused this host's sign-in" : "Sign in to LifeOS"}
            action={{ label: pairing ? "Show the code" : "Sign in", onClick: () => setSigningIn(true) }}
          />
        ) : (
          <ViewBoundary label={def.label} onRetry={() => setAttempt((n) => n + 1)}>
            <Suspense fallback={<ViewSkeleton label={def.label} />}>
              <View {...props} />
            </Suspense>
          </ViewBoundary>
        )}
      </div>
      {signingIn && status ? (
        <Suspense fallback={null}>
          <SignInDialog environmentId={environmentId} state={status.lifeos} onClose={() => setSigningIn(false)} />
        </Suspense>
      ) : null}
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
