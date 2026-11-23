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
    expect(failed(second, first.gen, "box", { source: "search.mail", kind: "mail" })).toBe(second);
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
    expect(landInstant(two, two.gen, "box", answer([], ["search.mail", "search.task"])).ask).toEqual([
      { source: "search.mail", kind: "mail" },
      { source: "search.task", kind: "task" },
    ]);
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
    // what lands later goes under the rows of its kind already there, though the Work home would stand first had it answered first
    expect(after).toEqual(["f1", "mac-1", "mac-2", "box-1", "box-2"]);
    expect(after.filter((r) => before.includes(r))).toEqual(before);
  });
  it("stands the Work home's rows first, and what a host knew at once before what it fetched, among rows that land together", () => {
    let m = typed("budget", [box, mac]);
    m = landInstant(m, m.gen, "mac", answer([group("thread", ["mac-1"])], ["search.thread/network"])).model;
    m = landSource(m, m.gen, "mac", "search.thread/network", answer([group("thread", ["mac-2"], { source: "search.thread/network" })]));
    m = landInstant(m, m.gen, "box", answer([group("thread", ["box-1"])])).model;
    // with nothing standing yet (as after new words), the fixed order decides
    expect(shape(rowsOf({ ...m, order: {} }))).toEqual(["# Thread", "box-1", "mac-1", "mac-2"]);
  });
  it("keeps the rows he was reading in their places when a fuller answer lands: the free places fill, the rest is behind All", () => {
    let m = typed("budget", [box, mac]);
    m = landInstant(m, m.gen, "mac", answer([group("thread", ["mac-1", "mac-2", "mac-3"])])).model;
    m = landInstant(m, m.gen, "box", answer([group("thread", ["box-1", "box-2", "box-3"])])).model;
    expect(shape(rowsOf(m))).toEqual(["# Thread", "mac-1", "mac-2", "mac-3", "box-1", "[All threads for “budget”]"]);
    // a row that leaves gives its place to the next; the others do not move
    m = landInstant(m, m.gen, "mac", answer([group("thread", ["mac-1", "mac-3"])])).model;
    expect(shape(rowsOf(m))).toEqual(["# Thread", "mac-1", "mac-3", "box-1", "box-2", "[All threads for “budget”]"]);
  });
  it("ranks afresh at the first answer to new words, and not before: the rows on screen stand as they did until then", () => {
    let m = typed("budget", [box, mac]);
    m = landInstant(m, m.gen, "mac", answer([group("thread", ["mac-1"])])).model;
    m = landInstant(m, m.gen, "box", answer([group("thread", ["box-1"])])).model;
    expect(shape(rowsOf(m))).toEqual(["# Thread", "mac-1", "box-1"]);
    // a key: nothing has answered, nothing moves
    m = typed("budget ", [box, mac], m);
    m = begin(m, { text: "budget 1", kind: null, hosts: [box, mac] });
    expect(shape(rowsOf(m))).toEqual(["# Thread", "mac-1", "box-1"]);
    // the first answer to the new words: the fixed order again, the Work home first
    m = landInstant(m, m.gen, "mac", answer([group("thread", ["mac-1"])])).model;
    expect(shape(rowsOf(m))).toEqual(["# Thread", "box-1", "mac-1"]);
    // and from there what lands goes under
    m = landInstant(m, m.gen, "box", answer([group("thread", ["box-0", "box-1"])])).model;
    expect(shape(rowsOf(m))).toEqual(["# Thread", "box-1", "mac-1", "box-0"]);
  });
  it("leaves a row he has already moved to in its place at the first answer to new words: the new rows go under", () => {
    let m = typed("budget", [box, mac]);
    m = landInstant(m, m.gen, "mac", answer([group("thread", ["mac-1"])])).model;
    m = landInstant(m, m.gen, "box", answer([group("thread", ["box-1"])])).model;
    m = typed("budget ", [box, mac], m);
    m = begin(m, { text: "budget b", kind: null, hosts: [box, mac] });
    expect(m.moved).toBe(false);
    // before anything answers he arrows to the second row of what still stands there
    m = step(m, rowsOf(m), 1);
    expect(activeOf(m, rowsOf(m))).toBe("hit:box-1");
    m = landInstant(m, m.gen, "box", answer([group("thread", ["box-1", "box-2"])])).model;
    expect(shape(rowsOf(m))).toEqual(["# Thread", "mac-1", "box-1", "box-2"]);
    expect(activeOf(m, rowsOf(m))).toBe("hit:box-1");
  });
  it("carries the order on when the same ask is made again (a host came or went)", () => {
    let m = typed("budget", [box, mac]);
    m = landInstant(m, m.gen, "mac", answer([group("thread", ["mac-1"])])).model;
    m = landInstant(m, m.gen, "box", answer([group("thread", ["box-1"])])).model;
    m = begin(m, { text: "budget", kind: null, hosts: [box, mac] });
    m = landInstant(m, m.gen, "box", answer([group("thread", ["box-1", "box-2"])])).model;
    expect(shape(rowsOf(m))).toEqual(["# Thread", "mac-1", "box-1", "box-2"]);
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
  it("goes back to the first row when his words change; a row he chose that an answer takes away leaves none lit, never a neighbour for Return", () => {
    let m = step(filled(), rowsOf(filled()), 1);
    const again = begin(m, { text: "budget", kind: null, hosts: [box] });
    expect(again.moved).toBe(true);
    m = typed("budgets", [box], m);
    expect(m.moved).toBe(false);
    let gone = step(filled(), rowsOf(filled()), 1);
    gone = landInstant(gone, gone.gen, "box", answer([group("thread", ["t1"])])).model;
    expect(activeOf(gone, rowsOf(gone))).toBeNull();
    // the next arrow starts from the top, whichever arrow it is
    gone = landInstant(gone, gone.gen, "box", answer([group("thread", ["t1", "t8", "t9"])])).model;
    expect(activeOf(gone, rowsOf(gone))).toBeNull();
    expect(activeOf(step(gone, rowsOf(gone), 1), rowsOf(gone))).toBe("hit:t1");
    expect(activeOf(step(gone, rowsOf(gone), -1), rowsOf(gone))).toBe("hit:t1");
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
    // the field already names the kind: no heading says it a second time
    expect(rows.some((r) => r.type === "heading")).toBe(false);
    expect(shape(rows)[0]).toBe("m0");
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
    // the window's own failed ask of that source says the same one line, not a second
    m = failed(m, m.gen, "box", { source: "search.mail", kind: "mail" });
    expect(shape(rowsOf(m)).filter((r) => r.includes("Mail did not answer"))).toHaveLength(1);
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
    m = failed(m, m.gen, "box", { source: "search.mail", kind: "mail" });
    // the host answered its other sources: the line names what did not, never the host
    expect(shape(rowsOf(m))).toEqual(["# Thread", "t1", "(Mail did not answer.)"]);
    expect(busy(m)).toBe(false);
  });
});

