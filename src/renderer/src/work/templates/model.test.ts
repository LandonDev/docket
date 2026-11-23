import { describe, expect, it } from "vitest";
import type { Template } from "@shared/work/templates";
import { asksLine, folderName, inJob, shelfGroups, stemOf, tileMenu } from "./model";

const tpl = (id: string, name: string, over: Partial<Template> = {}): Template => ({
  id,
  name,
  kind: "document",
  form: "docx",
  where: id.startsWith("job:") ? "job" : id.startsWith("all:") ? "all" : "starter",
  fields: [],
  source: { at: "file", host: "box", path: `/w/Templates/${name}.docx` },
  ...over,
});

describe("the shelf's groups", () => {
  it("puts his own for the job, then the job's starters, under the job's name, and the rest under All jobs, each part by name", () => {
    const groups = shelfGroups(
      [
        tpl("starter:any/meeting-notes", "Meeting notes"),
        tpl("starter:ref/season-log", "Season log"),
        tpl("all:Weekly.docx", "Weekly"),
        tpl("job:Zone report.docx", "Zone report"),
        tpl("starter:ref/game-report", "Game report"),
        tpl("job:Crew memo.docx", "Crew memo"),
        tpl("all:agenda.docx", "agenda"),
      ],
      "Dummy Esports",
    );
    expect(groups.map((g) => [g.label, g.templates.map((t) => t.name)])).toEqual([
      ["Dummy Esports", ["Crew memo", "Zone report", "Game report", "Season log"]],
      ["All jobs", ["agenda", "Weekly", "Meeting notes"]],
    ]);
  });

  it("draws no group that has nothing in it", () => {
    expect(shelfGroups([tpl("starter:any/meeting-notes", "Meeting notes")], "Dummy Esports").map((g) => g.label)).toEqual(["All jobs"]);
    expect(shelfGroups([], "Dummy Esports")).toEqual([]);
  });

  it("reads a starter's sector from its id", () => {
    expect(inJob(tpl("starter:unify/invoice", "Invoice"))).toBe(true);
    expect(inJob(tpl("starter:any/meeting-notes", "Meeting notes"))).toBe(false);
    expect(inJob(tpl("all:x.docx", "x"))).toBe(false);
  });
});

describe("a tile's menu", () => {
  it("offers a starter New from this, Edit a copy and Hide", () => {
    expect(tileMenu(tpl("starter:ref/game-report", "Game report"), "Dummy Esports").map((r) => r.label)).toEqual(["New from this", "Edit a copy", "Hide"]);
  });

  it("offers his own Edit, Rename… and the move that fits its group, then Remove", () => {
    expect(tileMenu(tpl("job:Crew memo.docx", "Crew memo"), "Dummy Esports").map((r) => r.label)).toEqual(["New from this", "Edit", "Rename…", "Use in all jobs", "Remove"]);
    expect(tileMenu(tpl("all:Weekly.docx", "Weekly"), "Dummy Esports").map((r) => r.label)).toContain("Only in Dummy Esports");
  });
});

describe("the words", () => {
  it("names the fields a template asks for, or nothing", () => {
    expect(asksLine(["Client", "Game"])).toBe("Asks for Client and Game.");
    expect(asksLine(["Home", "Away", "Site"])).toBe("Asks for Home, Away and Site.");
    expect(asksLine([])).toBeNull();
  });

  it("names the folder a file is kept in from the caller or the path", () => {
    expect(folderName({ at: "file", path: "/w/Dummy Esports/Invoices/" })).toBe("Invoices");
    expect(folderName({ at: "place", path: undefined }, "Shared")).toBe("Shared");
    expect(folderName({ at: "place" })).toBeNull();
    expect(folderName(undefined)).toBeNull();
  });

  it("takes a file's extension off for its name", () => {
    expect(stemOf("Game report.docx")).toBe("Game report");
    expect(stemOf(".hidden")).toBe(".hidden");
  });
});
