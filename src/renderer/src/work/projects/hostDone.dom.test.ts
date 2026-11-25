// @vitest-environment jsdom
/** Done in Projects goes through the host (`work.tasks.done`), as Tasks and Today do, so a thread's work is credited. */
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as { method: string; params: unknown }[]);
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<typeof import("../../lib/connection")>()),
  registry: { linkOf: () => ({ request: async (method: string, params: unknown) => (calls.push({ method, params }), { threadId: null, nextId: null }) }), onLink: () => () => undefined },
}));

import { withHostDone } from "./kit";

describe("withHostDone", () => {
  it("completes the task and each sub-task closing with it through work.tasks.done, and never through LifeOS directly", async () => {
    const direct = vi.fn(async () => {});
    const client = withHostDone({ completeTask: direct, dropTask: vi.fn() }, "box", "ws1");
    await client.completeTask("t1", { children: ["t2"] });
    expect(direct).not.toHaveBeenCalled();
    expect(calls).toEqual([
      { method: "work.tasks.done", params: { workspaceId: "ws1", taskId: "t1" } },
      { method: "work.tasks.done", params: { workspaceId: "ws1", taskId: "t2" } },
    ]);
    // The rest of the client is the kit's own.
    expect(client.dropTask).toBeTypeOf("function");
  });
});