describe("nothing could be asked", () => {
  it("says only why: never that nothing was found, when no host answered or none could be asked", () => {
    let none = begin(emptyModel(), { text: "budget", kind: null, hosts: [], offline: ["The box"] });
    expect(shape(rowsOf(none))).toEqual(["(The box is offline.)"]);
    none = typed("budget", [box, mac]);
    none = failed(failed(none, none.gen, "box", null), none.gen, "mac", null);
    expect(shape(rowsOf(none))).toEqual(["(The box did not answer.)", "(MacBook did not answer.)"]);
    // one host answered and found nothing: that is worth saying
    let one = typed("budget", [box, mac]);
    one = failed(landInstant(one, one.gen, "box", answer([])).model, one.gen, "mac", null);
    expect(shape(rowsOf(one))).toEqual(["(Nothing for “budget”)", "(MacBook did not answer.)"]);
  });
  it("says only why when a host answered but no source of it could search: mail alone, with LifeOS signed out", () => {
    const signedOut = { ...answer([], [], [{ cause: "lifeos", line: "This host is not signed in to LifeOS" }]), searched: 0 };
    let m = typed("budget", [box], emptyModel(), "mail");
    m = landInstant(m, m.gen, "box", signedOut).model;
    expect(shape(rowsOf(m, { scoped: true }))).toEqual(["(LifeOS is signed out on The box.)"]);
    // a source that searched and found nothing is worth saying, beside what could not be searched
    let some = typed("budget");
    some = landInstant(some, some.gen, "box", { ...signedOut, searched: 2 }).model;
    expect(shape(rowsOf(some))).toEqual(["(Nothing for “budget”)", "(LifeOS is signed out on The box.)"]);
    // a network source's own answer counts
    let later = typed("budget");
    later = landInstant(later, later.gen, "box", { ...answer([], ["search.mail"]), searched: 0 }).model;
    later = landSource(later, later.gen, "box", "search.mail", { ...answer([]), searched: 1 });
    expect(shape(rowsOf(later))).toEqual(["(Nothing for “budget”)"]);
    // and a new generation has not searched until it answers
    expect(typed("budgets", [box], later).searched).toBe(false);
  });
  it("never says nothing was found under two characters: the network sources were not asked", () => {
    let m = typed("b");
    m = landInstant(m, m.gen, "box", { ...answer([], ["search.mail"]), searched: 3 }).model;
    expect(busy(m)).toBe(false);
    expect(rowsOf(m)).toEqual([]);
  });
});

