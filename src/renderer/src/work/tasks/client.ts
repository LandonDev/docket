import { createLifeosViewsClients, type LifeosViewsClientOptions, type SectorKey as KitSector } from "work-kit/lifeos";
import type { SectorKey } from "@shared/work";
import type { TasksDone } from "@shared/contract-work-tasks";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";

/**
 * The shared task and agenda clients (`work-kit/views`), on a workspace's
 * narrowed LifeOS session. Done goes through the host (`work.tasks.done`), so
 * a task a thread here worked completes with the thread's reason and link.
 * Each write says what it did in one toast, with Undo where LifeOS has one.
 */
const write: LifeosViewsClientOptions["write"] = async ({ run, failed, message, undo }) => {
  const toast = await loadToast();
  try {
    const result = await run();
    if (message) toast(message, undo ? { action: { label: "Undo", onClick: () => void undo(result).catch(() => toast.error("Couldn't undo")) } } : undefined);
    return result;
  } catch {
    toast.error(`Couldn't ${failed}`);
    return undefined;
  }
};

export function viewsClients(env: string, sector: SectorKey) {
  return createLifeosViewsClients({
    // A workspace's sector is one of LifeOS's six (the link refuses any other).
    sector: sector as KitSector,
    write,
    complete: (task) => registry.linkOf(env).request<TasksDone>("work.tasks.done", { taskId: task._id }),
  });
}
