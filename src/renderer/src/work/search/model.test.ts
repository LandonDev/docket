import { describe, expect, it } from "vitest";
import type { SearchAnswer, SearchGroup, SearchHit } from "@shared/work/search";
import { activeOf, asksNetwork, begin, busy, emptyModel, failed, isOption, landInstant, landSource, paramsFor, point, quietLine, rowsOf, step, type Row, type SearchHost, type SearchModel } from "./model";

/** The picker's list as data: one test a rule. */

const box: SearchHost = { id: "box", name: "The box", home: true };
const mac: SearchHost = { id: "mac", name: "MacBook", home: false };
const hit = (key: string, over: Partial<SearchHit> = {}): SearchHit => ({ key, kind: "mail", title: `budget ${key}`, workspaceId: "w1", open: { to: "view", view: "mail" }, ...over });
const group = (kind: string, keys: string[], over: Partial<SearchGroup> = {}): SearchGroup => ({ source: `search.${kind}`, kind, label: kind[0].toUpperCase() + kind.slice(1), hits: keys.map((k) => hit(k, { kind })), more: false, ...over });
const answer = (groups: SearchGroup[], pending: string[] = [], quiet: SearchAnswer["quiet"] = []): SearchAnswer => ({ groups, pending: pending.map((source) => ({ source, kind: source.split(".")[1] })), quiet });
const typed = (text: string, hosts: SearchHost[] = [box], from: SearchModel = emptyModel(), kind: string | null = null): SearchModel => begin(from, { text, kind, hosts });
const shape = (rows: Row[]): string[] => rows.map((row) => (row.type === "heading" ? `# ${row.label}` : row.type === "hit" ? row.hit.key : row.type === "note" ? `(${row.text})` : `[${row.label}]`));

describe("generations", () => {
  it("a keystroke is a new generation, and an answer of an older one is dropped", () => {
    const first = typed("bud");
    const second = typed("budg", [box], first);
    expect(second.gen).toBe(first.gen + 1);
    const late = landInstant(second, first.gen, "box", answer([group("thread", ["t1"])]));
    expect(late.model).toBe(second);
    expect(late.ask).toEqual([]);
    expect(landSource(second, first.gen, "box", "search.mail", answer([group("mail", ["m1"])]))).toBe(second);
    expect(failed(second, first.gen, "box", null)).toBe(second);
  });
  it("everything asked is out until it answers: the spinner's whole rule", () => {
    let m = typed("budget", [box, mac]);
    expect(busy(m)).toBe(true);
    const a = landInstant(m, m.gen, "box", answer([], ["search.mail"]));
    m = landInstant(a.model, m.gen, "mac", answer([])).model;
    expect(busy(m)).toBe(true);
    m = landSource(m, m.gen, "box", "search.mail", answer([]));
    expect(busy(m)).toBe(false);
  });
});

describe("the two tiers", () => {
  it("asks the network sources a host named, from two characters and no fewer", () => {
    expect([asksNetwork("b"), asksNetwork(" b "), asksNetwork("bu")]).toEqual([false, false, true]);
    const one = typed("b");
    expect(landInstant(one, one.gen, "box", answer([], ["search.mail", "search.task"])).ask).toEqual([]);
    const two = typed("bu");
    expect(landInstant(two, two.gen, "box", answer([], ["search.mail", "search.task"])).ask).toEqual(["search.mail", "search.task"]);
  });
  it("asks a host first for what it knows at once, then for one source, by the ids it named", () => {
    const m = typed("budget", [box, mac]);
    expect(paramsFor(m, box, {})).toEqual({ text: "budget", tier: "instant" });
    expect(paramsFor(m, box, { sources: ["search.mail"] })).toEqual({ text: "budget", sources: ["search.mail"] });
    expect(paramsFor(m, box, { workspaceId: "w1" })).toEqual({ text: "budget", workspaceId: "w1", tier: "instant" });
  });
  it("sends own to every host but the Work home, so LifeOS is asked once", () => {
    const m = typed("budget", [box, mac]);
    expect(paramsFor(m, box, {}).own).toBeUndefined();
    expect(paramsFor(m, mac, {})).toEqual({ text: "budget", tier: "instant", own: true });
    expect(paramsFor(m, mac, { sources: ["search.thread/network"] }).own).toBe(true);
  });
});