describe("the row he chose and the cap", () => {
  it("keeps its place when more of its kind lands: what lands goes under the rows already there", () => {
    let m = typed("budget", [box, mac]);
    m = landInstant(m, m.gen, "mac", answer([group("thread", ["mac-1", "mac-2", "mac-3"])])).model;
    m = step(step(m, rowsOf(m), 1), rowsOf(m), 1);
    expect(activeOf(m, rowsOf(m))).toBe("hit:mac-3");
    m = landInstant(m, m.gen, "box", answer([group("thread", ["box-1", "box-2", "box-3"])])).model;
    const rows = rowsOf(m);
    expect(shape(rows)).toEqual(["# Thread", "mac-1", "mac-2", "mac-3", "box-1", "[All threads for “budget”]"]);
    expect(activeOf(m, rows)).toBe("hit:mac-3");
  });
  it("is never the one the cap cuts: in Recent, where newer openings stand first, it takes the last place", () => {
    const recent = (keys: [string, number][]): SearchGroup => ({ source: "search.recent", kind: "recent", label: "Recent", more: false, hits: keys.map(([key, openedAt]) => hit(key, { openedAt })) });
    let m = typed("", [box, mac]);
    m = landInstant(m, m.gen, "box", answer([recent([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`b${n}`, 100 - n]))])).model;
    for (let i = 0; i < 7; i++) m = step(m, rowsOf(m), 1);
    expect(activeOf(m, rowsOf(m))).toBe("hit:b8");
    m = landInstant(m, m.gen, "mac", answer([recent([["m-new", 500]])])).model;
    const rows = rowsOf(m);
    expect(shape(rows)).toEqual(["# Recent", "m-new", "b1", "b2", "b3", "b4", "b5", "b6", "b8"]);
    expect(activeOf(m, rows)).toBe("hit:b8");
  });
});

describe("Recent across hosts", () => {
  it("is one list, the newest opened first wherever he opened it", () => {
    let m = typed("", [box, mac]);
    const recent = (keys: [string, number][]): SearchGroup => ({ source: "search.recent", kind: "recent", label: "Recent", more: false, hits: keys.map(([key, openedAt]) => hit(key, { openedAt })) });
    m = landInstant(m, m.gen, "box", answer([recent([["b-old", 10], ["b-older", 5]])])).model;
    m = landInstant(m, m.gen, "mac", answer([recent([["m-new", 50], ["m-mid", 8]])])).model;
    expect(shape(rowsOf(m))).toEqual(["# Recent", "m-new", "b-old", "m-mid", "b-older"]);
  });
  it("lists a thing two hosts hold once, by its newest opening, to be opened on the host that holds that one", () => {
    let m = typed("", [box, mac]);
    const recent = (keys: [string, number][]): SearchGroup => ({ source: "search.recent", kind: "recent", label: "Recent", more: false, hits: keys.map(([key, openedAt]) => hit(key, { openedAt })) });
    m = landInstant(m, m.gen, "box", answer([recent([["b-mid", 20], ["shared", 5]])])).model;
    m = landInstant(m, m.gen, "mac", answer([recent([["shared", 90], ["m-old", 1]])])).model;
    const rows = rowsOf(m);
    expect(shape(rows)).toEqual(["# Recent", "shared", "b-mid", "m-old"]);
    expect(rows.find((row) => row.type === "hit" && row.hit.key === "shared")).toMatchObject({ host: "mac" });
  });
});

