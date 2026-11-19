import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextChip } from "@shared/work";

/**
 * A draft's first send says what the thread is about: its first chip rides
 * `session.create` as `about` (lib/contextChips.ts), once, and a create with
 * no chip says nothing.
 */
const wire = vi.hoisted(() => ({ fail: false, requests: [] as { method: string; params: Record<string, unknown> }[] }));
vi.mock("../connection", () => ({
  registry: {
    linkOf: () => ({
      environmentId: "local",
      request: async (method: string, params: Record<string, unknown>) => {
        wire.requests.push({ method, params });
        if (wire.fail) throw new Error("host unreachable");
        return { id: params.id, provider: "claude", model: "m", status: "idle" };
      },
    }),
    primary: () => ({ environmentId: "local" }),
    onLink: () => () => undefined,
  },
}));
// The threads the store knows: a create that succeeds adopts its thread.
const known = vi.hoisted(() => new Set<string>());
vi.mock("./store", () => ({
  sessionStore: { metaOf: (id: string) => (known.has(id) ? { id } : undefined), isProvisional: () => false, linkFor: () => undefined, adopt: (meta: { id: string }) => void known.add(meta.id) },
}));
vi.mock("../macBridge", () => ({ bridgeNewThread: async () => undefined, bridgesNewThreads: () => false }));

import { addContextChip, resetContextChips, takeContextChips } from "../../work/canvas/chips";
import { newSession } from "../session";
import { ensureCreated } from "./commands";

const task: ContextChip = { kind: "task", label: "Book the ballroom for April 10", ref: { at: "lifeos", table: "tasks", id: "k1" } };
const draft = (id: string) => ({ ...newSession("local", "claude", "~", "claude:opus-5.5"), id });

beforeEach(() => {
  wire.requests.length = 0;
  wire.fail = false;
  known.clear();
  resetContextChips();
});

describe("session.create from a draft", () => {
  it("carries the chip the draft's first send held as `about`", async () => {
    addContextChip("d1", task);
    // The composer's send takes the chips; the create follows it.
    takeContextChips("d1", true);
    await ensureCreated(draft("d1"));
    const create = wire.requests.find((r) => r.method === "session.create");
    expect(create?.params.about).toEqual(task);
  });

  it("says it again when the first create failed", async () => {
    addContextChip("d3", task);
    takeContextChips("d3", true);
    wire.fail = true;
    await expect(ensureCreated(draft("d3"))).rejects.toThrow("host unreachable");
    wire.fail = false;
    await ensureCreated(draft("d3"));
    expect(wire.requests.filter((r) => r.method === "session.create").map((r) => r.params.about)).toEqual([task, task]);
  });

  it("says nothing of a draft sent with no chip", async () => {
    await ensureCreated(draft("d2"));
    const create = wire.requests.find((r) => r.method === "session.create");
    expect(create).toBeDefined();
    expect("about" in create!.params).toBe(false);
  });
});
