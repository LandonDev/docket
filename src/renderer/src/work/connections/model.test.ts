import { describe, expect, it } from "vitest";
import type { HealthRow } from "@shared/work/health";
import { checkFailure, fixVariant, lifeosLine, markOf, sectionsOf, unchecked, usableFix, type HostView } from "./model";

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

  /** Council round 8 (Opus Settings 1, Sol Settings 2): the host's "this host" words, and "LifeOS answers" with no computer. */
  it("names the computer on every LifeOS row's title once two hosts are listed, its line then the state alone", () => {
    const lifeos = (over: Partial<HealthRow>): HealthRow => row({ pillar: "lifeos", group: "LifeOS", title: "LifeOS", ...over });
    const sections = sectionsOf([
      ready("box", "the box", [lifeos({ id: "lifeos.signin", state: "needs-you", lifeos: "signed-out", line: "Not signed in to LifeOS" })]),
      ready("mac", "Mac", [lifeos({ id: "lifeos.signin", lifeos: "connected", line: "Signed in" }), lifeos({ id: "lifeos.answers", title: "LifeOS answers", state: "broken", lifeos: "unreachable", line: "LifeOS did not answer" }), lifeos({ id: "lifeos.keys:enrolled", title: "Agents' LifeOS keys", state: "broken", line: "x" })]),
    ]);
    expect(sections[0]!.rows.map((r) => [r.title, r.line ?? r.row.line])).toEqual([
      ["LifeOS on the box", "Not signed in"],
      ["LifeOS on Mac", "Signed in"],
      ["LifeOS answers on Mac", "LifeOS did not answer"],
      ["Agents' LifeOS keys on Mac", "x"],
    ]);
    // One host listed: the line still names its computer, the title stays plain.
    const one = sectionsOf([ready("mac", "Mac", [lifeos({ id: "lifeos.signin", lifeos: "connected", line: "Signed in" })])]);
    expect(one[0]!.rows[0]!.title).toBe("LifeOS");
  });

  it("words each LifeOS state by the rule, the computer named, and keeps the host's line from a build that names none", () => {
    const signIn = (lifeos: HealthRow["lifeos"], line = "") => lifeosLine(row({ pillar: "lifeos", id: "lifeos.signin", group: "LifeOS", lifeos, line }), "The box");
    expect(signIn("signed-out")).toBe("Not signed in to LifeOS on the box");
    expect(signIn("pairing")).toBe("The LifeOS sign-in on the box waits for your approval");
    expect(signIn("refused")).toBe("LifeOS refused the box's sign-in");
    expect(signIn("connecting")).toBe("LifeOS is still connecting on the box");
    expect(signIn("unreachable")).toBe("LifeOS did not answer the box. Still trying since");
    expect(signIn("connected")).toBeNull();
    expect(signIn(undefined, "Not signed in on this host")).toBeNull();
    const answers = (line: string) => lifeosLine(row({ pillar: "lifeos", id: "lifeos.answers", group: "LifeOS", lifeos: "unreachable", line }), "Mac");
    expect(answers("LifeOS did not answer")).toBe("LifeOS did not answer Mac");
    expect(answers("LifeOS did not answer: fetch failed")).toBe("LifeOS did not answer Mac: fetch failed");
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

  /** Council round 9 (Sol, Settings 2): the Mac did not answer a Retry, and its old row still blamed LifeOS. */
  it("draws no old cause of LifeOS's silence for a host that did not answer, asked again or not; its other rows and Sign out stay", () => {
    const lifeos = (over: Partial<HealthRow>): HealthRow => row({ pillar: "lifeos", group: "LifeOS", title: "LifeOS", ...over });
    const report = {
      host: "mac",
      at: 0,
      rows: [
        lifeos({ id: "lifeos.signin", state: "broken", lifeos: "unreachable", line: "LifeOS did not answer. Still trying since", at: 1, fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } }),
        lifeos({ id: "lifeos.answers", title: "LifeOS answers", state: "broken", lifeos: "unreachable", line: "LifeOS did not answer" }),
        row({ id: "excel" }),
      ],
    };
    for (const silent of [{ id: "mac", name: "Mac", status: "failed", silent: true, report }, { id: "mac", name: "Mac", status: "checking", silent: true, report }] as HostView[]) {
      const rows = sectionsOf([silent]).flatMap((s) => s.rows);
      expect(rows.map((r) => r.row.id)).toEqual(["lifeos.signin", "excel"]);
      expect(rows[0]).toMatchObject({ hushed: true, row: { fix: { label: "Sign out" } } });
      expect(rows[0]!.line).toBeUndefined();
    }
    // A host that refused did answer: its rows say what they said.
    const refused = sectionsOf([{ id: "mac", name: "Mac", status: "failed", silent: false, error: "x", report }]).flatMap((s) => s.rows);
    expect(refused.map((r) => r.row.id)).toEqual(["lifeos.signin", "lifeos.answers", "excel"]);
    expect(refused.some((r) => r.hushed)).toBe(false);
  });
});

