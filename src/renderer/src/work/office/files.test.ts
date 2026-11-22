import { describe, expect, it } from "vitest";
import { teamsPlaceKey, type TeamsLibrary, type TeamsPlace } from "@shared/contract-work-office";
import { appVerb, crumbsOf, filesNote, openWay, partsOf, pathIn, placeGroups, placeOf, rowOf, showsHeading, unreachable, type HostRead, type NoteInput, type ShownLibrary } from "./files";

const lib = (over: Partial<ShownLibrary> & Pick<TeamsLibrary, "id" | "path" | "team" | "kind">): ShownLibrary => ({ host: "env_mac", library: null, tenant: "Purdue University", channels: [], web: null, found: true, env: "local", ...over });
const esports = lib({ id: "m~1", path: "/c/S/Purdue Esports - Documents", team: "Purdue Esports", kind: "channels", channels: ["Events", "General"] });
const policies = lib({ id: "m~2", path: "/c/S/RecWell - Site Policies", team: "RecWell", library: "Site Policies", kind: "library" });
const mine = lib({ id: "m~3", path: "/c/OneDrive-Purdue University", team: "My files", kind: "mine" });
// His Mac syncs folders of one RecWell library one by one; the VM syncs the whole library.
const macTeam = lib({ id: "m~4", path: "/c/OneDrive-purdue.edu-RecWell-TeamRecWell", team: "RecWell-TeamRecWell", kind: "library", tenant: "purdue.edu" });
const macSport = lib({ id: "m~5", path: "/c/OneDrive-purdue.edu-RecWell-SportPrograms", team: "RecWell-SportPrograms", kind: "library", tenant: "purdue.edu" });
const vmRecwell = lib({ id: "b~1", host: "env_box", env: "box", vm: true, path: "C:\\Users\\tcuser\\Purdue University\\RecWell - Documents", team: "RecWell", kind: "channels", channels: ["Team RecWell", "Sport Programs", "AI Task Force"] });
const vmMine = lib({ id: "b~2", host: "env_box", env: "box", vm: true, path: "C:\\Users\\tcuser\\OneDrive - Purdue University", team: "My files", kind: "mine" });

const rowsOf = (libraries: ShownLibrary[], ws = "box") => placeGroups(libraries, ws).map((g) => [g.name, g.rows.map((r) => [r.label, r.copies.map((c) => c.folder)])]);