describe("out of one kind", () => {
  it("puts the highlight back on the row he came in by, held as a row he chose", () => {
    let m = typed("budget");
    m = landInstant(m, m.gen, "box", answer([group("person", ["p1"]), group("mail", ["m1", "m2", "m3", "m4"], { more: true })])).model;
    m = begin(m, { text: "budget", kind: "mail", hosts: [box] });
    expect([m.moved, m.active]).toEqual([false, null]);
    m = landInstant(m, m.gen, "box", answer([group("mail", ["m1", "m2", "m3", "m4", "m5", "m6"])])).model;
    m = begin(m, { text: "budget", kind: null, hosts: [box] });
    // the mail he was looking at still holds his words: four of it, and the row that opens the rest
    expect(shape(rowsOf(m))).toEqual(["# Mail", "m1", "m2", "m3", "m4", "[All mail for “budget”]"]);
    expect(activeOf(m, rowsOf(m))).toBe("all:mail");
    m = landInstant(m, m.gen, "box", answer([group("person", ["p1"]), group("mail", ["m1", "m2", "m3", "m4"], { more: true })])).model;
    expect(activeOf(m, rowsOf(m))).toBe("all:mail");
    // into a kind, and with other words, the highlight starts at the top as ever
    expect(begin(m, { text: "budgets", kind: null, hosts: [box] }).active).toBeNull();
  });
});

describe("out of one kind, before its answer", () => {
  it("keeps the row he came in by under him: Return straight after Escape is not another row's", () => {
    let m = typed("budget");
    m = landInstant(m, m.gen, "box", answer([group("person", ["p1"]), group("mail", ["m1", "m2", "m3", "m4"], { more: true })])).model;
    // Return on "All mail", then Escape before the kind's own answer lands
    m = begin(m, { text: "budget", kind: "mail", hosts: [box] });
    m = begin(m, { text: "budget", kind: null, hosts: [box] });
    const rows = rowsOf(m);
    expect(shape(rows)).toEqual(["# Person", "p1", "# Mail", "m1", "m2", "m3", "m4", "[All mail for “budget”]"]);
    expect(activeOf(m, rows)).toBe("all:mail");
    // the fresh answer decides: with no more mail than is shown, the row goes and the highlight with it
    m = landInstant(m, m.gen, "box", answer([group("person", ["p1"]), group("mail", ["m1", "m2", "m3", "m4"])])).model;
    expect(activeOf(m, rowsOf(m))).toBe("hit:p1");
  });
});

describe("Recent, by how a row reads", () => {
  it("lists two things that would read the same once, the newest: two messages of one conversation", () => {
    const recent = (rows: [string, string, number][]): SearchGroup => ({ source: "search.recent", kind: "recent", label: "Recent", more: false, hits: rows.map(([key, title, openedAt]) => hit(key, { kind: "message", title, openedAt })) });
    let m = typed("");
    m = landInstant(m, m.gen, "box", answer([recent([["r2", "#launch-crew", 30], ["m9", "#finance", 20], ["r1", "#launch-crew", 10]])])).model;
    expect(shape(rowsOf(m))).toEqual(["# Recent", "r2", "m9"]);
  });
});

describe("Recent, held to one kind", () => {
  const recent = (rows: [string, string, number, string?][]): SearchGroup => ({ source: "search.recent", kind: "recent", label: "Recent", more: false, hits: rows.map(([key, kind, openedAt, workspaceId]) => hit(key, { kind, title: `Thing ${key.replace(/-.*/, "")}`, openedAt, workspaceId: workspaceId ?? "w1" })) });
  it("stays with nothing typed, by the things of that kind in it, under its own heading", () => {
    let m = typed("", [box], emptyModel(), "mail");
    m = landInstant(m, m.gen, "box", answer([recent([["m1", "mail", 30], ["t1", "thread", 20], ["m2", "mail", 10]])])).model;
    expect(shape(rowsOf(m))).toEqual(["# Recent", "m1", "m2"]);
  });
  it("lists a thing of one job opened on two hosts once, by the job the row shows", () => {
    let m = typed("", [box, mac]);
    m = landInstant(m, m.gen, "box", answer([recent([["a-box", "mail", 10, "w-box"]])])).model;
    m = landInstant(m, m.gen, "mac", answer([recent([["a-mac", "mail", 20, "w-mac"]])])).model;
    const jobOf = (id: string | null): string => (id === "w-box" || id === "w-mac" ? "purdue" : (id ?? ""));
    expect(shape(rowsOf(m, { jobOf }))).toEqual(["# Recent", "a-mac"]);
    // by the workspace alone they are two things
    expect(shape(rowsOf(m))).toEqual(["# Recent", "a-mac", "a-box"]);
  });
});

