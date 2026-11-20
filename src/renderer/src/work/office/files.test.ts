import { describe, expect, it } from "vitest";
import type { TeamsLibrary } from "@shared/contract-work-office";
import { appVerb, crumbsOf, libraryGroups, openWay, placeOf, showsHeading, type ShownLibrary } from "./files";

const lib = (over: Partial<TeamsLibrary> & Pick<TeamsLibrary, "id" | "path" | "team" | "kind">): ShownLibrary => ({ host: "env_mac", library: null, tenant: "Purdue University", channels: [], web: null, found: true, env: "local", ...over });
const esports = lib({ id: "m~1", path: "/c/S/Purdue Esports - Documents", team: "Purdue Esports", kind: "channels", channels: ["Events", "General"] });
const policies = lib({ id: "m~2", path: "/c/S/RecWell - Site Policies", team: "RecWell", library: "Site Policies", kind: "library" });
const mine = lib({ id: "m~3", path: "/c/OneDrive-Purdue University", team: "My files", kind: "mine" });

describe("the Files view's rules", () => {
  it("reads libraries as teams with their channels, his own files last", () => {
    expect(libraryGroups([mine, policies, esports]).map((g) => [g.name, g.rows.map((r) => [r.label, r.folder])])).toEqual([
      ["Purdue Esports", [["Events", "/c/S/Purdue Esports - Documents/Events"], ["General", "/c/S/Purdue Esports - Documents/General"]]],
      ["RecWell", [["Site Policies", "/c/S/RecWell - Site Policies"]]],
      ["", [["My files", "/c/OneDrive-Purdue University"]]],
    ]);
  });

  it("shows a library OneDrive named in one word as one row by that name, with no heading saying it again", () => {
    const recwell = lib({ id: "m~4", path: "/c/OneDrive-purdue.edu-RecWell-TeamRecWell", team: "RecWell-TeamRecWell", kind: "library", tenant: "purdue.edu" });
    const [group] = libraryGroups([recwell]);
    expect(group!.rows.map((r) => [r.label, r.folder])).toEqual([["RecWell-TeamRecWell", recwell.path]]);
    expect(showsHeading(group!)).toBe(false);
    expect(showsHeading(libraryGroups([esports])[0]!)).toBe(true);
    expect(crumbsOf(recwell, `${recwell.path}/Operations`).map((c) => c.label)).toEqual(["RecWell-TeamRecWell", "Operations"]);
  });

  it("gives a team with no channel folders its Documents row", () => {
    expect(libraryGroups([{ ...esports, channels: [] }])[0]!.rows.map((r) => r.label)).toEqual(["Documents"]);
  });

  it("crumbs a folder from its team down, and places a hit in its team and folders", () => {
    expect(crumbsOf(esports, "/c/S/Purdue Esports - Documents/General/Budgets")).toEqual([
      { label: "Purdue Esports", folder: "/c/S/Purdue Esports - Documents" },
      { label: "General", folder: "/c/S/Purdue Esports - Documents/General" },
      { label: "Budgets", folder: "/c/S/Purdue Esports - Documents/General/Budgets" },
    ]);
    expect(crumbsOf(policies, policies.path)).toEqual([{ label: "RecWell Site Policies", folder: policies.path }]);
    expect(placeOf(esports, "/c/S/Purdue Esports - Documents/General/Budgets/Q1.xlsx")).toBe("Purdue Esports/General/Budgets");
  });

  it("opens in the canvas on the file's own host, from a copy he allowed, else in its app", () => {
    const pdf = { name: "R.pdf", path: "/c/R.pdf", kind: "pdf" as const };
    expect(openWay(pdf, esports, "local", false)).toBe("canvas");
    expect(openWay(pdf, esports, "env_box", false)).toBe("app");
    expect(openWay(pdf, esports, "env_box", true)).toBe("copy");
    expect(openWay({ name: "n.txt", path: "/c/n.txt", kind: "text" }, esports, "local", true)).toBe("app");
  });

  it("names the app a file opens in", () => {
    expect(appVerb({ name: "B.xlsx", kind: "workbook" })).toBe("Open in Excel");
    expect(appVerb({ name: "D.pptx", kind: "deck" })).toBe("Open in PowerPoint");
    expect(appVerb({ name: "list.csv", kind: "workbook" })).toBe("Open in the app");
  });
});
