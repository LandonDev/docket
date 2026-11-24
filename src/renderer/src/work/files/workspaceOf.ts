import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useWorkspaces } from "../../lib/tcserver/workspaces";

/** The Work workspace a document belongs to, as this window knows it; null where it is no Work workspace's. */
export function useWorkspaceOf(env: string, workspaceId: string | null | undefined): WorkspaceMeta | null {
  const all = useWorkspaces();
  return (workspaceId && all.find((w) => w.environmentId === env && w.id === workspaceId && w.kind === "work")) || null;
}
