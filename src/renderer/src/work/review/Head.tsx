import { useEffect, useRef, useState, type ReactNode } from "react";
import { WEEK_OF, weekWords } from "@shared/work/review";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { Tip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { useWorkPlaceAt } from "../../lib/workPlaceAt";
import { openWorkView } from "../../lib/workSwitch";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { project } from "../../stores/project";
import { shell } from "../../stores/shell";
import { showWeekAt, shownWeek, stepShown, useShownFrom, useWeekTurn } from "./shown";
import { loadRoutine, makeAgain, thisWeek, useReview, weekAt } from "./store";

/** The routine as a host last named it: the menu draws it at once the next time the page opens. */
let kept: Awaited<ReturnType<typeof loadRoutine>> = null;
let asks = 0;

/**
 * The page's controls, at the end of the frame's 40px header: "This week"
 * when another week shows, the week shown, Previous and Next, and a menu
 * with Make again and the routine that makes the review. Nothing here says
 * the week twice: the page under it has no title.
 */
export function Head() {
  const from = useShownFrom();
  useWeekTurn();
  // A week the page was opened at and has not moved to yet (ReviewPage): the head names it, never the week on its way out.
  const wanted = useWorkPlaceAt("review");
  const week = wanted === null ? shownWeek(from) : weekAt(wanted);
  // Read so the label follows the zone once a host has said it.
  const view = useReview(week);
  const [routine, setRoutine] = useState<Awaited<ReturnType<typeof loadRoutine>>>(kept);
  const [menuOpen, setMenuOpen] = useState(false);
  const open = useRef(false);
  // The routine is asked for with the page and again each time the menu opens: it can be moved, paused or removed
  // at any time. An open menu keeps the rows it opened with: an answer that lands meanwhile is kept for the next
  // open, so nothing grows or goes under the pointer.
  useEffect(() => {
    open.current = menuOpen;
    if (!menuOpen) setRoutine(kept);
    let live = true;
    const ask = ++asks;
    void loadRoutine().then((r) => {
      // Only the newest ask is kept: a slow answer from before must not put back a routine since moved or removed.
      if (ask !== asks) return;
      kept = r;
      if (live && !open.current) setRoutine(r);
    });
    return () => {
      live = false;
    };
  }, [menuOpen]);

  const rows: MenuRow[] = [{ kind: "item", id: "again", label: "Make again" }, ...(routine ? [{ kind: "item" as const, id: "routine", label: `Made ${routine.words}…` }] : [])];
  const pick = (id: string): void => {
    if (id === "again") void makeAgain(week);
    if (id === "routine" && routine) openRoutines(routine.environmentId, routine.workspaceId);
  };
  return (
    <HeadView
      label={weekWords(week, view.tz)}
      thisWeek={wanted === null ? from === null : week.from === thisWeek().from}
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
            <Button variant="ghost" size="icon-sm" aria-label="More" className={cn("text-muted-foreground", NARROW_ICON)}>
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
 * read as one group from the left: "This week" while another week shows, the week, Previous and Next, the menu,
 * every one 28px tall. A window under 520px has no room for all of it beside the page's name and the window's own
 * controls: "This week" goes (Next still walks there), the week is its day alone, and the group closes up (no gaps,
 * icon buttons 24px wide).
 */
export const NARROW_ICON = "max-[520px]:w-6";
export function HeadView({ label, thisWeek, onStep, onThisWeek, menu }: { label: string; thisWeek: boolean; onStep: (by: number) => void; onThisWeek: () => void; menu?: ReactNode }) {
  const named = label.startsWith(WEEK_OF);
  // Back on this week, "This week" is gone and Next is off: the keyboard, if one of them had it, goes to Previous,
  // so stepping through weeks never drops out of the header.
  const group = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLButtonElement>(null);
  const held = useRef(false);
  const hold = (): void => {
    held.current = !!group.current?.contains(document.activeElement);
  };
  useEffect(() => {
    if (!thisWeek || !held.current) return;
    const at = document.activeElement;
    if (!at || at === document.body || group.current?.contains(at)) previous.current?.focus();
    held.current = false;
  }, [thisWeek]);
  return (
    <div ref={group} className="flex items-center gap-1 text-[13px] max-[520px]:gap-0">
      {thisWeek ? null : (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground max-[520px]:hidden"
          onClick={() => {
            hold();
            onThisWeek();
          }}
        >
          This week
        </Button>
      )}
      <span data-review-week className="shrink-0 px-1 text-foreground tabular-nums max-[520px]:px-0.5">
        {named ? <span className="max-[520px]:hidden">{WEEK_OF}</span> : null}
        {named ? label.slice(WEEK_OF.length) : label}
      </span>
      <span className="flex shrink-0 items-center">
        <Tip label="Previous week">
          <Button ref={previous} variant="ghost" size="icon-sm" aria-label="Previous week" className={cn("text-muted-foreground", NARROW_ICON)} onClick={() => onStep(-1)}>
            <ChevronLeft />
          </Button>
        </Tip>
        <Tip label="Next week">
          <Button variant="ghost" size="icon-sm" aria-label="Next week" className={cn("text-muted-foreground", NARROW_ICON)}
            disabled={thisWeek}
            onClick={() => {
              hold();
              onStep(1);
            }}
          >
            <ChevronRight />
          </Button>
        </Tip>
      </span>
      {menu}
    </div>
  );
}