describe("the order of the list", () => {
  it("stands the kinds in the fixed order whatever landed first, and a kind it does not know after them in the order it came", () => {
    let m = typed("budget");
    m = landInstant(m, m.gen, "box", answer([group("thread", ["t1"]), group("zebra", ["z1"])], ["search.mail", "search.person", "search.aardvark"])).model;
    m = landSource(m, m.gen, "box", "search.aardvark", answer([group("aardvark", ["a1"])]));
    m = landSource(m, m.gen, "box", "search.mail", answer([group("mail", ["m1"])]));
    m = landSource(m, m.gen, "box", "search.person", answer([group("person", ["p1"])]));
    expect(shape(rowsOf(m))).toEqual(["# Person", "p1", "# Mail", "m1", "# Thread", "t1", "# Zebra", "z1", "# Aardvark", "a1"]);
  });
  it("never changes the order of rows on screen among themselves when more land", () => {
    let m = typed("budget", [box, mac]);
    m = landInstant(m, m.gen, "mac", answer([group("thread", ["mac-1", "mac-2"])])).model;
    const before = shape(rowsOf(m)).filter((r) => !r.startsWith("#"));
    m = landInstant(m, m.gen, "box", answer([group("thread", ["box-1"]), group("file", ["f1"])], ["search.thread/network"])).model;
    m = landSource(m, m.gen, "box", "search.thread/network", answer([group("thread", ["box-2"], { source: "search.thread/network" })]));
    const after = shape(rowsOf(m)).filter((r) => !r.startsWith("#"));
    expect(after).toEqual(["f1", "box-1", "box-2", "mac-1", "mac-2"]);
    expect(after.filter((r) => before.includes(r))).toEqual(before);
  });
  it("shows a thing once, in the first group that has it, whichever source or host found it", () => {
    let m = typed("budget", [box, mac]);
    m = landInstant(m, m.gen, "box", answer([group("thread", ["thread:1"], { source: "search.thread/instant" })], ["search.thread/network"])).model;
    m = landSource(m, m.gen, "box", "search.thread/network", answer([group("thread", ["thread:1", "thread:2"], { source: "search.thread/network" })]));
    m = landInstant(m, m.gen, "mac", answer([group("mail", ["lifeos:mail:9"])])).model;
    m = landInstant(m, m.gen, "box", answer([group("thread", ["thread:1"], { source: "search.thread/instant" }), group("mail", ["lifeos:mail:9"])], [])).model;
    const keys = shape(rowsOf(m)).filter((r) => !r.startsWith("#"));
    expect(keys.filter((k) => k === "thread:1")).toHaveLength(1);
    expect(keys.filter((k) => k === "lifeos:mail:9")).toHaveLength(1);
  });
  it("keeps four of a kind and offers all of it in one row, when a source had more or two sources fill it", () => {
    let m = typed("budget");
    m = landInstant(m, m.gen, "box", answer([group("mail", ["m1", "m2", "m3", "m4"], { more: true }), group("task", ["t1"]), group("thread", ["a", "b", "c"], { source: "search.thread/instant" })], ["search.thread/network"])).model;
    m = landSource(m, m.gen, "box", "search.thread/network", answer([group("thread", ["d", "e"], { source: "search.thread/network" })]));
    expect(shape(rowsOf(m))).toEqual(["# Mail", "m1", "m2", "m3", "m4", "[All mail for “budget”]", "# Task", "t1", "# Thread", "a", "b", "c", "d", "[All threads for “budget”]"]);
  });
});

