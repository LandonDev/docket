import type { CanvasItem } from "@shared/work";
import { leaveLive } from "../office/live/leave";
import { flushItem } from "./flush";
import { closeItem } from "./store";

/**
 * The one door a canvas item leaves by, from a Files tab or from the pane beside a chat (docs/agents/work-canvas.md
 * "Closing an item"): what its kind still holds reaches the host first (canvas/flush.ts: a sheet's waiting cells, a
 * deck's open box, a text's waiting words), then a live Office guest unloads, asking if Word is still saving. Answers
 * whether the item may go; false only when he keeps a live file that has not saved.
 */
export async function readyToClose(itemId: string, name: string, leave: typeof leaveLive = leaveLive): Promise<boolean> {
  await flushItem(itemId);
  return leave(itemId, name);
}

/** Closes an item of a thread's pane through the door: the tab goes only once what it holds has been sent. */
export async function closeThroughDoor(environmentId: string, sessionId: string, item: Pick<CanvasItem, "id" | "title">, leave?: typeof leaveLive): Promise<boolean> {
  if (!(await readyToClose(item.id, item.title, leave))) return false;
  await closeItem(environmentId, sessionId, item.id);
  return true;
}
