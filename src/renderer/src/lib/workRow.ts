import { useSyncExternalStore } from "react";
import { sessionStore } from "./tcserver/store";
import { useWorkspaces } from "./tcserver/workspaces";

// Whether a row is Work's, read from the row, never the Work switch: every surface that hides a code part asks here.

type ThreadRow = { scope?: string | null; workspaceId?: string | null } | null | undefined;

export const isWorkThread = (row: ThreadRow): boolean => row?.scope === "work";

export const isWorkWorkspace = (row: { kind?: string | null } | null | undefined): boolean => row?.kind === "work";

/** Stamped Work, or a draft in a Work workspace before the host stamps it. */
export const isWorkSession = (session: ThreadRow, workspaces: readonly { id: string; kind?: string | null }[]): boolean =>
  isWorkThread(session) || (!!session?.workspaceId && isWorkWorkspace(workspaces.find((w) => w.id === session.workspaceId)));

export const useWorkSession = (session: ThreadRow): boolean => isWorkSession(session, useWorkspaces());

/** By id, without asking for the thread's rows. */
export function useWorkSessionId(id: string | null | undefined): boolean {
  const workspaces = useWorkspaces();
  return useSyncExternalStore(sessionStore.subscribe, () => isWorkSession(id ? sessionStore.get(id) : undefined, workspaces));
}
