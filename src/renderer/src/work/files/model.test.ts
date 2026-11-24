import { describe, expect, it } from "vitest";
import { sideWidth } from "./SideFile";
import type { FileSearchFilter, FilesPlaces, FileTab } from "@shared/contract-work-files";
import type { MenuRow } from "../../chrome/menuRows";
import type { TeamsLibrariesAnswer, TeamsLibrary } from "@shared/contract-work-office";
import type { FileEntry, FilePlace } from "@shared/work/files";
import {
  appVerb,
  clampDock,
  DOCK,
  dockMost,
  dockShape,
  sidebarFolds,
  entryFromOld,
  NO_HISTORY,
  openWay,
  placeDown,
  placeNote,
  placeOfRef,
  placesFromOld,
  readCopy,
  selectedAfter,
  sidebarOf,
  teamEntries,
  teamOfPage,
  teamPage,
  teamsNote,
  trailFromOld,
  trailOf,
  unknownMethod,
  wentBack,
  wentForward,
  wentTo,
  type HostRead,
  type PlaceCopy,
  dateGroup,
  factOf,
  gridStep,
  groupEntries,
  groupHeads,
  tilesAcross,
  actsFor,
  doneWords,
  NOTHING_PICKED,
  pick,
  pickAll,
  pickedAmong,
  refusedWords,
  stemEnd,
  whereWords,
  HOME_PAGE,
  isHomePage,
  isSearchPage,
  savedIdOf,
  savedSearchPage,
  searchPage
} from "./model";
import { goToRows } from "./GoTo";
import { filterChoices, kindsWords, moreCount, moreRows, pickMore, whenOf, whenWords } from "./Home";

/** The Files place's own rules in the window (model.ts). Dummy names only. */

const place = (over: Partial<FilePlace> & Pick<FilePlace, "id" | "kind" | "name">): FilePlace => ({ host: "", env: "env_box", shared: over.kind === "teams" || over.kind === "onedrive", can: [], state: { state: "ok" }, root: { at: "place", id: over.id }, ...over });
const lib = (id: string, name: string, group: string, key: string, path: string, over: Partial<FilePlace> = {}): FilePlace => place({ id, kind: "teams", name, group, key, root: { at: "file", host: over.env ?? "env_box", path }, ...over });
const answer = (host: string, places: FilePlace[], sources: FilesPlaces["sources"] = []): FilesPlaces => ({ host, places, rev: 0, sources });
const read = (link: string, name: string, places: FilePlace[], over: Partial<HostRead> = {}): HostRead => ({ link, name, desktop: link !== "box", wire: "files", answer: answer(`env_${link}`, places), ...over });

const BOX = read("box", "The box", [
  place({ id: "recent", kind: "recent", name: "Recent" }),
  place({ id: "starred", kind: "starred", name: "Starred" }),
  place({ id: "folder", kind: "folder", name: "Dummy Esports", root: { at: "file", host: "env_box", path: "/w" } }),
  lib("b1/Events", "Events", "Esports Staff", "esportsstaffevents", "C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents\\Events", { vm: true, host: "Windows VM" }),
  lib("b1/General", "General", "Esports Staff", "esportsstaffgeneral", "C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents\\General", { vm: true, host: "Windows VM" }),
  lib("b2", "Team RecWell", "RecWell", "recwellteamrecwell", "C:\\Users\\tcuser\\Dummy U\\RecWell - Team RecWell", { vm: true, host: "Windows VM" }),
]);
const MAC = read("local", "MacBook", [
  lib("m1", "General", "Esports Staff", "esportsstaffgeneral", "/Users/l/Cloud/Esports Staff - Documents/General", { env: "env_mac" }),
  lib("m2", "RecWell-TeamRecWell", "RecWell-TeamRecWell", "recwellteamrecwell", "/Users/l/Cloud/OneDrive-dummy-RecWell-TeamRecWell", { env: "env_mac" }),
  place({ id: "m3", kind: "onedrive", name: "My OneDrive", key: "mine", env: "env_mac", root: { at: "file", host: "env_mac", path: "/Users/l/Cloud/OneDrive-dummy" } }),
]);

describe("the sidebar", () => {
  const sidebar = sidebarOf([BOX, MAC], "box");

  it("takes his marks and the folder from the workspace's own host", () => {
    expect(sidebar.marks.map((m) => m.place.name)).toEqual(["Recent", "Starred"]);
    expect(sidebar.folder?.place.name).toBe("Dummy Esports");
    expect(sidebarOf([MAC], "box").folder).toBeNull();
  });

  it("draws a place two computers hold once, its copy on the workspace's host first while it answers", () => {
    const general = sidebar.rows.find((r) => r.key === "esportsstaffgeneral")!;
    expect(general.copies.map((c) => [c.link, c.host])).toEqual([["box", "Windows VM"], ["local", "MacBook"]]);
    expect(readCopy(general).link).toBe("box");
    // The VM asleep still lists what it kept: it stays first.
    const asleep = sidebarOf([{ ...BOX, answer: answer("env_box", BOX.answer!.places.map((p) => (p.vm ? { ...p, state: { state: "asleep" as const, at: 5 } } : p))) }, MAC], "box");
    expect(readCopy(asleep.rows.find((r) => r.key === "esportsstaffgeneral")!).link).toBe("box");
    // Signed out, the desktop's copy answers for the place.
    const out = sidebarOf([{ ...BOX, answer: answer("env_box", BOX.answer!.places.map((p) => (p.vm ? { ...p, state: { state: "signed-out" as const } } : p))) }, MAC], "box");
    const row = out.rows.find((r) => r.key === "esportsstaffgeneral")!;
    expect(row.copies.map((c) => c.link)).toEqual(["local", "box"]);
    expect(readCopy(row).link).toBe("local");
  });

  it("names a merged place by the copy that names its team apart", () => {
    const recwell = sidebar.rows.find((r) => r.key === "recwellteamrecwell")!;
    expect([recwell.name, recwell.group]).toEqual(["Team RecWell", "RecWell"]);
  });

  it("makes a team with several channels one row, a library known by one name its own row, and his own files last", () => {
    expect(sidebar.places.map((p) => (p.is === "team" ? `team ${p.name}: ${p.rows.map((r) => r.name).join(", ")}` : `place ${p.row.name}`))).toEqual([
      "team Esports Staff: Events, General",
      "team RecWell: Team RecWell",
      "place My OneDrive",
    ]);
    const one = sidebarOf([read("box", "The box", [lib("x", "Scans", "Scans", "folder:x", "/scans")])], "box");
    expect(one.places).toMatchObject([{ is: "place", row: { name: "Scans" } }]);
  });

  it("greys a place none of whose copies answers", () => {
    const down = sidebarOf([read("box", "The box", [lib("x", "General", "T", "tgeneral", "/x", { state: { state: "unreachable" } })])], "box");
    expect(placeDown(down.rows[0]!)).toBe(true);
    expect(placeDown(sidebar.rows[0]!)).toBe(false);
  });
});

