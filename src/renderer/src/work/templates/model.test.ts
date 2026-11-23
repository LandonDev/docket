import { describe, expect, it } from "vitest";
import type { Template } from "@shared/work/templates";
import { asksLine, editsACopy, folderName, hiddenLine, inJob, namesTemplatesFolder, refusedLine, sentence, shelfGroups, sourceStem, stemOf, tileMenu } from "./model";

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
  const labels = (rows: ReturnType<typeof tileMenu>) => rows.map((r) => (r.kind === "sep" ? "—" : r.label));

  it("offers a starter New from this, Edit a copy and Hide, each with its glyph and none red: Hide is undone with one press", () => {
    const rows = tileMenu(tpl("starter:ref/game-report", "Game report"), "Dummy Esports");
    expect(labels(rows)).toEqual(["New from this", "Edit a copy", "Hide"]);
    expect(rows.every((r) => r.kind === "item" && r.glyph && !r.danger)).toBe(true);
  });

  it("offers his own Edit, Rename… and the move that fits its group, then Remove set apart as the one red row", () => {
    const rows = tileMenu(tpl("job:Crew memo.docx", "Crew memo"), "Dummy Esports");
    expect(labels(rows)).toEqual(["New from this", "Edit", "Rename…", "Use in all jobs", "—", "Remove"]);
    expect(rows.filter((r) => r.kind === "item" && r.danger).map((r) => (r.kind === "item" ? r.id : ""))).toEqual(["remove"]);
    expect(labels(tileMenu(tpl("all:Weekly.docx", "Weekly"), "Dummy Esports"))).toContain("Only in Dummy Esports");
  });

  it("offers Edit a copy on a template for all jobs, which Files cannot open where it lies, in the same order", () => {
    const rows = tileMenu(tpl("all:Weekly.docx", "Weekly"), "Dummy Esports");
    expect(labels(rows)).toEqual(["New from this", "Edit a copy", "Rename…", "Only in Dummy Esports", "—", "Remove"]);
    expect(rows.find((r) => r.kind === "item" && r.id === "edit")).toMatchObject({ glyph: "copy" });
    expect([tpl("job:a.docx", "a"), tpl("all:b.docx", "b"), tpl("starter:ref/c", "c")].map(editsACopy)).toEqual([false, true, true]);
  });
});

describe("the empty shelf and an add", () => {
  it("says what he hid when the shelf is empty because of it", () => {
    expect(hiddenLine(0)).toBeNull();
    expect(hiddenLine(1)).toBe("1 starter is hidden");
    expect(hiddenLine(4)).toBe("4 starters are hidden");
  });

  it("names every file an add left out, with why, in one message", () => {
    expect(refusedLine([])).toBeNull();
    expect(refusedLine([{ name: "Logo.png", why: "Only a document, sheet or deck can be a template" }])).toEqual({ title: "Logo.png was not added", description: "Only a document, sheet or deck can be a template" });
    expect(refusedLine([{ name: "a.png", why: "No" }, { name: "b.txt", why: "Nor this" }])).toEqual({ title: "2 files were not added", description: "a.png: No\nb.txt: Nor this" });
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

  it("names a file to save by its stem, on disk or a Microsoft file by path or name", () => {
    expect(sourceStem({ at: "file", path: "/w/Dummy Esports/Game report.docx" })).toBe("Game report");
    expect(sourceStem({ at: "microsoft", name: "Budget.xlsx", ref: { kind: "path", path: "C:\\Users\\sam\\OneDrive\\Season plan.xlsx" } })).toBe("Season plan");
    expect(sourceStem({ at: "microsoft", name: "Pitch.pptx", ref: { kind: "url" } })).toBe("Pitch");
    expect(sourceStem({ at: "lifeos" })).toBe("");
  });

  it("takes a file's extension off for its name", () => {
    expect(stemOf("Game report.docx")).toBe("Game report");
    expect(stemOf(".hidden")).toBe(".hidden");
  });

  it("knows a Files push about a job's Templates folder, on either separator", () => {
    expect(namesTemplatesFolder("file:box:/w/Dummy Esports/Templates")).toBe(true);
    expect(namesTemplatesFolder("file:pc:C:\\Work\\Dummy Esports\\Templates\\")).toBe(true);
    expect(namesTemplatesFolder("file:box:/w/Dummy Esports/Invoices")).toBe(false);
    expect(namesTemplatesFolder("file:box:/w/Dummy Esports/Templates/Old")).toBe(false);
    expect(namesTemplatesFolder("drive:me:abc")).toBe(false);
    expect(namesTemplatesFolder(undefined)).toBe(false);
  });

  it("ends the host's words with a stop when they have none", () => {
    expect(sentence("The Files view is busy")).toBe("The Files view is busy.");
    expect(sentence("The Files view is busy.")).toBe("The Files view is busy.");
    expect(sentence("Is it there?")).toBe("Is it there?");
  });
});
