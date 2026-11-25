import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";

/**
 * Which thread works on a task: LifeOS's `workLinks:byEntity`, the read the
 * host's Done makes (docs/agents/work-tasks.md), asked live on the view's own
 * narrowed session. Tasks shows the newest open link; a project's plan shows
 * every open one. A read that fails reads as no
 * thread: the row keeps Start, never an error of its own.
 */

type Link = { threadId: string; state: "open" | "done"; at: number };

const byEntity = makeFunctionReference<"query">("workLinks:byEntity");

/** The newest open link's thread, or null. */
export function newestOpenThread(links: readonly Link[] | null | undefined): string | null {
  const open = (links ?? []).filter((l) => l.state === "open");
  return open.length ? open.reduce((a, b) => (b.at >= a.at ? b : a)).threadId : null;
}

/** Every open link's thread, newest first, each once. */
export function openThreads(links: readonly Link[] | null | undefined): string[] {
  const open = (links ?? []).filter((l) => l.state === "open").sort((a, b) => b.at - a.at);
  return [...new Set(open.map((l) => l.threadId))];
}

/** A task's links, live, as `pick` reads them; `pick(undefined)` while it loads or when the read fails. */
function useLinks<T>(taskId: string, pick: (links: readonly Link[] | undefined) => T, same: (a: T, b: T) => boolean): T {
  const convex = useConvex();
  const [value, setValue] = useState<T>(() => pick(undefined));
  useEffect(() => {
    const watch = convex.watchQuery(byEntity, { entity: { table: "tasks", id: taskId } });
    const read = (): void => {
      let next: T;
      try {
        next = pick(watch.localQueryResult() as Link[] | undefined);
      } catch {
        next = pick(undefined);
      }
      setValue((was) => (same(was, next) ? was : next));
    };
    read();
    return watch.onUpdate(read);
    // `pick` and `same` are module functions.
  }, [convex, taskId]);
  return value;
}

/** The thread a task's link names, live; null while it loads, when none is open, or when the read fails. */
export function useLinkedThread(taskId: string): string | null {
  return useLinks(taskId, newestOpenThread, Object.is);
}

const NO_THREADS: string[] = [];
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);
const openOrNone = (links: readonly Link[] | undefined): string[] => (links ? openThreads(links) : NO_THREADS);

/** Every thread a task's open links name, newest first, live (docs/agents/work-tracker.md "The slots": `taskMark`); empty while it loads or when the read fails. */
export function useLinkedThreads(taskId: string): readonly string[] {
  return useLinks(taskId, openOrNone, sameList);
}