describe("a team's page and the trail", () => {
  const sidebar = sidebarOf([BOX, MAC], "box");
  it("lists a team's channels as folders, read from no host", () => {
    const team = sidebar.places.find((p) => p.is === "team" && p.name === "Esports Staff");
    const entries = teamEntries(team!.is === "team" ? team!.rows : []);
    expect(entries.map((e) => [e.name, e.kind, e.ref])).toEqual([["Events", "folder", null], ["General", "folder", null]]);
    expect(entries[1]!.folder).toEqual({ at: "file", host: "env_box", path: "C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents\\General" });
    expect(teamOfPage(teamPage("Esports Staff").at)).toBe("Esports Staff");
    expect(teamOfPage({ at: "place", id: "folder" })).toBeNull();
  });

  it("finds the place a folder lies in by the longest top that holds it, case-blind in the VM", () => {
    const deep = placeOfRef(sidebar, { at: "file", host: "env_box", path: "c:\\users\\tcuser\\dummy u\\esports staff - documents\\general\\Budgets" });
    expect(deep?.row?.key).toBe("esportsstaffgeneral");
    expect(deep?.copy.link).toBe("box");
    expect(placeOfRef(sidebar, { at: "file", host: "env_mac", path: "/Users/l/Cloud/Esports Staff - Documents/General/Budgets" })?.copy.link).toBe("local");
    expect(placeOfRef(sidebar, { at: "file", host: "env_box", path: "/w/Events" })?.copy.place.kind).toBe("folder");
    expect(placeOfRef(sidebar, { at: "place", id: "starred" })?.copy.place.kind).toBe("starred");
    expect(placeOfRef(sidebar, { at: "file", host: "env_box", path: "/elsewhere" })).toBeNull();
    // A folder whose name only starts like a place's top is not in it.
    expect(placeOfRef(sidebar, { at: "file", host: "env_box", path: "/www" })).toBeNull();
  });

  it("leads a channel's trail with its team, and leaves a place known by one name as it is", () => {
    const general = sidebar.rows.find((r) => r.key === "esportsstaffgeneral")!;
    const trail = [{ name: "General", at: general.copies[0]!.place.root }];
    expect(trailOf(general, trail).map((c) => c.name)).toEqual(["Esports Staff", "General"]);
    expect(trailOf(null, trail).map((c) => c.name)).toEqual(["General"]);
    expect(trailOf({ ...general, group: "General" }, trail).map((c) => c.name)).toEqual(["General"]);
  });
});

describe("where a file opens", () => {
  const ws = { link: "box", tabs: true, copy: true };
  const folder = { link: "box", wire: "files" as const, place: place({ id: "folder", kind: "folder", name: "W" }) };
  const here = { link: "box", wire: "files" as const, place: lib("b", "General", "T", "k", "/c/General") };
  const vm = { link: "box", wire: "files" as const, place: lib("v", "General", "T", "k", "C:\\x", { vm: true }) };
  const far = { link: "local", wire: "files" as const, place: lib("m", "General", "T", "k", "/m/General", { env: "env_mac" }) };
  const f = (name: string) => ({ name, kind: "other" as const });

  it("opens every file of the workspace's host in a tab, and in its app only what a library's own app shows", () => {
    expect(openWay(f("Budget.xlsx"), folder, ws)).toBe("tab");
    expect(openWay(f("Plan.docx"), here, ws)).toBe("tab");
    expect(openWay(f("notes.txt"), folder, ws)).toBe("tab");
    // What has no viewer of its own still opens: the file kind shows its facts.
    expect(openWay(f("bundle.zip"), folder, ws)).toBe("tab");
    expect(openWay(f("macro.xlsb"), folder, ws)).toBe("tab");
    // An old Office form the sheet kind does not read has its app behind it in a library on the workspace's own host.
    expect(openWay(f("macro.xlsb"), here, ws)).toBe("tab");
    expect(openWay(f("macro.xlsb"), far, ws)).toBe("app");
    // An .xls is the sheet kind's, as an .xlsx is: it opens in a tab wherever an .xlsx would.
    for (const place of [folder, here, far]) expect(openWay(f("old.xls"), place, ws)).toBe(openWay(f("Budget.xlsx"), place, ws));
    // Text in a library is the file it is; a library's sound waits for its player, in its app.
    expect(openWay(f("notes.txt"), here, ws)).toBe("tab");
    expect(openWay(f("call.m4a"), here, ws)).toBe("app");
  });

  it("brings a file of another computer, or of the VM, as a copy only where he allowed one", () => {
    expect(openWay(f("Deck.pdf"), far, ws)).toBe("tab");
    expect(openWay(f("Deck.pdf"), vm, ws)).toBe("tab");
    expect(openWay(f("Deck.pdf"), far, { ...ws, copy: false })).toBe("app");
    expect(openWay(f("Deck.pdf"), vm, { ...ws, copy: false })).toBe("app");
  });

  it("opens in its own app, never in a thread he did not ask for, for a workspace whose host keeps no tabs", () => {
    for (const place of [here, far, vm]) for (const name of ["Plan.docx", "Deck.pdf", "bundle.zip"]) expect(openWay(f(name), place, { ...ws, tabs: false })).toBe("app");
  });

  it("names a file's own app", () => {
    expect([{ name: "a.xlsx", kind: "sheet" as const }, { name: "a.csv", kind: "sheet" as const }, { name: "a.docx", kind: "document" as const }, { name: "a.pptx", kind: "deck" as const }, { name: "a.zip", kind: "archive" as const }].map(appVerb)).toEqual([
      "Open in Excel",
      "Open in its app",
      "Open in Word",
      "Open in PowerPoint",
      "Open in its app",
    ]);
  });
});

