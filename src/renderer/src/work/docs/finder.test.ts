import { describe, expect, it } from "vitest";
import { DEFAULT_SPEC, type FindEntry } from "@shared/work/docFind";
import { chipOf, opensHere, pick, sameSpec } from "./finder";

const e = (o: Partial<FindEntry>): FindEntry => ({ key: "k", title: "T", kind: "document", where: "lifeos", source: { at: "lifeos", table: "docs", id: "d" }, editedAt: 0, createdAt: 0, shared: false, guest: false, comments: 0, waiting: 0, held: 0, ...o });

describe("the Docs view's rules", () => {
  it("open a LifeOS document, a .tcdoc and a Google Doc here, and nothing else", () => {
    expect(opensHere(e({}))).toBe(true);
    expect(opensHere(e({ source: { at: "file", host: "h", path: "/a/B.TCDOC" } }))).toBe(true);
    expect(opensHere(e({ source: { at: "google", account: "a", fileId: "g", mime: "application/vnd.google-apps.document" } }))).toBe(true);
    expect(opensHere(e({ source: { at: "file", host: "h", path: "/a/b.docx" } }))).toBe(false);
    expect(opensHere(e({ kind: "sheet", source: { at: "lifeos", table: "sheets", id: "s" } }))).toBe(false);
  });

  it("make a chip of anything but a thread's own item", () => {
    expect(chipOf(e({ title: "Brief" }))).toEqual({ kind: "selection", label: "Brief", ref: { at: "lifeos", table: "docs", id: "d" } });
    expect(chipOf(e({ source: { at: "thread" } }))).toBeNull();
  });

  it("pick a row alone, or a range from the anchor in its state", () => {
    const order = ["a", "b", "c", "d"];
    let s = pick(order, { selected: new Set(), anchor: null }, "b", false);
    expect([...s.selected]).toEqual(["b"]);
    s = pick(order, s, "d", true);
    expect([...s.selected].sort()).toEqual(["b", "c", "d"]);
    s = pick(order, s, "b", false);
    s = pick(order, s, "c", true);
    expect([...s.selected]).toEqual(["d"]);
  });

  it("count a spec as the same when only empty filters or spaces differ", () => {
    expect(sameSpec(DEFAULT_SPEC, { ...DEFAULT_SPEC, query: "  ", filter: { kinds: [], shared: false } })).toBe(true);
    expect(sameSpec(DEFAULT_SPEC, { ...DEFAULT_SPEC, filter: { held: true } })).toBe(false);
  });
});
