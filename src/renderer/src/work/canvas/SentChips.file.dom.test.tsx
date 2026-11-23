// @vitest-environment jsdom
/** A sent file chip opens its file in a Files tab of the thread's workspace (SentChips.tsx `openerOf`). */
import { describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => [] as unknown[]);
vi.mock("../files/openFrom", () => ({ openInFiles: async (workspace: unknown, file: unknown) => void opened.push({ workspace, file }) }));

const { openerOf } = await import("./SentChips");
const { chipLine } = await import("./chips");
const { sentChipsOf } = await import("./sentChipsOf");

describe("a sent file chip", () => {
  const source = { at: "file" as const, host: "env_box", path: "/w/Plan (v2).docx" };
  const [chip] = sentChipsOf(chipLine({ kind: "file", label: "Plan (v2).docx", ref: source })).chips;
  const at = { environmentId: "box", sessionId: "t1", workspaceId: "w1" };

  it("opens the file it names in a Files tab of the thread's workspace", async () => {
    await openerOf(chip!, at)!();
    expect(opened).toEqual([{ workspace: { id: "w1", environmentId: "box" }, file: { ref: source, name: "Plan (v2).docx" } }]);
  });

  it("is a label where the thread has no workspace or the reference is no source", () => {
    expect(openerOf(chip!, { ...at, workspaceId: null })).toBeNull();
    expect(openerOf({ noun: "file", label: "x", ref: '{"at":"nowhere"}' }, at)).toBeNull();
    expect(openerOf({ noun: "file", label: "x", ref: "/w/x" }, at)).toBeNull();
  });
});
