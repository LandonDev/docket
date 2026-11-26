import type { ThreadRecord } from "@shared/work/threadRecord";
import { registry } from "../../lib/connection";

/**
 * What a Work thread left him, as its host keeps it (`work.threads.record`, docs/agents/work.md "What a thread left him").
 * `fresh`: the asker saw LifeOS move (a linked task changed), so the host reads the thread's LifeOS half again rather
 * than answer the one it keeps; an older host reads it at every ask anyway.
 */
export function readThreadRecord(environmentId: string, sessionId: string, fresh = false): Promise<ThreadRecord> {
  return registry.linkOf(environmentId).request<ThreadRecord>("work.threads.record", { sessionId, ...(fresh ? { fresh: true } : {}) });
}
