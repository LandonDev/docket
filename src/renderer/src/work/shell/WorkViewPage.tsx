import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { SectorKey } from "@shared/work";
import type { LifeosStateName } from "@shared/contract-work-lifeos";
import { Button } from "../../components/ui/button";
import { EmptyState, SurfaceSkeleton } from "../../surfaces/SurfaceSkeleton";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { openWorkView, useWorkView } from "../../lib/workSwitch";
import { useSelectedWorkspaceIds } from "../../stores/project";
import { StatusMark } from "../../components/ui/status";
import { WORK_VIEWS, type WorkViewId, type WorkViewProps } from "../views/registry";
import { openWorkSettings } from "./open";
import { useLifeosSession, useLifeosStatus, watchLifeos } from "./lifeos";
import { startThreadAbout } from "./WorkColumn";
import { clockTime } from "../../lib/duration";

/**
 * The main pane while one of a Work workspace's views is open (App mounts it
 * over the thread panes, under the strip): the view's 40px header (its glyph,
 * its name, the controls the view's chunk puts there), then the view, which
 * reads LifeOS through the workspace's own sector. Signed out it is one
 * sign-in; unreachable, one state line over what was last shown.
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

function ViewFrame({ view, environmentId, workspaceId, sector }: { view: WorkViewId; environmentId: string; workspaceId: string; sector: SectorKey }) {
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
  const props = useMemo<WorkViewProps>(
    () => ({ env: environmentId, workspace, sector, lifeos: session, startThread: (about) => startThreadAbout(about) }),
    [environmentId, workspace, sector, session],
  );
  const View = useMemo(() => lazy(() => def.chunk.load().then((m) => ({ default: m.View }))), [def]);
  const Icon = def.icon;
  const signedOut = state === "signed-out" || state === "refused";
  return (
    <div role="region" aria-label={def.label} className="absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-[13px]">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground">{def.label}</span>
        <span className="flex-1" />
        {loaded?.Head && !signedOut ? loaded.Head(props) : null}
      </div>
      {status?.lifeos.state === "unreachable" ? (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
          <StatusMark state="failed" word={false} />
          <span className="font-medium text-destructive">LifeOS did not answer</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">As of {clockTime(status.lifeos.since)}</span>
          <Button variant="ghost" size="xs" onClick={() => watchLifeos(environmentId)}>
            Retry
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {signedOut ? (
          <EmptyState title="Sign in to LifeOS" action={{ label: "Sign in", onClick: openWorkSettings }} />
        ) : (
          <Suspense fallback={<SurfaceSkeleton kind="page" label={`Loading ${def.label}`} />}>
            <View {...props} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
