import { useEffect, useState, type ReactNode } from "react";
import { weekWords } from "@shared/work/review";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { Tip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { openWorkView } from "../../lib/workSwitch";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { project } from "../../stores/project";
import { shell } from "../../stores/shell";
import { showWeekAt, shownWeek, stepShown, useShownFrom } from "./shown";
import { loadRoutine, loadWeek, useReview } from "./store";

/**
 * The page's controls, at the end of the frame's 40px header: "This week"
 * when another week shows, the week shown, Previous and Next, and a menu
 * with Make again and the routine that makes the review. Nothing here says
 * the week twice: the page under it has no title.
 */
export function Head() {
  const from = useShownFrom();
  const week = shownWeek(from);
  // Read so the label follows the zone once a host has said it.
  const view = useReview(week);
  const [routine, setRoutine] = useState<Awaited<ReturnType<typeof loadRoutine>>>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // The routine is asked for when the menu opens: it can be moved, paused or removed at any time.
  useEffect(() => {
    if (!menuOpen) return;
    let live = true;
    void loadRoutine().then((r) => live && setRoutine(r));
    return () => {
      live = false;
    };
  }, [menuOpen]);

  const rows: MenuRow[] = [{ kind: "item", id: "again", label: "Make again" }, ...(routine ? [{ kind: "item" as const, id: "routine", label: `Made ${routine.words}…` }] : [])];
  const pick = (id: string): void => {
    if (id === "again") void loadWeek(week);
    if (id === "routine" && routine) openRoutines(routine.environmentId, routine.workspaceId);
  };
  return (
    <HeadView
      label={weekWords(week, view.tz)}
      thisWeek={from === null}
      onStep={stepShown}
      onThisWeek={() => showWeekAt(null)}
      menu={
        <RowsMenu
          label="Review"
          align="end"
          rows={rows}
          onPick={pick}
          onOpenChange={setMenuOpen}
          tip={{ label: "More" }}
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label="More" className="text-muted-foreground">
              <MoreHorizontal />
            </Button>
          }
        />
      }
    />
  );
}

/** The routine's own workspace comes forward with Routines open: it is an ordinary routine, edited there. */
function openRoutines(environmentId: string, workspaceId: string): void {
  const workspace = workspaceStore.getSnapshot().workspaces.find((w) => w.environmentId === environmentId && w.id === workspaceId);
  if (!workspace) return;
  shell.closeViews();
  project.enterWorkspace(workspace.path);
  openWorkView({ workspaceId, view: "routines" });
}

/**
 * The controls as drawn: what the preview and the test render. The frame sets them at the header's end, so they
 * read as one group from the left: "This week" while another week shows, the week, Previous and Next, the menu.
 */
export function HeadView({ label, thisWeek, onStep, onThisWeek, menu }: { label: string; thisWeek: boolean; onStep: (by: number) => void; onThisWeek: () => void; menu?: ReactNode }) {
  return (
    <div className="flex items-center gap-1 text-[13px]">
      {thisWeek ? null : (
        <Button variant="ghost" size="xs" className="shrink-0 text-muted-foreground" onClick={onThisWeek}>
          This week
        </Button>
      )}
      <span data-review-week className="shrink-0 px-1 text-foreground tabular-nums">
        {label}
      </span>
      <span className="flex shrink-0 items-center">
        <Tip label="Previous week">
          <Button variant="ghost" size="icon-xs" aria-label="Previous week" className="text-muted-foreground" onClick={() => onStep(-1)}>
            <ChevronLeft />
          </Button>
        </Tip>
        <Tip label="Next week">
          <Button variant="ghost" size="icon-xs" aria-label="Next week" className="text-muted-foreground" disabled={thisWeek} onClick={() => onStep(1)}>
            <ChevronRight />
          </Button>
        </Tip>
      </span>
      {menu}
    </div>
  );
}