describe("what stays on screen between keystrokes", () => {
  it("keeps a row of the last generation while it still holds his words, until its own answer lands", () => {
    let m = typed("bud");
    m = landInstant(m, m.gen, "box", answer([group("thread", ["t1"])], ["search.mail"])).model;
    m = landSource(m, m.gen, "box", "search.mail", answer([{ ...group("mail", []), hits: [hit("m1", { title: "Budget review" }), hit("m2", { title: "Buddy pass" })] }]));
    m = typed("budg", [box], m);
    // nothing has answered for "budg" yet: the rows that still match stand, the one that does not is gone
    expect(shape(rowsOf(m))).toEqual(["# Mail", "m1", "# Thread", "t1"]);
    m = landInstant(m, m.gen, "box", answer([], ["search.mail"])).model;
    // the host's instant rows were replaced (none now); mail still waits for its own answer
    expect(shape(rowsOf(m))).toEqual(["# Mail", "m1"]);
    m = landSource(m, m.gen, "box", "search.mail", answer([group("mail", ["m7"])]));
    expect(shape(rowsOf(m))).toEqual(["# Mail", "m7"]);
  });
  it("drops a network row whose source is no longer asked", () => {
    let m = typed("bu");
    m = landInstant(m, m.gen, "box", answer([], ["search.mail"])).model;
    m = landSource(m, m.gen, "box", "search.mail", answer([group("mail", ["m1"])]));
    m = typed("b", [box], m);
    m = landInstant(m, m.gen, "box", answer([], ["search.mail"])).model;
    expect(rowsOf(m).filter(isOption)).toEqual([]);
  });
});

describe("the highlight", () => {
  const filled = (): SearchModel => {
    let m = typed("budget");
    m = landInstant(m, m.gen, "box", answer([group("thread", ["t1", "t2"])], ["search.mail"])).model;
    return m;
  };
  it("stays on the first row until he moves it, even when a group lands above", () => {
    let m = filled();
    expect(activeOf(m, rowsOf(m))).toBe("hit:t1");
    m = landSource(m, m.gen, "box", "search.mail", answer([group("mail", ["m1"])]));
    expect(activeOf(m, rowsOf(m))).toBe("hit:m1");
  });
  it("stays on the row he chose, by arrow or pointer, wherever that row stands after more land", () => {
    let m = step(filled(), rowsOf(filled()), 1);
    expect(activeOf(m, rowsOf(m))).toBe("hit:t2");
    m = landSource(m, m.gen, "box", "search.mail", answer([group("mail", ["m1", "m2"])]));
    expect(activeOf(m, rowsOf(m))).toBe("hit:t2");
    const pointed = point(filled(), "hit:t2");
    expect(pointed.moved).toBe(true);
    expect(activeOf(pointed, rowsOf(pointed))).toBe("hit:t2");
  });
  it("goes round the ends, over the rows a Return can take, the All row among them", () => {
    let m = typed("budget");
    m = landInstant(m, m.gen, "box", answer([group("mail", ["m1", "m2"], { more: true })])).model;
    const rows = rowsOf(m);
    const walk: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      m = step(m, rows, 1);
      walk.push(activeOf(m, rows));
    }
    expect(walk).toEqual(["hit:m2", "all:mail", "hit:m1", "hit:m2"]);
    expect(activeOf(step(typed("x"), [], -1), [])).toBeNull();
    expect(activeOf(step(emptyModelWith(m), rows, -1), rows)).toBe("all:mail");
  });
  it("goes back to the first row when his words change, and to it when the row he chose is gone", () => {
    let m = step(filled(), rowsOf(filled()), 1);
    const again = begin(m, { text: "budget", kind: null, hosts: [box] });
    expect(again.moved).toBe(true);
    m = typed("budgets", [box], m);
    expect(m.moved).toBe(false);
    let gone = step(filled(), rowsOf(filled()), 1);
    gone = landInstant(gone, gone.gen, "box", answer([group("thread", ["t1"])])).model;
    expect(activeOf(gone, rowsOf(gone))).toBe("hit:t1");
  });
});
const emptyModelWith = (m: SearchModel): SearchModel => ({ ...m, moved: false, active: null });

describe("one kind alone", () => {
  it("asks for the kind, shows thirty rows of it and no All row", () => {
    let m = typed("budget", [box], emptyModel(), "mail");
    expect(paramsFor(m, box, {})).toEqual({ text: "budget", tier: "instant", kind: "mail" });
    m = landInstant(m, m.gen, "box", answer([group("thread", ["t1"])], ["search.mail"])).model;
    m = landSource(m, m.gen, "box", "search.mail", answer([group("mail", Array.from({ length: 30 }, (_, i) => `m${i}`), { more: true })]));
    const rows = rowsOf(m);
    expect(rows.filter((r) => r.type === "hit")).toHaveLength(30);
    expect(rows.some((r) => r.type === "all")).toBe(false);
    expect(shape(rows)[0]).toBe("# Mail");
    expect(shape(rows)).not.toContain("t1");
  });
});

