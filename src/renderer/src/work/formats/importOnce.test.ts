// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const answer = vi.hoisted(() => ({ next: null as unknown }));
vi.mock("../../lib/connection", () => ({ registry: { linkOf: () => ({ request: async () => answer.next }) } }));

import { importLosses, importOnce, resetImports } from "./importOnce";

const DOC = { at: "file", host: "env_box", path: "/data/word/Plan.tcdoc" } as const;
afterEach(() => {
  resetImports();
  localStorage.clear();
});

describe("what an import did not keep", () => {
  it("is kept by the document it made, across a reload of the window; a document never imported here is not known", async () => {
    expect(importLosses(DOC)).toBeNull();
    answer.next = { source: DOC, title: "Plan", warnings: ["1 table inside a table kept as text"], outsiders: false };
    await importOnce("env_box", "k1", {});
    expect(importLosses(DOC)).toEqual(["1 table inside a table kept as text"]);
    // A file that lost nothing is known as such: the question then names nothing.
    answer.next = { source: DOC, title: "Plan", warnings: [], outsiders: false };
    await importOnce("env_box", "k2", {});
    expect(importLosses(DOC)).toEqual([]);
    expect(JSON.parse(localStorage.getItem("tc.work.importLosses")!)).toHaveLength(1);
  });
});
