import { describe, expect, it, vi } from "vitest";
import { openingTag } from "@shared/work/files";
import { openEntry, openingWords } from "./open";
import type { PlaceCopy } from "./model";

const world = vi.hoisted(() => ({ request: vi.fn(), message: vi.fn() }));
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<typeof import("../../lib/connection")>()),
  registry: { has: () => false, linkOf: () => ({ request: world.request }), onLink: () => () => undefined },
}));
vi.mock("../../components/ui/toaster", async (original) => ({
  ...(await original<typeof import("../../components/ui/toaster")>()),
  loadToast: async () => ({ message: world.message }),
}));

/** A row opening another computer's file says how far its copy has got (open.ts `openingWords`), heard by its key's tag. */
describe("a row opening another computer's file", () => {
  it.each([true, false])("tells where to play a far recording when copies are %s", async (copies) => {
    const root = { at: "file", host: "desk", path: "/library" } as const;
    const copy: PlaceCopy = {
      place: { id: "lib", kind: "teams", name: "General", host: "Desk PC", env: "desk", root, state: { state: "ok" }, shared: true, can: [] },
      link: "desk",
      host: "Desk PC",
      wire: "files",
    };
    const entry = { key: "k", ref: { ...root, path: "/library/Recording.wav" }, folder: null, name: "Recording.wav", kind: "audio" } as const;
    world.message.mockClear();
    await expect(openEntry(entry, copy, { workspace: { id: "w", environmentId: "box", path: "/w" }, tabs: true, copy: copies, busy: vi.fn(), allowed: vi.fn() })).resolves.toBeNull();
    expect(world.message.mock.calls).toEqual([["Play Recording.wav on Desk PC."]]);
    expect(world.request).not.toHaveBeenCalled();
  });
  it("says how far its copy has got", () => {
    expect(openingWords(512 * 1024, 5 * 1024 * 1024)).toBe("Opening… 0.5 of 5.0 MB");
    expect(openingWords(8 * 1024 * 1024, 20 * 1024 * 1024)).toBe("Opening… 8.0 of 20 MB");
  });

  it("hears its own push by a tag of its key, which names no path", () => {
    const key = "file:env_pc:J:\\Bench\\Deck.pptx";
    expect(openingTag(key)).toBe(openingTag(key));
    expect(openingTag(key)).not.toBe(openingTag("file:env_pc:J:\\Bench\\Big.docx"));
    expect(openingTag(key)).not.toContain("Bench");
  });
});
