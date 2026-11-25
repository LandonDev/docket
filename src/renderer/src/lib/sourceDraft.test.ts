import { describe, expect, it } from "vitest";
import type { ContextChip } from "@shared/work";
import type { DraftRecord } from "./projectDrafts";
import { draftKeyForSource, holdsWords, sourceDraftKey } from "./sourceDraft";

/** A start about a thing never takes another start's unsent words: it opens its own draft, and the old one stays. */

const task = (id: string): ContextChip => ({ kind: "task", label: id, ref: { at: "lifeos", table: "tasks", id } });
const draft = (id: string, text = "", attachments = 0): DraftRecord =>
  ({ id, environmentId: "box", projectId: "p1", workspaceId: "w1", cwd: "/w", harness: "claude", model: "", modelSettings: {}, runtimeMode: "edits", threadType: "chat", threadRules: null, segments: text ? [{ text }] : [], attachments: Array.from({ length: attachments }, (_, i) => ({ id: `a${i}`, name: "x.png" })), seenAt: 1 }) as unknown as DraftRecord;

const pick = (records: Record<string, DraftRecord>, lead: Record<string, ContextChip> = {}, sent: string[] = []) => (about: ContextChip) =>
  draftKeyForSource({ scopeKey: "p:1", about, record: (k) => records[k], sent: (id) => sent.includes(id), leadOf: (id) => lead[id] });

describe("which draft a start about a thing opens", () => {
  it("the scope's own, when it has none, holds no words, or is already about this thing", () => {
    expect(pick({})(task("t1"))).toBe("p:1");
    expect(pick({ "p:1": draft("d1") }, { d1: task("t0") })(task("t1"))).toBe("p:1");
    expect(pick({ "p:1": draft("d1", "Book the hall for") }, { d1: task("t1") })(task("t1"))).toBe("p:1");
    // a draft sent since is no draft
    expect(pick({ "p:1": draft("d1", "words") }, { d1: task("t0") }, ["d1"])(task("t1"))).toBe("p:1");
  });

  it("its own, when the scope's draft holds words about another thing, or words with no thing, or a file", () => {
    expect(pick({ "p:1": draft("d1", "Ask Sam about the hall") }, { d1: task("t0") })(task("t1"))).toBe(sourceDraftKey("p:1", task("t1")));
    expect(pick({ "p:1": draft("d1", "my own words") })(task("t1"))).toBe(sourceDraftKey("p:1", task("t1")));
    expect(pick({ "p:1": draft("d1", "", 1) })(task("t1"))).toBe(sourceDraftKey("p:1", task("t1")));
  });

  it("its own again on a second start about the same thing, while it is unsent", () => {
    const own = sourceDraftKey("p:1", task("t1"));
    expect(pick({ "p:1": draft("d1"), [own]: draft("d2", "half written") })(task("t1"))).toBe(own);
    expect(pick({ "p:1": draft("d1"), [own]: draft("d2") }, {}, ["d2"])(task("t1"))).toBe("p:1");
  });

  it("counts blank text as no words", () => {
    expect(holdsWords(draft("d", "   "))).toBe(false);
    expect(holdsWords(draft("d", "a"))).toBe(true);
  });
});
