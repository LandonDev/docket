import { afterEach, describe, expect, it, vi } from "vitest";
import type { SheetImported } from "@shared/work/sheetFormats";

const toasts = vi.hoisted(() => ({ said: [] as { kind: string; title: string; description?: string }[] }));
vi.mock("../../components/ui/toaster", () => ({
  loadToast: async () => ({
    success: (title: string, o?: { description?: string }) => void toasts.said.push({ kind: "success", title, ...(o?.description ? { description: o.description } : {}) }),
    error: (title: string) => void toasts.said.push({ kind: "error", title }),
  }),
}));
const { importDone, importNotice, importRows, runImport } = await import("./imported");

const xls: SheetImported = { format: "xls", name: "Ledger.xls" };
afterEach(() => void (toasts.said.length = 0));

describe("the line over a sheet opened as an Excel copy", () => {
  it("says where his edits go and what saving back drops, for each format, with Save back", () => {
    expect(importNotice(xls, false)).toEqual({ words: "Edits save to an Excel copy. Saving back as .xls drops tables and newer functions.", press: { act: "back", label: "Save back" } });
    expect(importNotice({ format: "ods", name: "Ledger.ods" }, false).words).toBe("Edits save to an Excel copy. Saving back as .ods drops newer chart kinds.");
    expect(importNotice({ format: "tsv", name: "Scores.tsv" }, false).words).toBe("Edits save to an Excel copy. Saving back as .tsv drops formulas, formatting and other sheets.");
  });

  it("for a file others can open says the copy lasts only with its tab", () => {
    expect(importNotice(xls, true)).toEqual({ words: "Edits stay in this tab's Excel copy until you save back. Saving back as .xls drops tables and newer functions.", press: { act: "back", label: "Save back" } });
  });

  it("when the copy cannot go back says why, and the press is the one that keeps his edits", () => {
    expect(importNotice({ ...xls, stale: true }, false)).toEqual({ words: "This file changed since the copy was made, so it is not saved back.", press: { act: "xlsx", label: "Save as Excel" } });
    expect(importNotice({ ...xls, noBack: "This file holds macros, which an Excel copy does not keep" }, true)).toEqual({
      words: "This file holds macros, which an Excel copy does not keep, so it is not saved back.",
      press: { act: "xlsx", label: "Save as Excel" },
    });
  });
});

describe("the copy's rows of More", () => {
  const ids = (imported?: SheetImported): string[] => importRows(imported, async () => {}).map((row) => `${row.id}:${row.label}`);

  it("a sheet that is no copy has none", () => {
    expect(ids(undefined)).toEqual([]);
  });

  it("names both ways out; Save back names the format", () => {
    expect(ids(xls)).toEqual(["import-back:Save back as .xls", "import-xlsx:Save as Excel"]);
  });

  it("offers no Save back where it would be refused, and Discard edits and read again only when the file moved on", () => {
    expect(ids({ ...xls, noBack: "This file holds macros, which an Excel copy does not keep" })).toEqual(["import-xlsx:Save as Excel"]);
    expect(ids({ ...xls, stale: true })).toEqual(["import-xlsx:Save as Excel", "import-again:Discard edits and read again"]);
  });

  it("each row runs its own act", async () => {
    const ran: string[] = [];
    for (const row of importRows({ ...xls, stale: true }, async (act) => void ran.push(act))) await row.run();
    await importRows(xls, async (act) => void ran.push(act))[0]!.run();
    expect(ran).toEqual(["xlsx", "again", "back"]);
  });
});

describe("what a press answers", () => {
  it("names the file saved, and under it what the format left behind of this workbook", () => {
    expect(importDone(xls, "back", { path: "/w/Ledger.xls", drops: ["2 tables become plain ranges", "1 colour scale stays behind"] })).toEqual({
      title: "Saved Ledger.xls",
      description: "2 tables become plain ranges. 1 colour scale stays behind.",
    });
    expect(importDone(xls, "back", { path: "/w/Ledger.xls" })).toEqual({ title: "Saved Ledger.xls" });
    expect(importDone(xls, "xlsx", { path: "C:\\w\\Ledger 2.xlsx", itemId: "i2" })).toEqual({ title: "Saved Ledger 2.xlsx" });
    expect(importDone(xls, "again", {})).toEqual({ title: "Read Ledger.xls again" });
  });

  it("one toast a press: the save, or the host's own words for why not; it never rejects", async () => {
    await runImport(async () => ({ path: "/w/Ledger.xls" }), xls, "back");
    await runImport(async () => Promise.reject(new Error("Ledger.xls changed since this copy was made. Save as Excel to keep your edits.")), xls, "back");
    await runImport(async () => Promise.reject(new Error("")), xls, "xlsx");
    await new Promise((r) => setTimeout(r, 0));
    expect(toasts.said).toEqual([
      { kind: "success", title: "Saved Ledger.xls" },
      { kind: "error", title: "Ledger.xls changed since this copy was made. Save as Excel to keep your edits." },
      { kind: "error", title: "Couldn't save as Excel" },
    ]);
  });
});
