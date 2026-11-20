import type { ContextChip } from "@shared/work";
import { workPlayPort, workViewNow } from "../../../lib/workSwitch";
import { workspaceStore } from "../../../lib/tcserver/workspaces";

/**
 * Run a play… on a thing in an open Work view (a task, a mail, an event, a
 * file): the plays of that view's workspace that take it. Null when no view is
 * open or Work's shell is not up, and the menu draws no row.
 */
export function playRunner(): ((chip: ContextChip) => void) | null {
  const port = workPlayPort.get();
  const at = workViewNow();
  const workspace = at ? workspaceStore.workspace(at.workspaceId) : undefined;
  if (!port || !workspace) return null;
  return (chip) => port.run({ environmentId: workspace.environmentId, workspaceId: workspace.id, chip });
}
