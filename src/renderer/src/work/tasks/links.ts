import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";

/**
 * Which thread works on a task: LifeOS's `workLinks:byEntity`, the read the
 * host's Done makes (docs/agents/work-tasks.md), asked live on the view's own
 * narrowed session. The newest open link wins. A read that fails reads as no
 * thread: the row keeps Start, never an error of its own.
 */

type Link = { threadId: string; state: "open" | "done"; at: number };

const byEntity = makeFunctionReference<"query">("workLinks:byEntity");

/** The newest open link's thread, or null. */
export function newestOpenThread(links: readonly Link[] | null | undefined): string | null {
  const open = (links ?? []).filter((l) => l.state === "open");
  return open.length ? open.reduce((a, b) => (b.at >= a.at ? b : a)).threadId : null;
}

/** The thread a task's link names, live; null while it loads, when none is open, or when the read fails. */
export function useLinkedThread(taskId: string): string | null {
  const convex = useConvex();
  const [thread, setThread] = useState<string | null>(null);
  useEffect(() => {
    const watch = convex.watchQuery(byEntity, { entity: { table: "tasks", id: taskId } });
    const read = (): void => {
      try {
        setThread(newestOpenThread(watch.localQueryResult() as Link[] | undefined));
      } catch {
        setThread(null);
      }
    };
    read();
    return watch.onUpdate(read);
  }, [convex, taskId]);
  return thread;
}
