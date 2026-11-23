import type { RoutineJobOpen } from "@shared/contract-work-routines";
import { openWorkPlaceAt } from "../../lib/workPlaceAt";
import { workPlaceRow } from "../../lib/workPlaces";

/**
 * Where a job run's row goes when pressed (docs/agents/work-routines.md "A
 * routine that runs a job"): the pillar that owns the page a job's `open`
 * names may set this, and the Routines view calls it. With none set, a run
 * whose `place` is a page above the workspaces (lib/workPlaces.ts: Review)
 * opens that page at `at`; any other is not a button.
 */
let current: ((open: RoutineJobOpen) => void) | null = null;

export const routineJobOpenPort = {
  /** Sets where a job run opens; returns its off. */
  set(fn: (open: RoutineJobOpen) => void): () => void {
    current = fn;
    return () => {
      if (current === fn) current = null;
    };
  },
  /** Whether anything will open this job run's page: a port a pillar set, or a page above the workspaces of that name. */
  has(open?: RoutineJobOpen): boolean {
    return current !== null || (!!open && workPlaceRow(open.place) !== null);
  },
  open(open: RoutineJobOpen): void {
    if (current) current(open);
    else openWorkPlaceAt(open.place, open.at);
  },
};
