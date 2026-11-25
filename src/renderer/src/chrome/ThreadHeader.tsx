import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ThreadRules } from "@server/shared/rules";
import type { ThreadType } from "../lib/tcserver/types";
import type { HeaderModel } from "../lib/threadHeaderModel";
import type { ReadyMap } from "../lib/threadStripModel";
import { TooltipProvider } from "../components/ui/tooltip";
import { AgentsCue } from "./AgentsCue";
import { ComputerCue } from "./ComputerCue";
import { NewThreadChooser } from "./NewThreadChooser";
import { ProjectPlanChip } from "./ProjectPlanChip";
import {
  ThreadHeaderStrip,
  type ArchivedThread,
  type ChipThread,
  type StripOverflow,
} from "./ThreadHeaderStrip";
import { ThreadMenu } from "./ThreadMenu";
import { useThreadHost } from "./ThreadHostChip";
import { useThreadMenu } from "./useThreadMenu";
import { WorkCrumb } from "./WorkCrumb";
import { useMasterIds } from "../lib/masterThread";
import { useWorkSessionId } from "../lib/workRow";
import { sessionStore } from "../lib/tcserver/store";

/**
 * The deck title bar's thread surface: temp-code's strip and heading
 * controls inside MonoCode's shell. The chips' right-click and the ⋯ menu
 * are the thread's one menu (chrome/useThreadMenu.tsx); this keeps the
 * inline rename, Pause all and the panel toggle, and hands rename, archive,
 * delete, the type and the options back to App by thread id. The end group
 * is the project plan's chip when there is one, the live-agents cue while a
 * subagent of the thread on screen is live (chrome/AgentsCue.tsx, its own
 * subscriber), the computer cue while a computer session this desktop can
 * draw is live in its tree (chrome/ComputerCue.tsx), then ⋯, then Panel. The home
 * draws no strip: the thread on screen's title, then the same end group.
 */

export type ThreadHeaderProps = {
  model: HeaderModel<ChipThread>;
  planReady: ReadyMap;
  archived: ArchivedThread[];
  /** The selected project's workspace, for the tune's base rules. */
  workspaceId: string | null;
  /** The active thread's cumulative cost in dollars, when known. */
  cost: number | null;
  /** Roots with live work anywhere in their tree. */
  running: number;
  railOpen: boolean;
  /** False while the thread's row is too narrow to draw the panel. */
  panelRoom?: boolean;
  /** The thread in the focused pane, drawn as a chip or not (an unsent draft has none): a Work draft's crumb reads it. */
  onScreenId?: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onSetRules: (id: string, rules: ThreadRules | null) => void;
  onRestore: (id: string) => void;
  onNew: (threadType: ThreadType, tune: ThreadRules | null) => void;
  onPauseAll: () => Promise<unknown>;
  onToggleRail: () => void;
  /** The thread menu's Type rows (App's onThreadTypeChange). */
  onSetType: (id: string, threadType: ThreadType) => void;
};

