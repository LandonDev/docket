import { afterEach, describe, expect, it } from "vitest";
import type { FindEntry } from "@shared/work/docFind";
import { LIST_PLACE } from "work-kit/projects";
import { linkable } from "./LinkPicker";
import { parsePlace, placeOf, resetPlaces, setPlace } from "./place";

/** The Projects view's own rules with no screen: where it stands, and what a link picker offers. */

const store = new Map<string, string>();
(globalThis as { localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).localStorage ??= {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => void store.set(key, value),
  removeItem: (key) => void store.delete(key),
};
afterEach(resetPlaces);

describe("where a workspace's project screens stand", () => {
  it("is the list until he goes somewhere, and is kept a workspace", () => {
    expect(placeOf("ws")).toEqual(LIST_PLACE);
    setPlace("ws", { at: "project", id: "p1", layout: "board", tab: "doing" });
    expect(placeOf("ws")).toEqual({ at: "project", id: "p1", layout: "board", tab: "doing" });
    expect(placeOf("other")).toEqual(LIST_PLACE);
  });

  it("comes back from storage as he left it, a workspace at a time", () => {
    setPlace("ws", { at: "project", id: "p1", layout: "list", tab: "all", peek: "t1" });
    setPlace("life", { at: "list", layout: "board", tab: "all" });
    const kept = JSON.parse(globalThis.localStorage!.getItem("work.projects.place.v1")!) as Record<string, unknown>;
    expect(parsePlace(kept.ws)).toEqual({ at: "project", id: "p1", layout: "list", tab: "all", peek: "t1" });
    expect(parsePlace(kept.life)).toEqual({ at: "list", layout: "board", tab: "all" });
  });

  it("reads anything that is not a place as the list, and a half-typed new project as the list in the layout he had", () => {
    expect(parsePlace(null)).toEqual(LIST_PLACE);
    expect(parsePlace("project")).toEqual(LIST_PLACE);
    expect(parsePlace({ at: "elsewhere", layout: "list", tab: "all" })).toEqual(LIST_PLACE);
    expect(parsePlace({ at: "project", layout: "list", tab: "all" })).toEqual(LIST_PLACE);
    expect(parsePlace({ at: "list", layout: "grid", tab: "all" })).toEqual(LIST_PLACE);
    expect(parsePlace({ at: "new", layout: "board", tab: "all", state: "paused" })).toEqual({ at: "list", layout: "board", tab: "all", display: undefined });
  });
});

describe("what a link picker offers a project", () => {
  const entry = (key: string, source: FindEntry["source"], extra: Partial<FindEntry> = {}): FindEntry => ({ key, title: key, kind: "document", where: "lifeos", source, editedAt: 1, createdAt: 1, shared: false, guest: false, comments: 0, ...extra }) as FindEntry;
  const entries = [
    entry("doc-free", { at: "lifeos", table: "docs", id: "d1" }),
    entry("doc-mine", { at: "lifeos", table: "docs", id: "d2" }, { projectId: "p1" }),
    entry("doc-other", { at: "lifeos", table: "docs", id: "d3" }, { projectId: "p2" }),
    entry("sheet", { at: "lifeos", table: "sheets", id: "s1" }, { kind: "sheet" }),
    entry("draft", { at: "lifeos", table: "outbox", id: "o1" }),
    entry("file", { at: "file", host: "env_box", path: "/w/budget.xlsx" }, { kind: "sheet", where: "folder" }),
    entry("gdoc", { at: "google", account: "l@purdue.edu", fileId: "g1", mime: "application/vnd.google-apps.document" }, { where: "google" }),
    entry("thread-made", { at: "thread" }, { where: "thread" }),
    entry("window", { at: "browser", host: "env_box", sessionId: "b1" }, { where: "thread" }),
  ];

  it("a document: LifeOS's documents and sheets the project does not hold, another project's among them", () => {
    expect(linkable(entries, "document", "p1").map((e) => e.key)).toEqual(["doc-free", "doc-other", "sheet"]);
  });

  it("a file or item: everything else a project can list, never what only a thread can name", () => {
    expect(linkable(entries, "item", "p1").map((e) => e.key)).toEqual(["file", "gdoc"]);
  });
});
