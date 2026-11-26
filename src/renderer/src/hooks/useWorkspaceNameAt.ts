import { useCallback } from "react";
import { useWorkspaces, workspaceNameAt } from "../lib/tcserver/workspaces";
import { useTabGroupLabels } from "./useTabGroupLabels";

/** `workspaceNameAt` over the live catalog and this window's labels: the rail's name for a workspace's
 *  folder, else null. */
export function useWorkspaceNameAt(): (path: string | null | undefined) => string | null {
  const workspaces = useWorkspaces();
  const labels = useTabGroupLabels();
  return useCallback((path) => workspaceNameAt(workspaces, path, labels), [workspaces, labels]);
}
