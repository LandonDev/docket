import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBareSeed, onWorkSearch, openWorkSearch, type WorkSearchSeed } from "./workSearchPort";

/** Work search's door: all that first paint holds of it. */
describe("the Work search port", () => {
  it("hands every ask to whoever listens, with its seed, and stops when they stop", () => {
    const heard: WorkSearchSeed[] = [];
    const off = onWorkSearch((seed) => heard.push(seed));
    openWorkSearch();
    openWorkSearch({ text: "budget", workspaceId: "w1", kind: "mail" });
    off();
    openWorkSearch({ text: "after" });
    expect(heard).toEqual([{}, { text: "budget", workspaceId: "w1", kind: "mail" }]);
  });
  it("tells the key itself from a screen's ask", () => {
    expect([isBareSeed({}), isBareSeed({ kind: "mail" }), isBareSeed({ text: "x" }), isBareSeed({ workspaceId: "w" })]).toEqual([true, false, false, false]);
  });
  it("imports nothing and stays small: it is safe in the first paint", () => {
    const source = readFileSync(join(__dirname, "workSearchPort.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\bimport\(/);
    // the door alone: no timer, no store, no rule of the picker's
    expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/\s+/g, " ").length).toBeLessThan(600);
  });
});