describe("the rest of the page's words", () => {
  it("draws no heading over a group whose one row has its name", () => {
    const sections = sectionsOf([ready("box", "the box", [row({ id: "frameio", group: "Frame.io", title: "Frame.io" }), row({ id: "excel", group: "Tools", title: "Excel" })])]);
    expect(sections.map((s) => [s.group, s.titled])).toEqual([["Tools", true], ["Frame.io", false]]);
  });

  it("says a failed check's cause once: nothing after Did not answer that says it again", () => {
    expect(checkFailure("The host did not answer")).toEqual({ word: "Did not answer", silent: true });
    expect(checkFailure("The box did not answer. Try again once it is connected.")).toEqual({ word: "Did not answer", silent: true });
  });

  it("words a host that answered with a refusal as Not checked, never Did not answer", () => {
    expect(checkFailure("Work is off on the box. Turn it on in Settings, Work.")).toEqual({ word: "Not checked", silent: false, error: "Work is off on the box. Turn it on in Settings, Work." });
    // Raw words that `workErrorWords` dropped: the word alone.
    expect(checkFailure("")).toEqual({ word: "Not checked", silent: false });
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

describe("a row's words", () => {
  it("names this window's own computer as this Mac in a LifeOS row's title", () => {
    const lifeos = (over: Partial<HealthRow>): HealthRow => row({ pillar: "lifeos", group: "LifeOS", title: "LifeOS", ...over });
    const sections = sectionsOf([
      { ...ready("box", "The box", [lifeos({ id: "lifeos.signin", lifeos: "connected", line: "Signed in" })]) },
      { ...ready("local", "MacBook Pro", [lifeos({ id: "lifeos.signin", state: "needs-you", lifeos: "signed-out", line: "x" })]), inLine: "this Mac" },
    ]);
    expect(sections[0]!.rows.map((r) => [r.title, r.line ?? r.row.line])).toEqual([
      ["LifeOS on the box", "Signed in"],
      ["LifeOS on this Mac", "Not signed in"],
    ]);
  });
});

describe("a row's command and its sign-out", () => {
  it("takes a host's install command out of the line, the words left a sentence", async () => {
    const { commandOf } = await import("./model");
    expect(commandOf("Its files are missing. Install it again with bun scripts/work-tools/install.ts --only ffmpeg")).toEqual({ words: "Its files are missing. Install it again.", command: "bun scripts/work-tools/install.ts --only ffmpeg" });
    expect(commandOf("None installed. Install them with bun scripts/work-tools/install.ts on this host.")).toEqual({ words: "None installed. Install them on this host.", command: "bun scripts/work-tools/install.ts" });
    expect(commandOf("No live video until the screen relay is installed: bun scripts/work-tools/install.ts --only screen-relay")).toEqual({ words: "No live video until the screen relay is installed.", command: "bun scripts/work-tools/install.ts --only screen-relay" });
    expect(commandOf("Synced 3 min ago")).toEqual({ words: "Synced 3 min ago", command: null });
  });

  it("asks before a sign-out, naming what stops working", async () => {
    const { signOutAsk, signsOut } = await import("./model");
    expect(signsOut({ kind: "run", label: "Sign out", method: "work.office.live.signOut" })).toBe(true);
    expect(signsOut({ kind: "run", label: "Install", method: "work.formats.install" })).toBe(false);
    expect(signOutAsk("Office and Forms for the web, Purdue University", "the box").title).toBe("Sign out of Office and Forms for the web, Purdue University on the box?");
  });
});

describe("a fix's words and a row's end date", () => {
  it("ends a sign-in or sign-out's words in an ellipsis, once, and names what a date ends", async () => {
    const { fixLabel, lapseWords } = await import("./ConnectionsPage");
    expect(fixLabel({ kind: "page", label: "Sign in", page: "lifeos-sign-in" })).toBe("Sign in…");
    expect(fixLabel({ kind: "page", label: "Sign in…", page: "windows-vm-sign-in" })).toBe("Sign in…");
    expect(fixLabel({ kind: "run", label: "Sign out", method: "work.lifeos.signOut" })).toBe("Sign out…");
    expect(fixLabel({ kind: "run", label: "Install", method: "work.formats.install" })).toBe("Install");
    const now = Date.UTC(2026, 10, 20, 15);
    expect(lapseWords({ id: "browser.vm", group: "Windows VM", until: now + 90 * 86_400_000 }, now)).toMatch(/^Licence ends /);
    expect(lapseWords({ id: "frameio.signin", group: "Frame.io", until: now + 9 * 86_400_000 }, now)).toMatch(/^Sign-in ends /);
  });
});
