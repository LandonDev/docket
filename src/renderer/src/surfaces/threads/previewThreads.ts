// In-memory thread data for the static board, dialog and agent previews.
import type { MirrorHost } from "@server/shared/launchMirror";
import { sessionStore } from "../../lib/tcserver/store";
import type { SessionMeta } from "../../lib/tcserver/types";
import { answerAs } from "../../work/kit.preview";
import type { Session } from "../../lib/session";

export const previewNow = Date.UTC(2026, 9, 21, 15, 20);
export const previewCwd = "/projects/field-guide";

export function seedPreviewThreads(rows: readonly SessionMeta[], patches: Record<string, Partial<Session>> = {}, answer?: Parameters<typeof answerAs>[0]) {
  const link = answerAs((method, params, host) => {
    if (method === "session.list") return rows.filter((row) => row.environmentId === host);
    if (method === "session.changes") return { upsert: [], removed: [], cursor: "" };
    return answer?.(method, params, host);
  });
  const hosts = new Map<string, MirrorHost>();
  for (const row of rows) {
    let host = hosts.get(row.environmentId);
    if (!host) hosts.set(row.environmentId, host = { environmentId: row.environmentId, sessions: [], writtenAt: previewNow, cursor: null, workspaces: [], projects: [] });
    host.sessions.push({ ...row });
  }
  sessionStore.hydrate([...hosts.values()]);
  sessionStore.attach(link);
  for (const [id, patch] of Object.entries(patches)) sessionStore.patch(id, { loaded: true, ...patch });
  return link;
}