describe("a host a release behind", () => {
  const library: TeamsLibrary = { id: "old~1", host: "env_old", path: "/c/Team - Documents", team: "Team", library: null, tenant: "Dummy U", kind: "channels", channels: ["General"], web: null, found: true };
  const old: TeamsLibrariesAnswer = { host: "env_old", libraries: [library, { ...library, id: "old~vm", path: "C:\\t\\Team - Documents", vm: true }], roots: [], off: [], places: [{ kind: "vm", state: "signed-out", account: null }] };

  it("tells an unknown method from a machine that is away", () => {
    expect(unknownMethod(new Error("unknown method: work.files.places"))).toBe(true);
    expect(unknownMethod(new Error("not built: work.files.places (milestone 54)"))).toBe(true);
    expect(unknownMethod(new Error("request timed out"))).toBe(false);
    expect(unknownMethod(new Error("not connected"))).toBe(false);
    expect(unknownMethod(new Error("Work is off on this host"))).toBe(false);
  });

  it("reads its libraries as the places the new wire would say, with no tabs and no marks", () => {
    const { places, libraries } = placesFromOld(old);
    expect(places.places.map((p) => [p.kind, p.name, p.group, p.key, p.state.state])).toEqual([["teams", "General", "Team", "teamgeneral", "ok"], ["teams", "General", "Team", "teamgeneral", "signed-out"]]);
    expect(places.rev).toBe(0);
    expect(places.sources).toEqual(old.places);
    expect(libraries).toHaveLength(2);
  });

  it("keys an old entry as the new wire keys it, and builds the trail the old wire never said", () => {
    const general = placesFromOld(old).places.places[0]!;
    const entry = entryFromOld({ name: "Plan.docx", path: "/c/Team - Documents/General/Budgets/Plan.docx", library: "old~1", kind: "document", size: 9, modified: 5, local: false, by: "Sam" }, general, "env_old");
    expect(entry).toMatchObject({ key: "lib:teamgeneral:Budgets/Plan.docx", kind: "document", local: false, state: { is: "cloud" }, by: "Sam", shared: true, ref: { at: "file", host: "env_old" }, folder: null });
    expect(entryFromOld({ name: "Budgets", path: "/c/Team - Documents/General/Budgets", library: "old~1", kind: "folder", size: 0, modified: 5, local: true, by: null }, general, "env_old")).toMatchObject({ kind: "folder", ref: null, folder: { at: "file", path: "/c/Team - Documents/General/Budgets" } });
    expect(trailFromOld(general, { at: "file", host: "env_old", path: "/c/Team - Documents/General/Budgets/2026" }).map((c) => [c.name, (c.at as { path?: string }).path])).toEqual([
      ["General", "/c/Team - Documents/General"],
      ["Budgets", "/c/Team - Documents/General/Budgets"],
      ["2026", "/c/Team - Documents/General/Budgets/2026"],
    ]);
  });
});

describe("what stands between him and Teams files", () => {
  const none = (over: Partial<Parameters<typeof teamsNote>[0]> = {}) => teamsNote({ workspaceLink: "box", reads: [], windowsVm: false, notAllowed: [], rows: [], ...over });
  const box = (sources: FilesPlaces["sources"], over: Partial<HostRead> = {}): HostRead => ({ link: "box", name: "The box", desktop: false, wire: "files", answer: answer("env_box", [], sources), ...over });
  const mac = (sources: FilesPlaces["sources"], over: Partial<HostRead> = {}): HostRead => ({ link: "local", name: "MacBook", desktop: true, wire: "files", answer: answer("env_mac", [], sources), ...over });

  it("says it may use no computer yet, with Allow, naming what it could use", () => {
    expect(none({ reads: [box([{ kind: "vm", state: "ok", account: "a" }])], notAllowed: ["MacBook"] })).toEqual({
      title: "This workspace can't use your computers yet",
      line: "Allow MacBook and the Windows VM to list your Teams files.",
      fix: { kind: "allow", vm: true },
    });
  });

  it("says a machine did not answer, on the state line, with Retry", () => {
    expect(none({ reads: [box([]), mac([], { answer: undefined, failed: { words: "No answer in 4 s", unreachable: true } })] })).toEqual({ title: "MacBook did not answer", fix: { kind: "retry" }, away: true });
  });

  it("says OneDrive in the VM is signed out, with Sign in; and the VM not set up, with Settings", () => {
    expect(none({ reads: [box([{ kind: "vm", state: "signed-out", account: null }])], windowsVm: true })).toEqual({ title: "OneDrive on the Windows VM is signed out", fix: { kind: "sign-in", link: "box" } });
    expect(none({ reads: [box([{ kind: "vm", state: "not-set-up", account: null }])], windowsVm: true })).toEqual({ title: "The Windows VM is not set up", fix: { kind: "settings" } });
  });

  it("says a place answers with nothing synced, by its name", () => {
    expect(none({ reads: [box([]), mac([{ kind: "folders", state: "no-libraries", account: null }])] })).toEqual({ title: "No Teams files on MacBook", line: "Sync a channel from Teams with OneDrive there." });
    expect(none({ reads: [box([]), mac([{ kind: "folders", state: "no-onedrive", account: null }])] })).toEqual({ title: "OneDrive is not signed in on MacBook", line: "Sign in there, then sync a channel from Teams." });
    expect(none({ reads: [box([{ kind: "vm", state: "no-libraries", account: "a" }])], windowsVm: true })).toMatchObject({ title: "No Teams files on the Windows VM", fix: { kind: "open-vm", link: "box" } });
  });

  it("says the workspace's own host refused in its own words, and nothing where nothing is wrong", () => {
    expect(none({ reads: [box([], { answer: undefined, failed: { words: "Work is off on this host", unreachable: false } })] })).toEqual({ title: "Files did not load", line: "Work is off on this host", fix: { kind: "retry" } });
    expect(none({ reads: [box([])] })).toBeNull();
  });

  it("with places listed, names only one that needs him", () => {
    const rows = sidebarOf([MAC], "box").rows;
    expect(none({ reads: [box([]), MAC], rows })).toBeNull();
    expect(none({ reads: [box([{ kind: "vm", state: "signed-out", account: null }]), MAC], windowsVm: true, rows })).toMatchObject({ title: "OneDrive on the Windows VM is signed out" });
    expect(none({ reads: [box([{ kind: "vm", state: "error", account: null, detail: "The helper did not answer in 30 s" }]), MAC], windowsVm: true, rows })).toEqual({ title: "The Windows VM did not answer", line: "The helper did not answer in 30 s", fix: { kind: "retry" }, away: true });
  });

  it("says each place's own state over its list, in one sentence with its one press", () => {
    const copy = (state: FilePlace["state"], vm = true) => ({ link: "box", host: vm ? "Windows VM" : "MacBook", wire: "files" as const, place: lib("x", "General", "T", "k", "C:\\x", { state, ...(vm ? { vm: true } : {}) }) });
    const clock = (at: number) => `T${at}`;
    expect(placeNote(copy({ state: "ok" }), clock)).toBeNull();
    expect(placeNote(copy({ state: "asleep", at: 140 }), clock)).toEqual({ title: "The Windows VM is asleep", line: "This is the list from T140.", fix: { kind: "wake", link: "box" } });
    expect(placeNote(copy({ state: "signed-out" }), clock)).toEqual({ title: "OneDrive on the Windows VM is signed out", fix: { kind: "sign-in", link: "box" } });
    expect(placeNote(copy({ state: "unreachable" }, false), clock)).toEqual({ title: "MacBook is out of reach", fix: { kind: "retry" }, away: true });
    expect(placeNote(copy({ state: "not-allowed" }, false), clock)).toMatchObject({ title: "This workspace can't use your computers yet", fix: { kind: "allow", vm: false } });
    expect(placeNote(copy({ state: "error", detail: "why" }), clock)).toMatchObject({ title: "The Windows VM did not answer", line: "why", away: true });
    expect(placeNote(copy({ state: "reading" }), clock)).toEqual({ title: "Reading the Windows VM" });
  });
});

