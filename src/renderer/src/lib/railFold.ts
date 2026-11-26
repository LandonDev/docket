import { useEffect, useRef } from "react";
import { loadProjectRailWidth } from "./appearance";
import { THREAD_MIN } from "./rightPanel";
import { shell } from "../stores/shell";

/**
 * The least-size rule (docs/LAYOUT.md "Sidebar"): at the window's least width
 * (800) an open rail (200) and the workspace column (260) would leave the
 * thread 340px, under its own floor (`THREAD_MIN`). While that holds, the rail
 * folds to its collapsed state, unsaved, and opens again once the room is back.
 * Nothing else gives way by itself.
 */
export function threadCramped({ window, rail, column }: { window: number; rail: number; column: number }): boolean {
  return window - rail - column < THREAD_MIN;
}

/** What a change of room does: fold as the thread goes under its floor, unfold as it comes back, else nothing.
 *  Only a crossing acts, so a rail he opens or closes while cramped stays as he left it. */
export function foldStep(was: boolean | null, cramped: boolean): "fold" | "unfold" | null {
  if (cramped === was) return null;
  if (cramped) return "fold";
  return was === null ? null : "unfold";
}

/** Runs the rule beside the column: the window's width, the rail's width and the column's, while it shows. */
export function useRailFold(columnWidth: number, columnShown: boolean): void {
  const was = useRef<boolean | null>(null);
  useEffect(() => {
    const check = () => {
      const cramped = threadCramped({ window: window.innerWidth, rail: loadProjectRailWidth(), column: columnShown ? columnWidth : 0 });
      const step = foldStep(was.current, cramped);
      was.current = cramped;
      if (step === "fold") shell.foldRail();
      else if (step === "unfold") shell.unfoldRail();
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [columnWidth, columnShown]);
}