describe("the Files view's rows", () => {
  it("reads libraries as teams with their channels, his own files last", () => {
    expect(rowsOf([mine, policies, esports])).toEqual([
      ["Purdue Esports", [["Events", ["/c/S/Purdue Esports - Documents/Events"]], ["General", ["/c/S/Purdue Esports - Documents/General"]]]],
      ["RecWell", [["Site Policies", ["/c/S/RecWell - Site Policies"]]]],
      ["", [["My files", ["/c/OneDrive-Purdue University"]]]],
    ]);
  });

  it("shows a library OneDrive named in one word as one row by that name, with no heading saying it again", () => {
    const [group] = placeGroups([macTeam], "local");
    expect(group!.rows.map((r) => r.label)).toEqual(["RecWell-TeamRecWell"]);
    expect(showsHeading(group!)).toBe(false);
    expect(showsHeading(placeGroups([esports], "local")[0]!)).toBe(true);
  });

  it("gives a team with no channel folders its Documents row", () => {
    expect(placeGroups([{ ...esports, channels: [] }], "local")[0]!.rows.map((r) => r.label)).toEqual(["Documents"]);
  });

  it("keys a place as either layout names it", () => {
    expect(teamsPlaceKey("RecWell-TeamRecWell")).toBe(teamsPlaceKey("RecWell", "Team RecWell"));
    expect(teamsPlaceKey("Purdue Esports", "Shared Documents")).toBe(teamsPlaceKey("Purdue Esports"));
  });

  it("shows a place the Mac and the VM both hold once, under the VM's team, the workspace's own copy first", () => {
    expect(rowsOf([macTeam, macSport, mine, vmRecwell, vmMine])).toEqual([
      [
        "RecWell",
        [
          ["Team RecWell", [`${vmRecwell.path}\\Team RecWell`, macTeam.path]],
          ["Sport Programs", [`${vmRecwell.path}\\Sport Programs`, macSport.path]],
          ["AI Task Force", [`${vmRecwell.path}\\AI Task Force`]],
        ],
      ],
      ["", [["My files", [vmMine.path, mine.path]]]],
    ]);
  });

  it("reads a desktop's copy first while the VM's place is not answering, and never merges folders he added", () => {
    const [group] = placeGroups([vmRecwell, macTeam], "box", (l) => !l.vm);
    expect(group!.rows[0]!.copies.map((c) => c.library.id)).toEqual(["m~4", "b~1"]);
    const added = lib({ id: "m~9", path: "/x/Budgets", team: "Budgets", kind: "folder" });
    expect(placeGroups([added, { ...added, id: "b~9", env: "box" }], "box")[0]!.rows).toHaveLength(2);
  });

  it("carries a folder across copies as its parts below the place's top, joined with each copy's own separator", () => {
    const parts = partsOf(macTeam.path, `${macTeam.path}/Operations/2026`);
    expect(parts).toEqual(["Operations", "2026"]);
    expect(pathIn(`${vmRecwell.path}\\Team RecWell`, parts)).toBe(`${vmRecwell.path}\\Team RecWell\\Operations\\2026`);
    expect(partsOf(`${vmRecwell.path}\\Team RecWell`, `${vmRecwell.path}\\Team RecWell\\Operations\\2026`)).toEqual(parts);
  });

  it("crumbs a folder from its place down, and places a hit in its team, place and folders", () => {
    const row = placeGroups([esports], "local")[0]!.rows[1]!;
    expect(crumbsOf(row, ["Budgets"])).toEqual([
      { label: "General", parts: [] },
      { label: "Budgets", parts: ["Budgets"] },
    ]);
    expect(placeOf(row, ["Budgets", "Q1.xlsx"])).toBe("Purdue Esports/General/Budgets");
  });

  it("finds the row and copy a hit lies in, under either separator", () => {
    const rows = placeGroups([macTeam, vmRecwell], "box").flatMap((g) => g.rows);
    expect(rowOf(rows, "b~1", `${vmRecwell.path}\\Team RecWell\\Ops\\a.pdf`)).toMatchObject({ row: { label: "Team RecWell" }, parts: ["Ops", "a.pdf"] });
    expect(rowOf(rows, "m~4", `${macTeam.path}/Ops/a.pdf`)).toMatchObject({ row: { label: "Team RecWell" }, parts: ["Ops", "a.pdf"] });
    expect(rowOf(rows, "b~1", `${vmRecwell.path}\\Team RecWellish\\a.pdf`)).toBeNull();
  });

  it("asks the next copy only when a machine is out of reach", () => {
    expect(unreachable(Object.assign(new Error("not connected"), { name: "ConnectionLostError" }))).toBe(true);
    expect(unreachable(new Error("work.office.filesList timed out after 120 s"))).toBe(true);
    expect(unreachable(new Error("the Windows VM could not wake"))).toBe(true);
    expect(unreachable(new Error("that file lies outside every library"))).toBe(false);
  });
});

describe("where a file opens", () => {
  it("in the canvas on the file's own host, from a copy he allowed, else in its app", () => {
    const pdf = { name: "R.pdf", path: "/c/R.pdf", kind: "pdf" as const };
    expect(openWay(pdf, esports, "local", false)).toBe("canvas");
    expect(openWay(pdf, esports, "env_box", false)).toBe("app");
    expect(openWay(pdf, esports, "env_box", true)).toBe("copy");
    expect(openWay({ name: "n.txt", path: "/c/n.txt", kind: "text" }, esports, "local", true)).toBe("app");
  });

  it("a file in the VM never in the canvas on its own host: as a copy he allowed, else in its app there", () => {
    const pdf = { name: "R.pdf", path: "C:\\R.pdf", kind: "pdf" as const };
    expect(openWay(pdf, vmRecwell, "box", true)).toBe("copy");
    expect(openWay(pdf, vmRecwell, "box", false)).toBe("app");
  });

  it("names the app a file opens in", () => {
    expect(appVerb({ name: "B.xlsx", kind: "workbook" })).toBe("Open in Excel");
    expect(appVerb({ name: "D.pptx", kind: "deck" })).toBe("Open in PowerPoint");
    expect(appVerb({ name: "list.csv", kind: "workbook" })).toBe("Open in the app");
  });
});

