import { describe, expect, it } from "vitest";
import type { FileEntry, FilePlace } from "@shared/work/files";
import { actsFor, answersWords, formEntryOf } from "./model";

/** A Microsoft form's rows in a library folder: the form opens and nothing else; its workbook opens the form too. */
const ref = { at: "msform" as const, host: "h", workspaceId: "w1", formId: "Ob0wQVN8nEGx5YdY1tY_IQ", tenant: "t" };
const form: FileEntry = { key: "msform:w1:x", ref, folder: null, name: "Spring sign-ups", kind: "form" };
const book: FileEntry = { key: "k", ref: { at: "file", host: "h", path: "/lib/Sign-ups.xlsx" }, folder: null, name: "Sign-ups.xlsx", kind: "sheet", answersTo: { title: "Spring sign-ups", ref } };
const place = { id: "lib", kind: "channels", name: "Esports", verbs: ["rename", "move", "copy", "trash", "make"] } as unknown as FilePlace;

describe("a Microsoft form in Files", () => {
  it("opens, and is not renamed, moved or deleted here", () => {
    expect(actsFor([form], place).map((r) => r.act)).toEqual(["open"]);
    expect(actsFor([form, book], place)).toEqual([]);
  });

  it("its workbook reads as its answers and opens the form from its menu", () => {
    const acts = actsFor([book], place).map((r) => r.label);
    expect(acts.slice(0, 2)).toEqual(["Open", "Open the Form"]);
    expect(answersWords(book.answersTo!)).toBe("Answers to Spring sign-ups");
    expect(formEntryOf(book.answersTo!)).toMatchObject({ ref, name: "Spring sign-ups", kind: "form", key: "msform:w1:Ob0wQVN8nEGx5YdY1tY_IQ" });
  });
});