describe("what could not be searched", () => {
  it("is never the same words twice, and is marked as the list's foot", () => {
    let m = typed("budget");
    m = landInstant(m, m.gen, "box", answer([], ["search.file/instant", "search.file/network#2"])).model;
    m = failed(m, m.gen, "box", { source: "search.file/instant", kind: "file" });
    m = failed(m, m.gen, "box", { source: "search.file/network#2", kind: "file" });
    const causes = rowsOf(m).filter((row) => row.type === "note" && row.cause);
    expect(causes).toEqual([{ type: "note", id: "quiet:source:search.file/instant@box", text: "Files did not answer.", cause: true }]);
  });
});

describe("his words", () => {
  it("are asked no longer than the wire takes", () => {
    const m = typed(`${"long ".repeat(60)}`);
    expect(m.text.length).toBeLessThanOrEqual(200);
    expect(paramsFor(m, box, {}).text).toBe(m.text);
  });
});

describe("a change of scope", () => {
  it("keeps what is still in reach and nothing else: narrowed, the job's own rows stay and no other job's row is left for a Return to take; widened, every row stays", () => {
    const mails = (): SearchGroup => ({ ...group("mail", []), hits: [hit("m-purdue", { workspaceId: "w-purdue" }), hit("m-cosmic", { workspaceId: "w-cosmic" }), hit("m-chats", { workspaceId: null })], more: true });
    let m = begin(emptyModel(), { text: "budget", kind: null, scope: null, hosts: [box] });
    m = landInstant(m, m.gen, "box", answer([mails(), { ...group("thread", []), hits: [hit("t-cosmic", { kind: "thread", workspaceId: "w-cosmic" })] }])).model;
    m = step(m, rowsOf(m), 1);
    m = begin(m, { text: "budget", kind: null, scope: "purdue", within: ["w-purdue"], hosts: [box] });
    // the job's mail stays where it stood; the other job's, the Work Chats' and the empty group are gone; "All mail" waits for the fresh answer
    expect(shape(rowsOf(m))).toEqual(["# Mail", "m-purdue"]);
    expect(activeOf(m, rowsOf(m))).toBe("hit:m-purdue");
    expect(m.moved).toBe(false);
    // widened again before anything answers: nothing goes
    m = landInstant(m, m.gen, "box", answer([{ ...group("mail", []), hits: [hit("m-purdue", { workspaceId: "w-purdue" })] }])).model;
    m = begin(m, { text: "budget", kind: null, scope: null, hosts: [box] });
    expect(shape(rowsOf(m))).toEqual(["# Mail", "m-purdue"]);
    // a row the host found by words past its cut text stays through a change of scope: for the same words its verdict stands
    let far = begin(emptyModel(), { text: "venue", kind: null, scope: null, hosts: [box] });
    far = landInstant(far, far.gen, "box", answer([{ ...group("project", []), hits: [hit("j1", { kind: "project", title: "Offsite", snippet: "The budget and", workspaceId: "w-purdue" })] }])).model;
    far = begin(far, { text: "venue", kind: null, scope: "purdue", within: ["w-purdue"], hosts: [box] });
    expect(shape(rowsOf(far))).toEqual(["# Project", "j1"]);
    // and leaves when his words change to ones its text does not hold
    expect(rowsOf(begin(far, { text: "venues", kind: null, scope: "purdue", within: ["w-purdue"], hosts: [box] }))).toEqual([]);
    // with no word of which workspaces the job has, nothing is kept
    let blind = begin(emptyModel(), { text: "budget", kind: null, scope: null, hosts: [box] });
    blind = landInstant(blind, blind.gen, "box", answer([mails()])).model;
    expect(rowsOf(begin(blind, { text: "budget", kind: null, scope: "purdue", hosts: [box] }))).toEqual([]);
    // the same words in the same scope keep what is on screen
    let same = begin(emptyModel(), { text: "budget", kind: null, scope: "purdue", hosts: [box] });
    same = landInstant(same, same.gen, "box", answer([group("mail", ["m-purdue"])])).model;
    expect(shape(rowsOf(begin(same, { text: "budget", kind: null, scope: "purdue", hosts: [box] })))).toEqual(["# Mail", "m-purdue"]);
  });
  it("takes a host that is no longer asked off the list with its rows", () => {
    let m = typed("budget", [box, mac]);
    m = landInstant(m, m.gen, "box", answer([group("thread", ["box-1"])])).model;
    m = landInstant(m, m.gen, "mac", answer([group("thread", ["mac-1"])])).model;
    m = begin(m, { text: "budget", kind: null, hosts: [mac] });
    expect(shape(rowsOf(m))).toEqual(["# Thread", "mac-1"]);
  });
});