describe("what the view says when Teams files are missing", () => {
  const vm = (state: TeamsPlace["state"]): TeamsPlace => ({ kind: "vm", state, account: null });
  const folders = (state: TeamsPlace["state"]): TeamsPlace => ({ kind: "folders", state, account: null });
  const box = (places?: TeamsPlace[]): HostRead => ({ env: "box", name: "The box", desktop: false, answer: { host: "env_box", libraries: [], roots: [], off: [], ...(places ? { places } : {}) } });
  const mac = (places?: TeamsPlace[]): HostRead => ({ env: "local", name: "MacBook", desktop: true, answer: { host: "env_mac", libraries: [], roots: [], off: [], ...(places ? { places } : {}) } });
  const asleep: HostRead = { env: "local", name: "MacBook", desktop: true, failed: { words: "not connected", unreachable: true } };
  const note = (over: Partial<NoteInput>) => filesNote({ workspaceEnv: "box", reads: [box()], windowsVm: false, notAllowed: [], listed: [], ...over });
  const listed = placeGroups([esports], "box").flatMap((g) => g.rows);

  it("a: it may use no computer yet: names them, and one press allows them", () => {
    expect(note({ reads: [box([folders("no-onedrive"), vm("ok")])], notAllowed: ["MacBook"] })).toEqual({
      title: "This workspace can't use your computers yet",
      line: "Allow MacBook and the Windows VM to list your Teams files.",
      fix: { kind: "allow", vm: true },
    });
    expect(note({ reads: [box([vm("not-set-up")])], notAllowed: ["MacBook"] })?.fix).toEqual({ kind: "allow", vm: false });
  });

  it("b: a machine it may use did not answer: which, with Retry", () => {
    expect(note({ reads: [box(), asleep] })).toEqual({ title: "MacBook did not answer", fix: { kind: "retry" }, away: true });
  });

  it("c: the VM signed out offers its sign-in; the VM not set up, with no other place, points to Settings", () => {
    expect(note({ windowsVm: true, reads: [box([vm("signed-out")])] })).toEqual({ title: "OneDrive on the Windows VM is signed out", fix: { kind: "sign-in", env: "box" } });
    expect(note({ windowsVm: true, reads: [box([vm("not-set-up")])] })).toEqual({ title: "The Windows VM is not set up", fix: { kind: "settings" } });
    expect(note({ windowsVm: true, reads: [box([vm("not-set-up")]), mac([folders("no-libraries")])] })?.title).toBe("No Teams files on MacBook");
  });

  it("d: a place answers with no Teams library: the old advice, naming the machine", () => {
    expect(note({ reads: [box(), mac([folders("no-libraries")])] })).toEqual({ title: "No Teams files on MacBook", line: "Sync a channel from Teams with OneDrive there." });
    expect(note({ reads: [box(), mac([folders("no-onedrive")])] })?.title).toBe("OneDrive is not signed in on MacBook");
    expect(note({ windowsVm: true, reads: [box([vm("no-libraries")])] })?.fix).toEqual({ kind: "open-vm", env: "box" });
  });

  it("e: Work or the pillar refused: its own words", () => {
    const refused: HostRead = { env: "box", name: "The box", desktop: false, failed: { words: "Work is off on this host", unreachable: false } };
    expect(note({ reads: [refused], notAllowed: ["MacBook"] })).toEqual({ title: "Files did not load", line: "Work is off on this host", fix: { kind: "retry" } });
  });

  it("an older host that says nothing of its places: no Teams files, and nothing about places", () => {
    expect(note({ reads: [box(), mac()] })).toEqual({ title: "No Teams files" });
  });

  it("with rows listed: one quiet line for a place that needs him, the machine that did not answer unsaid while the VM holds copies", () => {
    expect(note({ listed, windowsVm: true, reads: [box([vm("signed-out")]), mac([folders("ok")])] })?.title).toBe("OneDrive on the Windows VM is signed out");
    expect(note({ listed, reads: [box(), asleep] })?.away).toBe(true);
    const fromVm = placeGroups([vmRecwell], "box").flatMap((g) => g.rows);
    expect(note({ listed: fromVm, windowsVm: true, reads: [box([vm("ok")]), asleep] })).toBeNull();
    expect(note({ listed, reads: [box(), mac([folders("ok")])] })).toBeNull();
  });
});
