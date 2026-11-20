import { describe, expect, it } from "vitest";
import type { HealthRow, Lapse } from "@shared/work/health";
import { dueNotices } from "./lapseNotice";
import { fixVariant, markOf, sectionsOf, unchecked, usableFix, type HostView } from "./model";

const row = (over: Partial<HealthRow>): HealthRow => ({ id: "x", pillar: "office", group: "Office", title: "Excel", state: "working", ...over });
const ready = (id: string, name: string, rows: HealthRow[]): HostView => ({ id, name, status: "ready", report: { host: id, at: 0, rows } });

describe("sectionsOf", () => {
  it("orders sections by what the rest leans on, keeping each host's order inside", () => {
    const sections = sectionsOf([
      ready("box", "the box", [row({ id: "tools", group: "Tools", title: "Conversion tools" }), row({ id: "signin", group: "LifeOS", title: "LifeOS" }), row({ id: "odd", group: "Something new", title: "Odd" })]),
    ]);
    expect(sections.map((s) => s.group)).toEqual(["LifeOS", "Tools", "Something new"]);
  });

  it("names a host only on a title two hosts both give", () => {
    const sections = sectionsOf([
      ready("box", "the box", [row({ id: "signin", group: "LifeOS", title: "LifeOS" }), row({ id: "vm", group: "Windows VM", title: "Windows VM" })]),
      ready("mac", "Mac", [row({ id: "signin", group: "LifeOS", title: "LifeOS", state: "needs-you" }), row({ id: "excel" })]),
    ]);
    expect(sections.flatMap((s) => s.rows.map((r) => r.title))).toEqual(["LifeOS on the box", "LifeOS on Mac", "Excel", "Windows VM"]);
  });

  it("shows a row two hosts give alike once: a LifeOS source both hosts read", () => {
    const source = row({ id: "lifeos.source:1", group: "Mail and calendar", title: "Purdue mail", line: "Synced 2:02 PM", sector: "purdue", shared: true });
    const sections = sectionsOf([ready("box", "the box", [source]), ready("mac", "Mac", [{ ...source }])]);
    expect(sections).toEqual([{ group: "Mail and calendar", rows: [expect.objectContaining({ hostId: "box", title: "Purdue mail" })] }]);
  });

  it("never folds a host's own rows, nor a row with a fix: each press belongs to its host", () => {
    const signedIn = row({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", line: "Signed in", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } });
    const sections = sectionsOf([ready("box", "the box", [signedIn, row({ id: "excel", line: "Closed" })]), ready("mac", "Mac", [{ ...signedIn }, row({ id: "excel", line: "Closed" })])]);
    expect(sections.flatMap((s) => s.rows.map((r) => [r.hostId, r.title]))).toEqual([
      ["box", "LifeOS on the box"],
      ["mac", "LifeOS on Mac"],
      ["box", "Excel on the box"],
      ["mac", "Excel on Mac"],
    ]);
  });

  it("keeps a host's last rows while it checks again, and draws none for a host that never answered", () => {
    const checking: HostView = { id: "box", name: "the box", status: "checking", report: { host: "box", at: 0, rows: [row({})] } };
    expect(sectionsOf([checking])[0]!.rows).toHaveLength(1);
    expect(sectionsOf([{ id: "mac", name: "Mac", status: "checking" }])).toEqual([]);
  });
});

describe("the rest of the page's words", () => {
  it("lists only the hosts that could not be checked", () => {
    const hosts: HostView[] = [ready("box", "the box", []), { id: "mac", name: "Mac", status: "offline" }, { id: "pc", name: "PC", status: "failed", error: "Work is off on this host" }];
    expect(unchecked(hosts).map((h) => h.id)).toEqual(["mac", "pc"]);
  });

  it("says each state in the vocabulary's glyph and tone, with this page's word", () => {
    expect(markOf("working")).toEqual({ state: "done", word: "Working" });
    expect(markOf("needs-you")).toEqual({ state: "waiting", word: "Needs you" });
    expect(markOf("broken")).toEqual({ state: "failed", word: "Broken" });
    expect(fixVariant("working")).toBe("ghost");
    expect(fixVariant("broken")).toBe("secondary");
  });

  it("carries out only the allowed fixes, whatever a host sent", () => {
    expect(usableFix({ kind: "run", label: "Go", method: "work.lifeos.signOut" })).not.toBeNull();
    expect(usableFix({ kind: "run", label: "Go", method: "work.outbox.send" })).toBeNull();
    expect(usableFix({ kind: "page", label: "Go", page: "settings:providers" })).toBeNull();
    expect(usableFix({ kind: "open", label: "Grant…", url: "javascript:alert(1)" })).toBeNull();
    expect(usableFix({ kind: "open", label: "Grant…", url: "https://accounts.google.com/" })).not.toBeNull();
    expect(usableFix(undefined)).toBeNull();
  });
});

describe("dueNotices", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2027, 1, 5, 12);
  const vm: Lapse = { id: "browser.vm", pillar: "browser", title: "Windows evaluation", until: Date.UTC(2027, 1, 18, 4, 59) };

  it("is due once at 14 days, again at the last day, and never twice for one stage", () => {
    expect(dueNotices("box", [vm], new Set(), now - 10 * DAY)).toEqual([]);
    const first = dueNotices("box", [vm], new Set(), now);
    expect(first).toEqual([{ key: expect.stringContaining("browser.vm"), text: expect.stringMatching(/^Windows evaluation: Ends Feb 1[78], /) }]);
    expect(dueNotices("box", [vm], new Set([first[0]!.key]), now + 3 * DAY)).toEqual([]);
    const last = dueNotices("box", [vm], new Set([first[0]!.key]), vm.until - DAY / 2);
    expect(last).toHaveLength(1);
    expect(last[0]!.key).not.toBe(first[0]!.key);
  });

  it("says a new end date again, as a new lapse", () => {
    const first = dueNotices("box", [vm], new Set(), now);
    expect(dueNotices("box", [{ ...vm, until: vm.until + DAY }], new Set([first[0]!.key]), now)).toHaveLength(1);
  });
});
