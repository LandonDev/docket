import { describe, expect, it } from "vitest";
import type { HealthRow } from "@shared/work/health";
import { checkDetail, fixVariant, markOf, sectionsOf, unchecked, usableFix, type HostView } from "./model";

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
    expect(sections).toEqual([{ group: "Mail and calendar", titled: true, rows: [expect.objectContaining({ hostId: "box", title: "Purdue mail" })] }]);
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
  it("draws no heading over a group whose one row has its name", () => {
    const sections = sectionsOf([ready("box", "the box", [row({ id: "frameio", group: "Frame.io", title: "Frame.io" }), row({ id: "excel", group: "Tools", title: "Excel" })])]);
    expect(sections.map((s) => [s.group, s.titled])).toEqual([["Tools", true], ["Frame.io", false]]);
  });

  it("says a failed check's cause once: nothing after Did not answer that says it again", () => {
    expect(checkDetail("The host did not answer")).toBeUndefined();
    expect(checkDetail("The box did not answer. Try again once it is connected.")).toBeUndefined();
    expect(checkDetail("")).toBeUndefined();
    expect(checkDetail("Work is off on the box. Turn it on in Settings, Work.")).toBe("Work is off on the box. Turn it on in Settings, Work.");
  });

  it("lists only the hosts that could not be checked", () => {
    const hosts: HostView[] = [ready("box", "the box", []), { id: "mac", name: "Mac", status: "offline" }, { id: "pc", name: "PC", status: "failed", error: "Work is off on this host" }];
    expect(unchecked(hosts).map((h) => h.id)).toEqual(["mac", "pc"]);
  });

  it("says each state in the vocabulary's glyph and tone, with this page's word", () => {
    expect(markOf("working")).toEqual({ state: "done", word: "Ready" });
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
    // His Office sign-in lives in one computer's windows: Sign out is offered there, never from another computer's window.
    const signOut = { kind: "run", label: "Sign out", method: "work.office.live.signOut", params: { tenant: "purdue0" } } as const;
    expect(usableFix(signOut, true)).toEqual(signOut);
    expect(usableFix(signOut, false)).toBeNull();
    expect(usableFix({ kind: "run", label: "Sign out", method: "work.lifeos.signOut" }, false)).not.toBeNull();
  });
});