describe("Recent", () => {
  it("is what nothing typed shows: eight at most, with no All row, and gone once he types", () => {
    let m = typed("");
    m = landInstant(m, m.gen, "box", answer([{ source: "search.recent", kind: "recent", label: "Recent", more: false, hits: Array.from({ length: 12 }, (_, i) => hit(`r${i}`)) }])).model;
    const rows = rowsOf(m);
    expect(shape(rows)[0]).toBe("# Recent");
    expect(rows.filter((r) => r.type === "hit")).toHaveLength(8);
    expect(rows.some((r) => r.type === "all")).toBe(false);
    expect(shape(rowsOf(typed("b", [box], m)))).toEqual([]);
  });
  it("is nothing at all when there is none: no hint and no tip", () => {
    let m = typed("");
    m = landInstant(m, m.gen, "box", answer([])).model;
    expect(rowsOf(m)).toEqual([]);
  });
});

describe("nothing found, and what could not be searched", () => {
  it("is one muted row once everything has answered, never while a source is out", () => {
    let m = typed("zebra");
    expect(rowsOf(m)).toEqual([]);
    m = landInstant(m, m.gen, "box", answer([], ["search.mail"])).model;
    expect(rowsOf(m)).toEqual([]);
    m = landSource(m, m.gen, "box", "search.mail", answer([]));
    expect(shape(rowsOf(m))).toEqual(["(Nothing for “zebra”)"]);
  });
  it("offers Search all jobs under it when the search is held to one job", () => {
    let m = typed("zebra");
    m = landInstant(m, m.gen, "box", answer([])).model;
    expect(shape(rowsOf(m, { scoped: true }))).toEqual(["(Nothing for “zebra”)", "[Search all jobs]"]);
    expect(activeOf(m, rowsOf(m, { scoped: true }))).toBe("widen");
  });
  it("says one quiet line a cause at the foot: LifeOS once in its own words, a source, a host that did not answer, a host that is offline", () => {
    let m = begin(emptyModel(), { text: "budget", kind: null, hosts: [box, mac], offline: ["Studio"] });
    m = landInstant(m, m.gen, "box", answer([group("thread", ["t1"])], ["search.mail"], [{ cause: "lifeos", line: "This host is not signed in to LifeOS" }])).model;
    m = landSource(m, m.gen, "box", "search.mail", answer([], [], [{ cause: "lifeos", line: "This host is not signed in to LifeOS" }, { cause: "source:search.mail", line: "Mail did not answer." }]));
    m = failed(m, m.gen, "mac", null);
    expect(shape(rowsOf(m))).toEqual(["# Thread", "t1", "(Studio is offline.)", "(LifeOS is signed out on The box.)", "(Mail did not answer on The box.)", "(MacBook did not answer.)"]);
    expect(busy(m)).toBe(false);
  });
  it("words LifeOS's states for the host that asked it, and a source's line with no host when one host is searched", () => {
    expect(quietLine("lifeos", "LifeOS is unreachable", box, 1).line).toBe("The box cannot reach LifeOS.");
    expect(quietLine("lifeos", "This host's LifeOS sign-in waits for approval", box, 1).line).toBe("LifeOS sign-in on The box waits for approval.");
    expect(quietLine("lifeos", "Something new", box, 1).line).toBe("Something new.");
    expect(quietLine("source:search.mail", "Mail did not answer.", box, 1).line).toBe("Mail did not answer.");
  });
  it("a source that failed loses its rows and leaves the host's others", () => {
    let m = typed("budget");
    m = landInstant(m, m.gen, "box", answer([group("thread", ["t1"])], ["search.mail"])).model;
    m = failed(m, m.gen, "box", "search.mail");
    expect(shape(rowsOf(m))).toEqual(["# Thread", "t1", "(The box did not answer.)"]);
  });
});

describe("a change of scope", () => {
  it("takes a host that is no longer asked off the list with its rows", () => {
    let m = typed("budget", [box, mac]);
    m = landInstant(m, m.gen, "box", answer([group("thread", ["box-1"])])).model;
    m = landInstant(m, m.gen, "mac", answer([group("thread", ["mac-1"])])).model;
    m = begin(m, { text: "budget", kind: null, hosts: [mac] });
    expect(shape(rowsOf(m))).toEqual(["# Thread", "mac-1"]);
  });
});
