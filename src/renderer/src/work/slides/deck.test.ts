/**
 * The deck's link to its host: a render read checks every frame against the
 * revision the view advertised, and a press carries the revision of the
 * proposed render it was made on (src/shared/contract-work-slides.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ method: string; params: Record<string, unknown> }>);
const answer = vi.hoisted(() => ({ rev: "p1" }));
vi.mock("../../lib/connection", () => ({
  registry: {
    linkOf: () => ({
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "work.slides.read") return { data: "AAAA", size: 3, rev: answer.rev };
        return { itemId: "d1" };
      },
      onPush: () => () => undefined,
    }),
  },
}));

import { linkDeckHost, RENDER_CHANGED } from "./deck";

beforeEach(() => {
  calls.length = 0;
  answer.rev = "p1";
});

describe("linkDeckHost", () => {
  it("reads a render's bytes at the revision the view advertised, and refuses bytes from another", async () => {
    const host = linkDeckHost("local", "d1");
    expect((await host.read("proposed", 0, 3, "p1")).length).toBe(3);
    answer.rev = "p2";
    await expect(host.read("proposed", 0, 3, "p1")).rejects.toThrow(RENDER_CHANGED);
    // With no revision asked for, any frame reads.
    expect((await host.read("proposed", 0, 3)).length).toBe(3);
  });

  it("sends the revision of the preview a press was made on, and none when it has none", async () => {
    const host = linkDeckHost("local", "d1");
    await host.review(["c1"], "accept", "p1");
    await host.review("all", "reject");
    expect(calls.map((c) => c.params)).toEqual([
      { itemId: "d1", changes: ["c1"], verdict: "accept", rev: "p1" },
      { itemId: "d1", changes: "all", verdict: "reject" },
    ]);
  });
});
