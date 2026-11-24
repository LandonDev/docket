import { useSyncExternalStore } from "react";
import { sessionStore } from "./tcserver/store";
import { useWorkspaces } from "./tcserver/workspaces";
import { isWorkSession } from "./workRow";

/** `isWorkSession` against the live workspace list: whether a surface hides its code parts for this thread or draft. */
export function useWorkSession(session: Parameters<typeof isWorkSession>[0]): boolean {
  return isWorkSession(session, useWorkspaces());
}

/** The same for a thread known by id (the title bar's active thread), without asking for its rows. */
export function useWorkSessionId(id: string | null | undefined): boolean {
  const workspaces = useWorkspaces();
  return useSyncExternalStore(sessionStore.subscribe, () => isWorkSession(id ? sessionStore.get(id) : undefined, workspaces));
}