describe("tabs", () => {
  const tab = (id: string, opener?: string): FileTab => ({ id, kind: "page", name: id, page: { at: { at: "place", id: "folder" }, name: id }, ...(opener ? { opener } : {}) });
  it("returns to the tab a closed one was opened from, else its neighbour, else the first", () => {
    const prev = [tab("a"), tab("b"), tab("c", "a"), tab("d")];
    expect(selectedAfter(prev, [prev[0]!, prev[1]!, prev[3]!], "c")).toBe("a");
    expect(selectedAfter(prev, [prev[0]!, prev[2]!, prev[3]!], "b")).toBe("c");
    expect(selectedAfter(prev, prev.slice(0, 3), "d")).toBe("c");
    expect(selectedAfter(prev, prev, "b")).toBe("b");
    expect(selectedAfter(prev, [], "b")).toBeNull();
    expect(selectedAfter([], prev, null)).toBe("a");
  });

  it("keeps a tab's Back and Forward: a new step drops Forward", () => {
    const [a, b, c] = ["a", "b", "c"].map((n) => ({ at: { at: "place" as const, id: n }, name: n }));
    let h = wentTo(wentTo(NO_HISTORY, a!), b!);
    const back = wentBack(h, c!)!;
    expect(back.to).toBe(b);
    expect(back.history.forward).toEqual([c]);
    const again = wentForward(back.history, b!)!;
    expect(again.to).toBe(c);
    h = wentTo(back.history, b!);
    expect(h.forward).toEqual([]);
    expect(wentBack(NO_HISTORY, a!)).toBeNull();
    expect(wentForward(NO_HISTORY, a!)).toBeNull();
  });
});

describe("a folder's shapes", () => {
  it("fits as many tiles as the width holds, never fewer than one", () => {
    expect(tilesAcross(800, 160, 4)).toBe(4);
    expect(tilesAcross(163, 160, 4)).toBe(1);
    expect(tilesAcross(40, 160, 4)).toBe(1);
    expect(tilesAcross(328, 160, 8)).toBe(2);
  });

  it("walks a grid with the arrows: one tile sideways, a row up and down, never past either end", () => {
    // Ten tiles, four across: the last row holds two.
    expect(gridStep(-1, 10, 4, "ArrowDown")).toBe(0);
    expect(gridStep(0, 10, 4, "ArrowRight")).toBe(1);
    expect(gridStep(0, 10, 4, "ArrowLeft")).toBe(0);
    expect(gridStep(1, 10, 4, "ArrowDown")).toBe(5);
    expect(gridStep(5, 10, 4, "ArrowUp")).toBe(1);
    expect(gridStep(2, 10, 4, "ArrowUp")).toBe(2);
    // Down from above a short last row lands on its last tile; down from the last row stays.
    expect(gridStep(7, 10, 4, "ArrowDown")).toBe(9);
    expect(gridStep(9, 10, 4, "ArrowDown")).toBe(9);
    expect(gridStep(9, 10, 4, "ArrowRight")).toBe(9);
    expect(gridStep(0, 0, 4, "ArrowRight")).toBe(-1);
  });

  it("says one fact for a tile: its one state in words, else when it changed", () => {
    const when = (at: number): string => `t${at}`;
    expect(factOf({ kind: "sheet", changed: 5 }, when)).toBe("t5");
    expect(factOf({ kind: "sheet", changed: 5, state: { is: "cloud" } }, when)).toBe("In the cloud");
    expect(factOf({ kind: "sheet", state: { is: "suggestions", count: 1 } }, when)).toBe("1 suggestion");
    expect(factOf({ kind: "sheet", state: { is: "suggestions", count: 3 } }, when)).toBe("3 suggestions");
    expect(factOf({ kind: "sheet", state: { is: "present", who: "Dana" } }, when)).toBe("Dana is in it");
    expect(factOf({ kind: "folder" }, when)).toBe("");
  });
});

