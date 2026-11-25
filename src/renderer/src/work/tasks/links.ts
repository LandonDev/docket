import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { loadToast } from "../../components/ui/toaster";
import { sessionStore } from "../../lib/tcserver/store";
import { workOpenPort } from "../../lib/workSwitch";

/**
 * Which thread works on a task: LifeOS's `workLinks:byEntity`, the read the
 * host's Done makes (docs/agents/work-tasks.md), asked live on the view's own
 * narrowed session. Tasks shows the newest open link; a project's plan shows
 * every open one. Tasks keeps a read that has not answered (still out, or
 * failed) apart from no thread: the row offers neither Start nor Open thread
 * until it is known which is right, so an early Start never makes a second
 * thread. A row and the lead on one task share one subscription: Convex
 * holds one watch a query and its arguments. A link can name a thread the
 * window holds no meta for yet (an unloaded host's, an archived one): the
 * row offers Open thread all the same, and Open asks the hosts for it first
 * (`openTaskThread`), so a known thread never sprouts a second.
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

/** The newest open link's thread, null for none, undefined while the read is out or failed. */
const newestOrUnknown = (links: readonly Link[] | undefined): string | null | undefined => (links ? newestOpenThread(links) : undefined);

/** The thread a task's link names, live: null when none is open; undefined while the read is out or when it fails. */
export function useLinkedThread(taskId: string): string | null | undefined {
  return useLinks(taskId, newestOrUnknown, Object.is);
}

const NO_THREADS: string[] = [];
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);
const openOrNone = (links: readonly Link[] | undefined): string[] => (links ? openThreads(links) : NO_THREADS);

/** Every thread a task's open links name, newest first, live (docs/agents/work-tracker.md "The slots": `taskMark`); empty while it loads or when the read fails. */
export function useLinkedThreads(taskId: string): readonly string[] {
  return useLinks(taskId, openOrNone, sameList);
}

/** Open the thread a task's link names; one this window holds no meta for is asked of the hosts first (`ensureMeta`). */
export async function openTaskThread(id: string): Promise<void> {
  if (!sessionStore.metaOf(id) && !(await sessionStore.ensureMeta(id))) {
    void loadToast().then((toast) => toast.error("Couldn't find the thread"));
    return;
  }
  workOpenPort.get()?.(id);
}
