import { describe, expect, it, vi } from "vitest";
import { saveAsWord, serviceOf, WORD_LOSSES, wordLine } from "./wordSave";

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

  it("never writes over a file that changed there: it offers Keep Both alone", async () => {
    const d = deps("action", [{ conflict: { changed: AT } }, { copy: { name: "AD Screening 9-2 (mine).docx" } }]);
    expect(await saveAsWord(TAB, d)).toBe("kept");
    expect(d.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "AD Screening 9-2.docx changed in Teams since you opened it.", action: "Keep Both" }));
    expect(d.save.mock.calls).toEqual([[false], [true]]);
    const declined = deps("action", [{ conflict: { gone: true } }], false);
    expect(await saveAsWord(TAB, declined)).toBeNull();
    expect(declined.save).toHaveBeenCalledTimes(1);
  });
});
