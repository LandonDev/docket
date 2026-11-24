// @vitest-environment jsdom
/**
 * The list's rows draw only when what they show changes (Page.tsx `FileRow`): a page listed again with one file
 * changed draws one row, and a press that moves the selection draws the two rows whose selection changed.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@shared/work/files";

// Each draw of a row draws its kind's glyph once: the glyph counts them.
const draws = vi.hoisted(() => new Map<string, number>());
vi.mock("./KindGlyph", async (original) => ({
  ...(await original<typeof import("./KindGlyph")>()),
  KindGlyph: () => {
    draws.set("all", (draws.get("all") ?? 0) + 1);
    return null;
  },
}));

const { FileList } = await import("./Page");
const { NOTHING_PICKED } = await import("./model");

const at = (path: string) => ({ at: "file" as const, host: "box", path });
const entry = (i: number, changed = 1): FileEntry => ({ key: `file:box:/w/${i}`, ref: at(`/w/${i}`), folder: null, name: `File ${i}.docx`, kind: "document", changed });
const drawn = (): number => draws.get("all") ?? 0;

// The list's scroller has a size, as on screen: the virtual list mounts the rows that fit it.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) } as DOMRect);
});
afterEach(() => {
  cleanup();
  draws.clear();
  vi.restoreAllMocks();
});

function List({ entries, picked }: { entries: FileEntry[]; picked: { keys: Set<string>; cursor: string | null; anchor: string | null } }) {
  return <FileList entries={entries} picked={picked} compact={false} busy={null} more={false} loadingMore={false} renaming={null} onPick={() => undefined} onOpen={() => undefined} onMore={() => undefined} onRenamed={() => undefined} />;
}

describe("a row draws again only when it changes", () => {
  it("draws one row for a page of 300 listed again with one file changed, and none for one with nothing changed", () => {
    const rows = Array.from({ length: 300 }, (_, i) => entry(i));
    const view = render(<List entries={rows} picked={NOTHING_PICKED} />);
    // Only the rows on screen are mounted, then drawn once more as the scroller's size lands.
    expect(document.querySelectorAll("[data-files-row]").length).toBeGreaterThan(0);
    expect(document.querySelectorAll("[data-files-row]").length).toBeLessThan(300);
    draws.clear();
    // The store keeps every unchanged row's object (store.ts `steady`): one new object, at the top.
    view.rerender(<List entries={[entry(0, 2), ...rows.slice(1)]} picked={NOTHING_PICKED} />);
    expect(drawn()).toBe(1);
    draws.clear();
    view.rerender(<List entries={[...rows]} picked={NOTHING_PICKED} />);
    // Row 0 is back to its old object: it draws again; nothing else does.
    expect(drawn()).toBe(1);
  });

  it("draws the two rows whose selection changed for a press that moves it", () => {
    const rows = Array.from({ length: 40 }, (_, i) => entry(i));
    const one = { keys: new Set([rows[3]!.key]), cursor: rows[3]!.key, anchor: rows[3]!.key };
    const view = render(<List entries={rows} picked={one} />);
    draws.clear();
    const other = { keys: new Set([rows[7]!.key]), cursor: rows[7]!.key, anchor: rows[7]!.key };
    act(() => view.rerender(<List entries={rows} picked={other} />));
    expect(drawn()).toBe(2);
  });
});
