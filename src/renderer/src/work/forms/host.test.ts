import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as { method: string; params: Record<string, unknown> }[]);
vi.mock("../../lib/connection", () => ({
  registry: {
    linkOf: () => ({
      request: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === "work.forms.publish") return { state: "draft", held: { ref: { at: "host", id: "h7" }, rev: 3 } };
        if (method === "work.outbox.get") return { ref: { at: "host", id: "h7" }, state: "held", updatedAt: 4_200 };
        if (method === "work.outbox.send") return { ref: { at: "host", id: "h7" }, state: "sent", updatedAt: 4_300 };
        if (method === "work.forms.open") return { state: "open", held: null };
        throw new Error(method);
      },
    }),
  },
}));

import { linkFormHost } from "./host";

describe("the form's Publish", () => {
  it("sends the held publish with the revision the host holds it at, so a row that moved since is refused", async () => {
    const host = linkFormHost("box", { id: "f1" } as never);
    expect((await host.publish()).state).toBe("open");
    expect(calls.map((c) => c.method)).toEqual(["work.forms.publish", "work.outbox.get", "work.outbox.send", "work.forms.open"]);
    expect(calls.find((c) => c.method === "work.outbox.send")!.params).toEqual({ ref: { at: "host", id: "h7" }, rev: 4_200 });
  });
});