export function ThreadHeader({
  model,
  planReady,
  archived,
  workspaceId,
  cost,
  running,
  railOpen,
  panelRoom,
  onScreenId = null,
  onSelect,
  onRename,
  onArchive,
  onDelete,
  onSetRules,
  onRestore,
  onNew,
  onPauseAll,
  onToggleRail,
  onSetType,
  onShowTerminal,
  onNewTerminal,
  projectTerminalActive = false,
  standIns,
  stripRef,
  overflow,
  onScrollBy,
  activeRef,
}: ThreadHeaderProps & {
  stripRef: (el: HTMLDivElement | null) => void;
  /** The live row's overflow and its scroll, from the title bar. */
  overflow?: StripOverflow;
  onScrollBy?: (direction: -1 | 1) => void;
  activeRef: (el: HTMLDivElement | null) => void;
  /** The project terminal, from the title bar: the menu's Terminal row. */
  onShowTerminal?: () => void;
  onNewTerminal?: () => void;
  projectTerminalActive?: boolean;
  /** The rail's stand-ins while it is closed (chrome/TitleBar.tsx): they
   *  lead the end group, so Panel stays last. */
  standIns?: ReactNode;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const menu = useThreadMenu({
    onRename: setRenamingId,
    onArchive,
    onDelete,
    onSetType,
    onSetRules,
  });
  const host = useThreadHost(model.activeId);
  // A Work thread in front: no terminal and no project plan, both a code project's.
  const work = useWorkSessionId(model.activeId ?? onScreenId);
  const masterIds = useMasterIds();
  // The active chip sits on either row: a settled thread on screen is on the
  // shelf; on the home, with no strip, it is the bar's title.
  const chipOf = (id: string | null) =>
    model.live.find((c) => c.id === id) ??
    model.dormant.find((c) => c.id === id) ??
    (model.heading?.id === id ? model.heading : null) ??
    null;
  const activeChip = chipOf(model.activeId);

  const commitRename = (id: string, title: string) => {
    setRenamingId(null);
    const chip = chipOf(id);
    if (title && chip && title !== chip.thread.title) onRename(id, title);
  };

  const empty = model.live.length === 0 && model.dormant.length === 0;
  // A Work thread in front has no strip of chips: the bar is its crumb, the job's dot, its project and its title.
  // An unsent Work draft: the bar is its crumb alone, the job's dot and its project, until it is sent.
  const draftWhere = useDraftWhere(work ? (activeChip?.id ?? onScreenId) : null);
  const workHeading = work && !draftWhere && activeChip;
  return (
    <>
      <ThreadHeaderStrip
        model={
          workHeading || draftWhere
            ? { ...model, live: [], dormant: [], list: [...model.live, ...model.dormant], heading: workHeading ? activeChip : null }
            : model
        }
        crumb={workHeading ? <WorkCrumb thread={activeChip.thread} /> : draftWhere ? <WorkCrumb thread={draftWhere} last /> : undefined}
        planReady={planReady}
        renamingId={renamingId}
        onSelect={onSelect}
        onStartRename={setRenamingId}
        onRename={commitRename}
        menu={{
          rowsFor: (id) => (id ? menu.rowsFor(id) : null),
          onPick: (pick, id) => id && menu.onPick(id, pick),
          onOpenChange: (open, id) => menu.onOpenChange(id, open),
        }}
        activeRef={activeRef}
        masterIds={masterIds}
        stripRef={stripRef}
        overflow={overflow}
        onScrollBy={onScrollBy}
        trailing={<NewThreadChooser workspaceId={workspaceId} empty={empty} onStart={onNew} />}
        end={
          // Its own TooltipProvider: the strip's rows each have theirs, so no
          // provider sits around a scroller (the lazy one remounts what it wraps).
          <TooltipProvider>
            <div className="flex shrink-0 items-center gap-0.5">
              {standIns}
              {work ? null : <ProjectPlanChip />}
              <AgentsCue threadId={model.activeId} room={panelRoom} />
              <ComputerCue threadId={model.activeId} room={panelRoom} />
              <ThreadMenu
                host={activeChip ? host.host : null}
                cost={cost}
                rows={activeChip ? menu.rowsFor(activeChip.id) : []}
                onPick={(id) => activeChip && menu.onPick(activeChip.id, id)}
                onOpen={() => menu.onOpenChange(model.activeId, true)}
                running={running}
                onPauseAll={onPauseAll}
                terminal={work ? { active: false } : { onShow: onShowTerminal, onNew: onNewTerminal, active: projectTerminalActive }}
                recent={model.dormant}
                onOpenRecent={onSelect}
                archived={archived}
                onRestore={onRestore}
                panel={{ open: railOpen, room: panelRoom, onToggle: onToggleRail }}
              />
            </div>
          </TooltipProvider>
        }
      />
      {menu.dialogs}
    </>
  );
}

/** Where an unsent draft files, as one string so a push that moves anything else renders nothing; null for none or a sent thread. */
function useDraftWhere(id: string | null): { workspaceId: string | null; projectId: string | null; environmentId: string } | null {
  const key = useSyncExternalStore(sessionStore.subscribe, () => {
    const s = id && sessionStore.isDraft(id) ? sessionStore.get(id) : undefined;
    return s ? `${s.environmentId}\n${s.workspaceId ?? ""}\n${s.projectId ?? ""}` : "";
  });
  return useMemo(() => {
    if (!key) return null;
    const [environmentId, workspaceId, projectId] = key.split("\n");
    return { environmentId: environmentId!, workspaceId: workspaceId || null, projectId: projectId || null };
  }, [key]);
}
