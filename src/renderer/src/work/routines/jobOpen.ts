import type { RoutineJobOpen } from "@shared/contract-work-routines";

/**
 * Where a job run's row goes when pressed (docs/agents/work-routines.md "A
 * routine that runs a job"): the pillar that owns the page a job's `open`
 * names sets this once, and the Routines view calls it. With none set, a job
 * run's row is not a button.
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
  /** Whether anything will open a job run's page. */
  has(): boolean {
    return current !== null;
  },
  open(open: RoutineJobOpen): void {
    current?.(open);
  },
};