describe("what is selected", () => {
  const order = ["a", "b", "c", "d", "e"];
  it("takes one on a press, adds or drops one with the modifier, and the run from the last plain pick with Shift", () => {
    let now = pick(NOTHING_PICKED, order, "b", "one");
    expect([[...now.keys], now.cursor, now.anchor]).toEqual([["b"], "b", "b"]);
    now = pick(now, order, "d", "range");
    expect([...now.keys]).toEqual(["b", "c", "d"]);
    // A second Shift press runs from the same anchor, the other way too.
    expect([...pick(now, order, "a", "range").keys]).toEqual(["a", "b"]);
    now = pick(now, order, "e", "toggle");
    expect([...now.keys].sort()).toEqual(["b", "c", "d", "e"]);
    now = pick(now, order, "c", "toggle");
    expect([...now.keys].sort()).toEqual(["b", "d", "e"]);
    // A plain press lets go of the rest.
    expect([...pick(now, order, "a", "one").keys]).toEqual(["a"]);
    // Shift with nothing picked before is a plain press.
    expect([...pick(NOTHING_PICKED, order, "c", "range").keys]).toEqual(["c"]);
  });

  it("takes all, and lets go of rows that are no longer there", () => {
    const all = pickAll(order);
    expect(all.keys.size).toBe(5);
    expect(pickAll([])).toBe(NOTHING_PICKED);
    const left = pickedAmong(all, ["a", "c"]);
    expect([[...left.keys], left.cursor, left.anchor]).toEqual([["a", "c"], null, "a"]);
    // Nothing gone: the same selection, so nothing draws again.
    expect(pickedAmong(all, order)).toBe(all);
  });
});

describe("the verbs for what is selected", () => {
  const all = ["make", "upload", "rename", "move", "copy", "edit", "trash", "restore", "purge"] as const;
  const own = place({ id: "folder", kind: "folder", name: "Dummy Esports", can: [...all] });
  const team = place({ id: "b1", kind: "teams", name: "General", can: ["make", "rename", "move", "copy", "edit"] });
  const file = (name: string, over: Partial<FileEntry> = {}): FileEntry => ({ key: name, ref: { at: "file", host: "h", path: `/w/${name}` }, folder: null, name, kind: "sheet", ...over });
  const dir: FileEntry = { key: "Events", ref: null, folder: { at: "file", host: "h", path: "/w/Events" }, name: "Events", kind: "folder" };
  const labels = (rows: ReturnType<typeof actsFor>): string[] => rows.map((r) => (r.refused ? `${r.label} (off)` : r.label));

  it("offers one file its whole menu in his own place, and a folder Open in New Tab", () => {
    expect(labels(actsFor([file("Budget.xlsx")], own))).toEqual(["Open", "Rename", "Move to…", "Copy to…", "Star", "Delete"]);
    expect(labels(actsFor([dir], own))).toEqual(["Open", "Open in New Tab", "Rename", "Move to…", "Copy to…", "Star", "Delete"]);
    expect(labels(actsFor([file("Budget.xlsx", { starred: true })], own))).toContain("Remove Star");
  });

  it("leaves out for many what only one thing takes", () => {
    expect(labels(actsFor([file("a.xlsx"), file("b.xlsx")], own))).toEqual(["Move to…", "Copy to…", "Star", "Delete"]);
    expect(actsFor([], own)).toEqual([]);
  });

  it("draws a verb off with the place's own sentence where the place refuses it", () => {
    const rows = actsFor([file("Plan.docx", { kind: "document", shared: true })], team);
    expect(labels(rows)).toEqual(["Open", "Open in Word", "Rename", "Move to…", "Copy to…", "Star", "Delete (off)"]);
    expect(rows.find((r) => r.act === "delete")!.refused).toBe("Delete it in Teams.");
    // A thread is writing in it: it cannot be renamed, moved or deleted until it is done.
    const busy = actsFor([file("Budget.xlsx", { state: { is: "writing" } })], own);
    expect(busy.filter((r) => r.refused).map((r) => r.act)).toEqual(["rename", "move", "delete"]);
    // A lens holds nothing of its own.
    const recent = place({ id: "recent", kind: "recent", name: "Recent" });
    expect(actsFor([file("Budget.xlsx")], recent).find((r) => r.act === "rename")!.refused).toBe("Recent only shows files. Change one where it lives.");
  });

  it("offers Put Back and Delete for Good in Trash, and no star where no marks are kept", () => {
    const bin = place({ id: "trash", kind: "trash", name: "Trash", can: ["restore", "purge"] });
    expect(labels(actsFor([file("old.xlsx")], bin))).toEqual(["Put Back", "Delete for Good"]);
    expect(labels(actsFor([file("a.xlsx")], own, { tabs: false }))).not.toContain("Star");
  });

  it("says what a change did and what it could not, in one line each", () => {
    expect(doneWords("Deleted", ["Budget.xlsx"])).toBe("Deleted Budget.xlsx");
    expect(doneWords("Moved", ["a", "b", "c"], "Events")).toBe("Moved 3 things to Events");
    expect(refusedWords([])).toBeNull();
    expect(refusedWords([{ name: "a.txt", text: "A file named \"a.txt\" is already there." }])).toBe('a.txt: A file named "a.txt" is already there.');
    expect(refusedWords([{ name: "a", text: "No." }, { name: "b", text: "No." }, { name: "c", text: "No." }])).toBe("a: No. (and 2 more)");
    expect([stemEnd("Budget.xlsx"), stemEnd("Makefile"), stemEnd(".env"), stemEnd("a.tar.gz")]).toEqual([6, 8, 4, 5]);
    expect(whereWords({ place: "folder", name: "Dummy Esports", trail: ["Events", "Spring LAN"] })).toBe("Dummy Esports › Events › Spring LAN");
  });
});

