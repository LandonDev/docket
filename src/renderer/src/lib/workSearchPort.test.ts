import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBareSeed, onWorkSearch, openWorkSearch, searchWork, type WorkSearchSeed } from "./workSearchPort";

/** Work search's door: what first paint holds of it. */
describe("the Work search port", () => {
  it("hands every ask to whoever listens, with its seed, and stops when they stop", () => {
    const heard: WorkSearchSeed[] = [];
    const off = onWorkSearch((seed) => heard.push(seed));
    openWorkSearch({}, 1000);
    openWorkSearch({ text: "budget", workspaceId: "w1", kind: "mail" });
    off();
    openWorkSearch({ text: "after" });
    expect(heard).toEqual([{}, { text: "budget", workspaceId: "w1", kind: "mail" }]);
  });
  it("hears one press of the key once, though it arrives by the window and by the menu; a later press is a new one", () => {
    const heard: WorkSearchSeed[] = [];
    const off = onWorkSearch((seed) => heard.push(seed));
    openWorkSearch({}, 5000);
    openWorkSearch({}, 5040);
    expect(heard).toHaveLength(1);
    openWorkSearch({}, 5200);
    expect(heard).toHaveLength(2);
    // an ask with a seed is a screen's, never a repeat of the key
    openWorkSearch({ text: "x" }, 5201);
    openWorkSearch({ text: "x" }, 5202);
    expect(heard).toHaveLength(4);
    expect([isBareSeed({}), isBareSeed({ kind: "mail" })]).toEqual([true, false]);
    off();
  });
  it("the command does nothing while no host has Work on", () => {
    const heard: WorkSearchSeed[] = [];
    const off = onWorkSearch((seed) => heard.push(seed));
    expect(searchWork(false, 9000)).toBe(false);
    expect(heard).toEqual([]);
    expect(searchWork(true, 9000)).toBe(true);
    expect(heard).toEqual([{}]);
    off();
  });
  it("imports nothing: it is safe in the first paint", () => {
    const source = readFileSync(join(__dirname, "workSearchPort.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\bimport\(/);
  });
});
