/**
 * A check a view makes only when it has heard nothing for a while (perf M10): `run` goes `every` ms after the last word
 * the window heard about the thing (`heard`: a push, an answer), never while the window is hidden, and once as it shows
 * again when one came due meanwhile. So a view kept current by its pushes asks nothing, and a hidden one asks nothing.
 */
export interface QuietPoll {
  /** Something current was heard: the next check waits `every` ms from now. */
  heard(): void;
  stop(): void;
}

export function quietPoll(run: () => void, every: number, doc: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> | undefined = globalThis.document): QuietPoll {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let owed = false;
  let stopped = false;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = stopped ? null : setTimeout(due, every);
  };
  const due = (): void => {
    timer = null;
    if (doc?.hidden) {
      owed = true;
      return;
    }
    run();
    arm();
  };
  const shown = (): void => {
    if (doc?.hidden || !owed || stopped) return;
    owed = false;
    run();
    arm();
  };
  doc?.addEventListener("visibilitychange", shown);
  arm();
  return {
    heard() {
      owed = false;
      arm();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      doc?.removeEventListener("visibilitychange", shown);
    },
  };
}