describe("the chat docked beside a file", () => {
  it("starts at 360px and holds a width between 360 and 720, never leaving the file under 560", () => {
    expect(DOCK.width).toBe(360);
    expect(clampDock(200)).toBe(360);
    expect(clampDock(900)).toBe(720);
    expect(clampDock(Number.NaN)).toBe(360);
    // A body of 1,000px leaves room for a 440px dock at most.
    expect(clampDock(600, 1000)).toBe(440);
    expect(clampDock(400, 1000)).toBe(400);
    expect(dockMost(1000)).toBe(440);
    expect(dockMost(1400)).toBe(720);
    expect(dockMost(800)).toBe(360);
    expect(dockMost()).toBe(720);
  });

  it("lies beside the file while the file keeps 560px, and over the whole body where it would not", () => {
    expect(dockShape(1200, 360)).toEqual({ over: false, width: 360 });
    expect(dockShape(920, 500)).toEqual({ over: false, width: 360 });
    expect(dockShape(919, 360)).toEqual({ over: true });
    expect(dockShape(500, 360)).toEqual({ over: true });
    // Unmeasured, the kept width is drawn beside.
    expect(dockShape(0, 400)).toEqual({ over: false, width: 400 });
  });

  it("folds the sidebar under 640px always, and under 900px only while a chat is docked", () => {
    expect(sidebarFolds(600, false, 640)).toBe(true);
    expect(sidebarFolds(800, false, 640)).toBe(false);
    expect(sidebarFolds(800, true, 640)).toBe(true);
    expect(sidebarFolds(900, true, 640)).toBe(false);
    expect(sidebarFolds(0, true, 640)).toBe(false);
  });
});

describe("Go to, search pages and Home", () => {
  const tab = (id: string, name: string, key?: string): FileTab => ({ id, kind: key ? "file" : "page", name, ...(key ? { key, itemId: `i-${id}` } : { page: { at: { at: "place", id: "folder" }, name } }) });
  const entry = (name: string): FileEntry => ({ key: `k:${name}`, ref: { at: "file", host: "h", path: `/w/${name}` }, folder: null, name, kind: "sheet" });

  it("lists the open tabs that hold every word first, then the host's names, less a file a listed tab already shows", () => {
    const rows = goToRows("bud", [tab("t1", "Events"), tab("t2", "Budget.xlsx", "k:Budget.xlsx")], [entry("Budget.xlsx"), entry("Budget 2027.xlsx")]);
    expect(rows.map((r) => (r.is === "tab" ? `tab ${r.tab.name}` : r.is === "entry" ? r.entry.name : "new"))).toEqual(["tab Budget.xlsx", "Budget 2027.xlsx"]);
    // No words: the recents the host answered, and no tab.
    expect(goToRows("", [tab("t1", "Events")], [entry("a.xlsx")]).map((r) => r.is)).toEqual(["entry"]);
  });

  it("reads words that start with new as a thing to make, and asks for no names", () => {
    expect(goToRows("new sheet called Travel", [tab("t1", "Travel")], [entry("Travel.xlsx")])).toEqual([{ is: "new", what: "sheet", name: "Travel" }]);
    expect(goToRows("New folder", [], [])).toEqual([{ is: "new", what: "folder", name: "" }]);
  });

  it("names a search's page by its words, a saved one by its id, and tells them from a folder", () => {
    const found = searchPage("spring budget");
    expect(found).toEqual({ at: { at: "place", id: "search" }, name: "Search: spring budget", query: "spring budget" });
    const kept = savedSearchPage({ id: "s1", name: "Budgets", query: "budget" });
    expect(kept.at).toEqual({ at: "place", id: "search:s1" });
    expect([isSearchPage(found.at), isSearchPage(kept.at), isSearchPage({ at: "place", id: "folder" }), isSearchPage({ at: "file", host: "h", path: "/search" })]).toEqual([true, true, false, false]);
    expect([savedIdOf(found.at), savedIdOf(kept.at)]).toEqual([null, "s1"]);
    expect([isHomePage(HOME_PAGE.at), isHomePage(found.at)]).toEqual([true, false]);
  });

  it("says a filter on its button and reads which When row a filter stands on: a span by its word, fixed times as dates", () => {
    expect([kindsWords(undefined), kindsWords(["sheet"]), kindsWords(["sheet", "pdf"])]).toEqual(["Kind", "Sheet", "2 kinds"]);
    expect([whenOf({}), whenOf({ within: "day" }), whenOf({ within: "quarter" }), whenOf({ after: 5 }), whenOf({ before: 5 })]).toEqual(["any", "day", "quarter", "dates", "dates"]);
    expect([whenWords({}), whenWords({ within: "week" }), whenWords({ within: "year" })]).toEqual(["Any time", "Past 7 days", "Past year"]);
    const day = new Date(2026, 9, 3).getTime();
    expect(whenWords({ after: day })).toMatch(/^Since .*2026$/);
    expect(whenWords({ after: day, before: day })).toMatch(/ to /);
  });

  it("offers in More the places and projects the search reads, and whatever a saved search already holds", () => {
    const copy = (id: string, name: string, link = "box"): PlaceCopy => ({ place: { id, kind: "folder", name, host: "", env: link, shared: false, can: [], state: { state: "ok" }, root: { at: "place", id } }, link, host: "The box", wire: "files" });
    const choices = filterChoices(
      { folder: copy("folder", "Dummy Esports"), lifeos: copy("lifeos", "LifeOS"), drives: [], rows: [{ key: "k", name: "General", group: "Staff", kind: "teams", copies: [copy("mac~1", "General", "mac"), copy("box~2", "General")] }], projects: [copy("project:p1", "Spring LAN")] },
      "box",
    );
    expect(choices).toEqual({ places: [{ id: "folder", name: "Dummy Esports" }, { id: "lifeos", name: "LifeOS" }, { id: "box~2", name: "General" }], projects: [{ id: "p1", name: "Spring LAN" }] });
    const labels = (rows: MenuRow[]): unknown => rows.map((r) => (r.kind === "sub" ? [r.label, r.items.map((i) => (i.kind === "item" ? `${i.label}${i.checked ? " ✓" : ""}` : i.kind))] : r.kind === "item" ? `${r.label}${r.checked ? " ✓" : ""}` : r.kind));
    expect(labels(moreRows({}, choices))).toEqual([
      ["Place", ["Dummy Esports", "LifeOS", "General"]],
      ["Project", ["Spring LAN"]],
      ["Changed by", ["Anyone ✓", "Me", "An agent"]],
      "Needs review",
    ]);
    // A saved search's own parts are rows of their own, so every part set can be seen and cleared.
    expect(labels(moreRows({ places: ["gone"], project: "p9", who: "Dana", review: true }, choices))).toEqual([
      ["Place", ["Dummy Esports", "LifeOS", "General", "A place no longer listed ✓"]],
      ["Project", ["Spring LAN", "A project no longer listed ✓"]],
      ["Changed by", ["Anyone", "Me", "An agent", "Dana ✓"]],
      "Needs review ✓",
      "sep",
      "Clear",
    ]);
  });

  it("picks in More: a place toggles, a project and who are one at a time, Clear takes More's parts alone", () => {
    let f: FileSearchFilter = { kinds: ["pdf"], within: "week" };
    f = pickMore(f, "place:lifeos");
    f = pickMore(f, "place:folder");
    f = pickMore(f, "project:p1");
    f = pickMore(f, "who:me");
    f = pickMore(f, "review");
    expect(f).toEqual({ kinds: ["pdf"], within: "week", places: ["lifeos", "folder"], project: "p1", who: "me", review: true });
    expect(moreCount(f)).toBe(4);
    expect(pickMore(pickMore(pickMore(f, "place:lifeos"), "project:p1"), "who:")).toEqual({ kinds: ["pdf"], within: "week", places: ["folder"], who: undefined, review: true });
    expect(pickMore(f, "clear")).toEqual({ kinds: ["pdf"], within: "week" });
  });
});

