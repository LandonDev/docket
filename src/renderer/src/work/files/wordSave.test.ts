import { describe, expect, it, vi } from "vitest";
import { askAutosave, saveAsWord, serviceOf, WORD_LOSSES, wordLine } from "./wordSave";

/** A Word file of another computer opened as its document: the header's words, and Save as Word's one confirm. */

const AT = new Date(2026, 10, 23, 21, 12).getTime();
const NOW = new Date(2026, 10, 23, 21, 40).getTime();
const TAB = { name: "AD Screening 9-2", key: "lib:recwellsportprograms:Esports/AD Screening 9-2.docx", copyOf: { host: "env_box", path: "C:\\Users\\tcuser\\purdue.edu\\RecWell - Documents\\Esports\\AD Screening 9-2.docx", vm: true } };

describe("the header of a Word file opened as its document", () => {
  it("says plainly whether the Word file holds his changes, by the service it lies in", () => {
    expect(wordLine({ since: true }, "Teams", NOW).words).toBe("The Word file in Teams has not changed");
    expect(wordLine({ since: true, at: AT }, "Teams", NOW).words).toBe("Changes since 9:12 PM are not in the Word file");
    expect(wordLine({ since: false, at: AT }, "OneDrive", NOW)).toMatchObject({ state: "saved", words: "Saved to OneDrive as Word 9:12 PM" });
    expect(serviceOf(TAB)).toBe("Teams");
    expect(serviceOf({ key: "lib:mine:Notes.docx" })).toBe("OneDrive");
  });
});

describe("Save as Word", () => {
  const deps = (choice: "action" | "other" | null, answers: unknown[], keep = true) => ({
    choose: vi.fn(async () => choice),
    confirm: vi.fn(async () => keep),
    save: vi.fn(async () => answers.shift() as never),
    said: vi.fn(),
  });

  it("asks once, naming what Word may lose, and writes over the file on Replace", async () => {
    const d = deps("action", [{ at: AT }]);
    expect(await saveAsWord(TAB, d)).toBe("saved");
    expect(d.choose).toHaveBeenCalledWith(expect.objectContaining({ title: "Replace AD Screening 9-2.docx in Teams?", action: "Replace", other: "Keep Both" }));
    expect(d.choose.mock.calls[0]![0].body).toContain(WORD_LOSSES);
    expect(d.save).toHaveBeenCalledWith(false);
  });

  it("Keep Both puts his version beside it; Cancel writes nothing", async () => {
    const d = deps("other", [{ copy: { name: "AD Screening 9-2 (mine).docx" } }]);
    expect(await saveAsWord(TAB, d)).toBe("kept");
    expect(d.save).toHaveBeenCalledWith(true);
    expect(d.said).toHaveBeenCalledWith("Saved beside it as AD Screening 9-2 (mine).docx");
    const none = deps(null, []);
    expect(await saveAsWord(TAB, none)).toBeNull();
    expect(none.save).not.toHaveBeenCalled();
  });

  it("over a file that changed there says when, holds Keep Both in focus, and Replace on his press writes over it", async () => {
    const d = deps("action", [{ conflict: { changed: AT } }, { at: NOW }]);
    d.choose.mockResolvedValueOnce("action").mockResolvedValueOnce("action");
    expect(await saveAsWord(TAB, d, NOW)).toBe("saved");
    expect(d.choose.mock.calls[1]![0]).toMatchObject({ title: "AD Screening 9-2.docx changed in Teams 9:12 PM, after you opened it.", action: "Replace", other: "Keep Both", focusOther: true });
    expect(d.choose.mock.calls[1]![0].body).toContain("version history");
    expect(d.save.mock.calls).toEqual([[false], [false, true]]);
    const both = deps("action", [{ conflict: { changed: AT } }, { copy: { name: "AD Screening 9-2 (mine).docx" } }]);
    both.choose.mockResolvedValueOnce("action").mockResolvedValueOnce("other");
    expect(await saveAsWord(TAB, both, NOW)).toBe("kept");
    expect(both.save.mock.calls).toEqual([[false], [true]]);
    const gone = deps("action", [{ conflict: { gone: true } }], false);
    expect(await saveAsWord(TAB, gone, NOW)).toBeNull();
    expect(gone.save).toHaveBeenCalledTimes(1);
  });

});

describe("a Word file saved by itself", () => {
  it("says saving while his newest words are not in it, saved with the time once they are, and the change that stopped it", () => {
    expect(wordLine({ since: true, auto: true }, "Teams", NOW)).toMatchObject({ state: "saving", words: "Saving to Teams…" });
    expect(wordLine({ since: false, auto: true, at: AT }, "Teams", NOW)).toMatchObject({ state: "saved", words: "Saved to Teams 9:12 PM" });
    expect(wordLine({ since: true, auto: true, at: AT, stopped: AT }, "OneDrive", NOW)).toMatchObject({ state: "conflict", words: "This file changed in OneDrive 9:12 PM" });
  });

  it("asks once, naming what Word may change, and keeps his choice", async () => {
    const set = vi.fn(async () => undefined);
    const choose = vi.fn(async () => "action" as const);
    expect(await askAutosave(TAB, { choose, set })).toBe(true);
    expect(choose.mock.calls[0]![0]).toMatchObject({ action: "Save automatically", other: "Ask me each time" });
    expect(choose.mock.calls[0]![0].body).toContain(WORD_LOSSES);
    expect(set).toHaveBeenCalledWith(true);
    const later = vi.fn(async () => null);
    expect(await askAutosave(TAB, { choose: later, set })).toBeNull();
    expect(set).toHaveBeenCalledTimes(1);
  });
});
