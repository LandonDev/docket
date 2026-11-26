/**
 * Ranking without waste (fuzzy.ts, fileIndex.ts, composerTriggers.ts): a
 * list's paths are lower-cased once, the query is split once a key, and a
 * key visits each path once. Counted, never timed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "./fs";
import { rankFiles } from "./composerTriggers";
import { rankProjectFiles } from "./fileIndex";
import { fuzzyMatch, scorePath } from "./fuzzy";

vi.mock("./tcserver/projects", () => ({ hostOfCwd: () => "local" }));

const SIZE = 20_000;
const made: ProjectFile[] = Array.from({ length: SIZE }, (_, i) => {
  const name = `File${i}.ts`;
  const relative = `src/dir${i % 50}/${name}`;
  return { name, path: `/repo/${relative}`, relative };
});

/** The list behind a proxy that counts each row read by index. */
function counted(files: ProjectFile[]): { list: ProjectFile[]; visits: () => number; reset: () => void } {
  let visits = 0;
  const list = new Proxy(files, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) visits++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { list, visits: () => visits, reset: () => (visits = 0) };
}

afterEach(() => vi.restoreAllMocks());

describe("ranking 20,000 paths", () => {
  it("Go to File's rank visits each path once a key and lower-cases nothing a row", () => {
    const { list, visits, reset } = counted(made);
    rankProjectFiles(list, "f", []);
    for (const query of ["fi", "fil", "file 12"]) {
      reset();
      const lower = vi.spyOn(String.prototype, "toLowerCase");
      const hits = rankProjectFiles(list, query, []);
      expect(visits()).toBe(SIZE);
      // The query once; no row's path or name.
      expect(lower.mock.calls.length).toBeLessThanOrEqual(1);
      lower.mockRestore();
      expect(hits.length).toBeGreaterThan(0);
    }
  });

  it("@'s rank lower-cases each path once a list, not once a key", () => {
    const { list } = counted(made);
    rankFiles(list, "x");
    const lower = vi.spyOn(String.prototype, "toLowerCase");
    rankFiles(list, "file1");
    expect(lower.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("ranks as before: the name's hit first, the query split on spaces", () => {
    expect(scorePath("app", "src/App.tsx", "App.tsx")?.positions).toEqual([4, 5, 6]);
    expect(fuzzyMatch("sr ap", "src/App.tsx")?.positions).toEqual([0, 1, 4, 5]);
    const ranked = rankProjectFiles(made.slice(0, 300), "file12", []).map((f) => f.name);
    expect(ranked[0]).toBe("File12.ts");
  });
});
