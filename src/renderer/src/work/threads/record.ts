import type { ThreadRecord } from "@shared/work/threadRecord";
import { registry } from "../../lib/connection";

/** What a Work thread left him, as its host keeps it (`work.threads.record`, docs/agents/work.md "What a thread left him"). */
export function readThreadRecord(environmentId: string, sessionId: string): Promise<ThreadRecord> {
  return registry.linkOf(environmentId).request<ThreadRecord>("work.threads.record", { sessionId });
}
