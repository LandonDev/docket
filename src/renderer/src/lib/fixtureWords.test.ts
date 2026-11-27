import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachLine } from "./attachmentUpload";

// Council 5, for the owner: a preview fixture says the product's own words, so a seat that scores the picture scores the app.
const RENDERER = join(__dirname, "..");
const read = (file: string) => readFileSync(join(RENDERER, file), "utf8");

describe("preview fixtures speak the product's words", () => {
  it("the composer's failed upload says what the composer says", () => {
    expect(read("chrome/Composer.preview.fixtures.tsx")).toContain(`note: "${attachLine(new Error("boom"))}"`);
  });

  it("the picker's notes are the pickers' own", () => {
    const fixture = read("chrome/PickerDialog.fixtures.tsx");
    const notes = /\{\[(.*?)\]\.map\(\(note\)/.exec(fixture)![1].match(/"([^"]+)"/g)!.map((n) => n.slice(1, -1));
    const pickers = read("chrome/FilePicker.tsx") + read("chrome/SymbolPicker.tsx");
    for (const note of notes) expect(pickers, note).toContain(`"${note}"`);
  });

  it("the alert gallery's error is the file picker's failure, and the board's capped row the host's words", () => {
    expect(read("components/ui/feedback.fixtures.tsx")).toContain(`"Couldn't list this project's files"`);
    expect(read("chrome/FilePicker.tsx")).toContain("Couldn't list this project's files");
    // failureKind.ts: "<account> hit its 5-hour limit"; a clock is "2:00 PM", never a padded 24-hour time.
    const board = read("surfaces/threads/master/boardFixture.ts");
    expect(board).toContain('summary: "Personal hit its 5-hour limit"');
    expect(board).not.toMatch(/\b\d{2}:\d{2}\b(?! [AP]M)/);
  });
});
