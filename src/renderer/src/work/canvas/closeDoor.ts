import type { CanvasItem } from "@shared/work";
import { confirmAction } from "../../chrome/ConfirmDialog";
import { leaveLive } from "../office/live/leave";
import { canvasFlushPort } from "../../lib/canvasFlushPort";
import { flushItem, type Sent } from "./flush";
import { closeItem } from "./store";

/**
 * His word on closing an item whose last send did not land: true closes it, and what it held may be lost. Asked as a
 * live file still saving is (office/live/leave.ts). `kept`: its kind keeps it on this computer as a draft, offered when
 * the file opens again, so nothing is said to be lost.
 */
export function askCloseUnsent(name: string, sent: Exclude<Sent, "sent">, kept = false): Promise<boolean> {
  return confirmAction(
    kept
      ? { title: `Changes to ${name} are not saved.`, body: "Close it anyway? They are kept on this computer and offered when you open it again.", action: "Close Anyway" }
      : sent === "late"
      ? { title: `${name} is still saving`, body: "Close it anyway? What it has not saved may be lost.", action: "Close Anyway", danger: true }
      : { title: `Changes to ${name} are not saved.`, body: "Close it anyway? They will be lost.", action: "Close Anyway", danger: true },
  );
}

/**
 * The one door a canvas item leaves by, from a Files tab or from the pane beside a chat (docs/agents/work-canvas.md
 * "Closing an item"): what its kind still holds reaches the host first (canvas/flush.ts: a sheet's waiting cells, a
 * deck's open box, a text's waiting words), then a live Office guest unloads, asking if Word is still saving. A send
 * that failed or ran past its wait asks him first; a kind's refusal (`CloseRefused`) is thrown on. Answers whether
 * the item may go; false when he keeps it.
 */
export async function readyToClose(itemId: string, name: string, leave: typeof leaveLive = leaveLive, ask: typeof askCloseUnsent = askCloseUnsent): Promise<boolean> {
  const kept = canvasFlushPort.keeps(itemId);
  const sent = await flushItem(itemId);
  if (sent !== "sent" && !(await ask(name, sent, kept))) return false;
  return leave(itemId, name);
}

/** Closes an item of a thread's pane through the door: the tab goes only once what it holds has been sent, or he said close. */
export async function closeThroughDoor(environmentId: string, sessionId: string, item: Pick<CanvasItem, "id" | "title">, leave?: typeof leaveLive, ask?: typeof askCloseUnsent): Promise<boolean> {
  if (!(await readyToClose(item.id, item.title, leave, ask))) return false;
  await closeItem(environmentId, sessionId, item.id);
  return true;
}
