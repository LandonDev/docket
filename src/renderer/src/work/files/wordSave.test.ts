import { describe, expect, it, vi } from "vitest";
import { cloudLine } from "./fileText";
import { lossesLine, saveAsWord, serviceOf, WORD_LOSSES, wordLine, wordPress, wordWaitsWords } from "./wordSave";

/** A Word file of another computer opened as its document: the header's words, and Save as Word's one confirm. */

const AT = new Date(2026, 10, 23, 21, 12).getTime();
const NOW = new Date(2026, 10, 23, 21, 40).getTime();
const TAB = { name: "AD Screening 9-2", key: "lib:recwellsportprograms:Esports/AD Screening 9-2.docx", copyOf: { host: "env_box", path: "C:\\Users\\tcuser\\purdue.edu\\RecWell - Documents\\Esports\\AD Screening 9-2.docx", vm: true } };

describe("the header of a Word file opened as its document", () => {
  it("says plainly whether the Word file holds his changes, by the service it lies in", () => {
    expect(wordLine({ since: true }, "Teams", "MacBook", NOW).words).toBe("The Word file in Teams has not changed");
    expect(wordLine({ since: true, at: AT }, "Teams", "MacBook", NOW).words).toBe("Changes since 9:12 PM are not in the Word file");
    // A save is said of the computer that holds the file: OneDrive has not said it has it.
    expect(wordLine({ since: false, at: AT }, "OneDrive", "MacBook", NOW)).toMatchObject({ state: "saved", words: "Saved to MacBook as Word 9:12 PM" });
    expect(serviceOf(TAB)).toBe("Teams");
    // A refusal of the save by itself is said in the holder's words, never as still saving.
    expect(wordLine({ since: true, at: AT, auto: true, refused: "That is not in this workspace's folder or a library it may use." }, "Teams", "the Windows VM", NOW)).toEqual({
      state: "conflict",
      words: "The Windows VM refused the save. That is not in this workspace's folder or a library it may use",
    });
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

  it("asks once and writes over the file on Replace; where this window does not know the file's losses, it names what this editor never keeps", async () => {
    const d = deps("action", [{ at: AT }]);
    expect(await saveAsWord(TAB, d)).toBe("saved");
    expect(d.choose).toHaveBeenCalledWith(expect.objectContaining({ title: "Replace AD Screening 9-2.docx in Teams?", action: "Replace", other: "Keep Both" }));
    expect(d.choose.mock.calls[0]![0].body).toContain(WORD_LOSSES);
    expect(d.save).toHaveBeenCalledWith(false);
  });

  it("names only the losses this file has, and none where it has none (decision 4)", async () => {
    const some = deps("action", [{ at: AT }]);
    await saveAsWord(TAB, { ...some, losses: ["1 table inside a table kept as text", "2 suggestions go as tracked changes"] });
    expect(some.choose.mock.calls[0]![0].body).toBe("Everyone who opens it sees your version. The Word file loses what this editor did not keep: 1 table inside a table kept as text and 2 suggestions go as tracked changes.");
    const none = deps("action", [{ at: AT }]);
    await saveAsWord(TAB, { ...none, losses: [] });
    expect(none.choose.mock.calls[0]![0].body).toBe("Everyone who opens it sees your version.");
    expect(lossesLine(["A", "B", "C"])).toBe("The Word file loses what this editor did not keep: A, b and c.");
  });

  it("his first press on a file asks once whether to save as he works, keeps his choice, and saves now either way", async () => {
    const set = vi.fn(async () => undefined);
    const auto = deps("action", [{ at: AT }]);
    expect(await saveAsWord(TAB, { ...auto, losses: [], first: { set } })).toBe("saved");
    expect(auto.choose.mock.calls[0]![0]).toMatchObject({ title: "Save AD Screening 9-2.docx to Teams as you work?", action: "Save automatically", other: "Ask me each time" });
    expect(auto.choose.mock.calls[0]![0].body).toBe("Everyone who opens it sees your version, and Teams keeps its own version history.");
    expect(set).toHaveBeenCalledWith(true);
    expect(auto.save).toHaveBeenCalledWith(false);
    // "Ask me each time" saves this once, over the file: his press was the save.
    const each = deps("other", [{ at: AT }]);
    expect(await saveAsWord(TAB, { ...each, first: { set } })).toBe("saved");
    expect(set).toHaveBeenLastCalledWith(false);
    expect(each.save).toHaveBeenCalledWith(false);
    // Cancel keeps no choice and writes nothing.
    const none = deps(null, []);
    expect(await saveAsWord(TAB, { ...none, first: { set } })).toBeNull();
    expect(set).toHaveBeenCalledTimes(2);
    expect(none.save).not.toHaveBeenCalled();
  });

  it("the header's press names the place, the file being Word already", () => {
    expect(wordPress(TAB)).toBe("Save to Teams");
    expect(wordPress({ key: "lib:mine:Plan.docx" })).toBe("Save to OneDrive");
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
    const d = deps("action", [{ conflict: { changed: AT, version: "v-colleague" } }, { at: NOW }]);
    d.choose.mockResolvedValueOnce("action").mockResolvedValueOnce("action");
    expect(await saveAsWord(TAB, d, NOW)).toBe("saved");
    expect(d.choose.mock.calls[1]![0]).toMatchObject({ title: "AD Screening 9-2.docx changed in Teams 9:12 PM, after you opened it.", action: "Replace", other: "Keep Both", focusOther: true });
    expect(d.choose.mock.calls[1]![0].body).toContain("version history");
    // Replace names the version of the change the line said, never only its time.
    expect(d.save.mock.calls).toEqual([[false], [false, true, "v-colleague"]]);
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
    expect(wordLine({ since: true, auto: true }, "Teams", "the Windows VM", NOW)).toMatchObject({ state: "saving", words: "Saving to the Windows VM…" });
    expect(wordLine({ since: false, auto: true, at: AT }, "Teams", "the Windows VM", NOW)).toMatchObject({ state: "saved", words: "Saved to the Windows VM 9:12 PM" });
    expect(wordLine({ since: true, auto: true, at: AT, stopped: AT }, "OneDrive", "MacBook", NOW)).toMatchObject({ state: "conflict", words: "This file changed in OneDrive 9:12 PM" });
  });

  it("says Teams only once OneDrive has the file: before that, the computer that holds it", () => {
    const line = wordLine({ since: false, auto: true, at: AT }, "Teams", "MacBook", NOW);
    expect(cloudLine(line, undefined, "Teams", "MacBook", NOW).words).toBe("Saved to MacBook 9:12 PM");
    expect(cloudLine(line, { is: "uploading", at: AT }, "Teams", "MacBook", NOW).words).toBe("Saved, uploading to Teams…");
    expect(cloudLine(line, { is: "uploaded", at: AT }, "Teams", "MacBook", NOW).words).toBe("In Teams 9:12 PM");
  });
});

describe("⌘S on a Word file whose save is his press", () => {
  it("says the Word file changes on that press, by its own name and service", () => {
    expect(wordWaitsWords(TAB)).toBe("AD Screening 9-2.docx changes when you press Save to Teams.");
  });
});