describe("a folder's rows under headings", () => {
  const now = new Date(2026, 10, 23, 14, 0).getTime();
  const DAY = 86_400_000;
  const row = (name: string, kind: FileEntry["kind"], changed?: number, where?: FileEntry["where"]): FileEntry => ({ key: `k:${name}`, ref: kind === "folder" ? null : { at: "file", host: "h", path: `/w/${name}` }, folder: kind === "folder" ? { at: "file", host: "h", path: `/w/${name}` } : null, name, kind, ...(changed ? { changed } : {}), ...(where ? { where } : {}) });

  it("says which heading a change time falls under", () => {
    expect([dateGroup(now - 1000, now), dateGroup(now - 2 * DAY, now), dateGroup(now - 20 * DAY, now), dateGroup(new Date(2024, 3, 2).getTime(), now), dateGroup(undefined, now)]).toEqual(["Today", "Past 7 days", "Past 30 days", "2024", "No date"]);
  });

  it("groups by kind with folders first and the rest by the kind's name, each group in the order its rows came", () => {
    const groups = groupEntries([row("b.xlsx", "sheet"), row("Events", "folder"), row("a.pdf", "pdf"), row("a.xlsx", "sheet"), row("Art", "folder")], "kind", now);
    expect(groups.map((g) => [g.title, g.entries.map((e) => e.name)])).toEqual([
      ["Folders", ["Events", "Art"]],
      ["PDFs", ["a.pdf"]],
      ["Sheets", ["b.xlsx", "a.xlsx"]],
    ]);
    expect([...groupHeads(groups)]).toEqual([
      [0, "Folders"],
      [2, "PDFs"],
      [3, "Sheets"],
    ]);
  });

  it("groups by date in the order the rows came, and by where each lives in a lens", () => {
    expect(groupEntries([row("new.txt", "text", now - 1000), row("old.txt", "text", now - 400 * DAY), row("mid.txt", "text", now - 3 * DAY), row("newer.txt", "text", now - 5000)], "date", now).map((g) => [g.title, g.entries.length])).toEqual([
      ["Today", 2],
      ["2025", 1],
      ["Past 7 days", 1],
    ]);
    const where = { place: "p1", name: "Esports Staff", trail: ["Events"] };
    expect(groupEntries([row("a.txt", "text", now, where), row("b.txt", "text", now)], "place", now).map((g) => g.title)).toEqual(["Esports Staff, Events", "Here"]);
  });
});

describe("two files in one tab", () => {
  it("offers Open to the Side for a file while a file tab can take it, never for a folder", () => {
    const file: FileEntry = { key: "k:a", ref: { at: "file", host: "h", path: "/w/a.txt" }, folder: null, name: "a.txt", kind: "text" };
    const folder: FileEntry = { key: "k:d", ref: null, folder: { at: "file", host: "h", path: "/w/d" }, name: "d", kind: "folder" };
    const place = { id: "folder", kind: "folder", name: "W", can: ["rename", "move", "copy", "trash"], state: { state: "ok" }, shared: false } as unknown as FilePlace;
    expect(actsFor([file], place, { tabs: true, side: true }).map((r) => r.act).slice(0, 2)).toEqual(["open", "open-side"]);
    expect(actsFor([file], place, { tabs: true }).map((r) => r.act)).not.toContain("open-side");
    expect(actsFor([folder], place, { tabs: true, side: true }).map((r) => r.act)).not.toContain("open-side");
    expect(actsFor([file, folder], place, { tabs: true, side: true }).map((r) => r.act)).not.toContain("open-side");
  });

  it("gives each half at least 320px, half each to start, and no side by side where there is no room for two", () => {
    expect([sideWidth(1000, null), sideWidth(1000, 900), sideWidth(1000, 100), sideWidth(639, null), sideWidth(0, null)]).toEqual([500, 680, 320, 0, 0]);
  });
});

describe("a row of a lens or of a search's results", () => {
  it("offers Show in Its Folder where the page can show it and the row says where it lives", () => {
    const place = { id: "recent", kind: "recent", name: "Recent", can: [], state: { state: "ok" }, shared: false } as unknown as FilePlace;
    const found: FileEntry = { key: "k:a", ref: { at: "file", host: "h", path: "/w/Events/a.txt" }, folder: null, name: "a.txt", kind: "text", where: { place: "folder", name: "Dummy Esports", trail: ["Events"] } };
    expect(actsFor([found], place, { tabs: true, reveal: true }).map((r) => r.act)).toContain("reveal");
    expect(actsFor([found], place, { tabs: true }).map((r) => r.act)).not.toContain("reveal");
    expect(actsFor([{ ...found, where: undefined }], place, { tabs: true, reveal: true }).map((r) => r.act)).not.toContain("reveal");
  });
});

