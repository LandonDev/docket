import type { ContextChip } from "@shared/work";
import { workspaceStore } from "../../../lib/tcserver/workspaces";
import { sessionStore } from "../../../lib/tcserver/store";
import { PlayDialog } from "./PlayDialog";
import { RunDialog } from "./RunDialog";

/**
 * The plays' dialogs as the shell's host opens them (PlaysHost.tsx): Run a
 * play… from a thing in a view, Save as a play… from a thread's menu. Their
 * own chunk, so nothing of them loads until he asks.
 */

export function RunAsk({ environmentId, workspaceId, chip, onClose }: { environmentId: string; workspaceId: string; chip: ContextChip; onClose: () => void }) {
  return <RunDialog env={environmentId} workspaceId={workspaceId} chip={chip} onClose={onClose} />;
}

export function SaveAsk({ environmentId, sessionId, onClose }: { environmentId: string; sessionId: string; onClose: () => void }) {
  const thread = sessionStore.get(sessionId) ?? sessionStore.metaOf(sessionId);
  const workspaceId = thread?.workspaceId;
  if (!workspaceId) return null;
  // Drafting sends the thread to a model of its own: never a Purdue thread (the host refuses it too).
  const mayDraft = workspaceStore.workspace(workspaceId)?.sector !== "purdue";
  return <PlayDialog env={environmentId} workspaceId={workspaceId} source={{ kind: "thread", sessionId, mayDraft }} onClose={onClose} />;
}