describe("LifeOS, projects, Drive and From mail", () => {
  const lens = (id: string, kind: FilePlace["kind"], name: string, root: FilePlace["root"] = { at: "place", id }, more: Partial<FilePlace> = {}): FilePlace => ({ id, kind, name, host: "", env: "env_box", shared: false, can: [], state: { state: "ok" }, root, ...more }) as FilePlace;
  const read: HostRead = {
    link: "box",
    name: "The box",
    desktop: false,
    wire: "files",
    answer: {
      host: "env_box",
      rev: 1,
      sources: [],
      places: [
        lens("folder", "folder", "Dummy Esports", { at: "file", host: "env_box", path: "/w" }),
        lens("lifeos", "lifeos", "LifeOS"),
        lens("project:p1", "project", "Spring LAN", { at: "project", id: "p1" }),
        lens("project:p2", "project", "Nationals", { at: "project", id: "p2" }),
        lens("drive:me@dummy.edu", "drive", "me@dummy.edu", { at: "drive", account: "me@dummy.edu", folderId: "root" }),
        lens("mail", "mail", "From mail", undefined, { count: 4 }),
        lens("made", "made", "Made by threads"),
        lens("trash", "trash", "Trash"),
      ],
    } as FilesPlaces,
  };
  const sidebar = sidebarOf([read], "box");

  it("lists LifeOS and each Drive as places, the projects in the host's order, and the lenses From mail, Made by threads, Trash", () => {
    expect(sidebar.lifeos?.place.name).toBe("LifeOS");
    expect(sidebar.drives.map((d) => d.place.name)).toEqual(["me@dummy.edu"]);
    expect(sidebar.projects.map((p) => p.place.name)).toEqual(["Spring LAN", "Nationals"]);
    expect(sidebar.lenses.map((l) => [l.place.kind, l.place.count ?? null])).toEqual([
      ["mail", 4],
      ["made", null],
      ["trash", null],
    ]);
  });

  it("finds the place a page stands in: a project's lens by its id, a project as a folder of LifeOS, a Drive folder by its account", () => {
    expect(placeOfRef(sidebar, { at: "place", id: "project:p2" })?.copy.place.name).toBe("Nationals");
    expect(placeOfRef(sidebar, { at: "project", id: "p1" })?.copy.place.kind).toBe("lifeos");
    expect(placeOfRef(sidebar, { at: "drive", account: "me@dummy.edu", folderId: "abc" })?.copy.place.kind).toBe("drive");
    expect(placeOfRef(sidebar, { at: "drive", account: "other@dummy.edu", folderId: "abc" })).toBeNull();
    expect(placeOfRef(sidebar, { at: "place", id: "mail" })?.copy.place.kind).toBe("mail");
  });

  it("gives a mail's file Open and Keep alone, and a file in a project the way out of it", () => {
    const mail = lens("mail", "mail", "From mail");
    const part: FileEntry = { key: "mail:m1:p1", ref: { at: "mail", threadId: "t", messageId: "m1", partId: "p1" } as FileEntry["ref"], folder: null, name: "Quote.pdf", kind: "pdf" };
    expect(actsFor([part], mail, { tabs: true }).map((r) => r.act)).toEqual(["open", "keep"]);
    expect(actsFor([part, { ...part, key: "mail:m1:p2", name: "Map.png" }], mail, { tabs: true }).map((r) => r.act)).toEqual(["keep"]);
    const folder = lens("folder", "folder", "W", { at: "file", host: "h", path: "/w" }, { can: ["rename", "move", "copy", "trash"] });
    const linked: FileEntry = { key: "k:a", ref: { at: "file", host: "h", path: "/w/a.txt" }, folder: null, name: "a.txt", kind: "text", project: { id: "p1", name: "Spring LAN" } };
    expect(actsFor([linked], folder, { tabs: true, projects: true }).find((r) => r.act === "project-out")?.label).toBe("Take Out of Spring LAN");
    expect(actsFor([{ ...linked, project: undefined }], folder, { tabs: true, projects: true }).map((r) => r.act)).not.toContain("project-out");
  });
});

describe("the list's rules of round 1", () => {
  it("knows a folder that is gone from one that did not load", async () => {
    const { folderGone } = await import("./model");
    expect(folderGone("That folder is not there any more.")).toBe(true);
    expect(folderGone("Events is not there any more.")).toBe(true);
    expect(folderGone("Permission denied.")).toBe(false);
    expect(folderGone(null)).toBe(false);
  });

  it("lists each file of Home once, in the first list it belongs to", async () => {
    const { homeLists } = await import("./model");
    const e = (key: string) => ({ key });
    expect(homeLists({ waiting: [e("a")], starred: [e("b"), e("a")], recent: [e("a"), e("c"), e("b")] })).toEqual({ waiting: [e("a")], starred: [e("b")], recent: [e("c")] });
  });

  it("says what a search left out: the places asleep first, else that not every place was searched", async () => {
    const { searchGap } = await import("./model");
    expect(searchGap({})).toBeNull();
    expect(searchGap({ asleep: ["The Windows VM"] })).toEqual({ title: "The Windows VM is asleep", line: "Its files were not searched.", fix: { kind: "retry" } });
    expect(searchGap({ asleep: ["A", "B", "C"], incomplete: true })).toEqual({ title: "A, B and C are asleep", line: "Not every place was searched.", fix: { kind: "retry" } });
    expect(searchGap({ incomplete: true })).toEqual({ title: "Not every place was searched", fix: { kind: "retry" } });
  });
});

describe("a file at another's side", () => {
  it("sits there when it is on a disk, and not when it is a LifeOS or a Drive file", async () => {
    const { sitsAtSide } = await import("./model");
    expect(sitsAtSide({ at: "file", host: "env_box", path: "/w/Plan.pdf" })).toBe(true);
    expect(sitsAtSide({ at: "lifeos", table: "docs", id: "d1" } as never)).toBe(false);
    expect(sitsAtSide({ at: "google", fileId: "g1" } as never)).toBe(false);
  });
});
