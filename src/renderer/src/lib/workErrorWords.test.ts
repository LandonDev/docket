import { describe, expect, it } from "vitest";
import { workErrorWords } from "./workErrorWords";

const box = { host: "the box" };
const says = (raw: string, context = box) => workErrorWords(new Error(raw), context);

describe("an error as Work says it to him", () => {
  // The twenty raw lines the polish plan's annex found on screen, each with what he reads now.
  const TWENTY: [string, string, { host: string; write?: boolean }?][] = [
    ["forbidden: work.sheets.edit is outside app-managed roots", "The box does not let this window reach that file where it lies. Open it from Files on the computer that holds it."],
    ['bad request: [{"code":"invalid_type","expected":"string","path":["workspaceId"]}]', "The box could not read this request. Open this view again and retry; if it still fails, update the app on both computers."],
    ["Work is off on this host", "Work is off on the box. Turn it on in Settings, Work."],
    ["No answer in 4 s", "The box did not answer. Try again once it is connected."],
    ["The host did not answer", "The box did not answer. Try again once it is connected."],
    ["work.files.list timed out after 30 s", "The box did not answer. Try again once it is connected."],
    ["work.files.rename timed out after 30 s", "The box did not confirm the change. Check whether it went through before you try again.", { host: "the box", write: true }],
    ["connection closed", "The connection to the box dropped. Try again once it is back."],
    ["connection closed", "The connection to the box dropped. Check whether the change went through.", { host: "the box", write: true }],
    ["work: lifeos did not start on this host", "This part of Work is not running on the box. Look under Settings, Connections; if the two computers run different versions, update both."],
    ["unknown workspace: YfBTHVqGfj7M", "This workspace is no longer on the box."],
    ["no such workspace: YfBTHVqGfj7M", "This workspace is no longer on the box."],
    ["no canvas item ci_83hd", "This tab is no longer open. Open the file again from Files."],
    ["There is no canvas item ci_83hd.", "This tab is no longer open. Open the file again from Files."],
    ["not a Work workspace: abc", "The thread or workspace this belongs to is gone. Open it again from Work."],
    ["ENOENT: no such file or directory, stat '/srv/agents/work/Purdue/Budget.xlsx'", "The file or folder was moved or removed. Refresh Files and open it from where it is now."],
    ["EACCES: permission denied, rename '/srv/a' -> '/srv/b'", "This computer could not change the file in that folder. Check that you may edit it there, or save a copy somewhere you may."],
    ["There is no file at /srv/agents/work/Purdue/Budget.xlsx.", "The file or folder was moved or removed. Refresh Files and open it from where it is now."],
    ["docx→pdf left no output", "The conversion made no file. Open the original and export again."],
    ["not a name a preview is kept under", "This preview is gone. Close it and open it again from the file's tab."],
    ["That preview is gone: draw it again.", "This preview is gone. Close it and open it again from the file's tab."],
    ["LifeOS is not signed in on this host", "Not signed in to LifeOS on the box. Sign in under Settings, Connections."],
    // "Not connected" is any state but connected (signed out, waiting, LifeOS silent): it never claims signed out.
    ["LifeOS is not connected on this computer.", "The box cannot use LifeOS now. See why under Settings, Connections."],
    ["LifeOS is signed out", "Not signed in to LifeOS on the box. Sign in under Settings, Connections."],
    ["LibreOffice is not installed on this host or on one it reaches.", "The box is missing the tools that draw and read this file. Install them under Settings, Connections, Conversion tools."],
    ["ffprobe is not installed on this host", "The box is missing the tools that draw and read this file. Install them under Settings, Connections, Conversion tools."],
    ["no such guest link on this host", "This link is not on the box. Look for it on the computer that made it."],
    ["A file in the Windows VM is copied on this host (filesCopy): its bytes go to no caller.", "Open this file from its library in Files. The copy is made on the computer that runs the Windows VM."],
    ["Scrim notes.txt could not go to the Trash, so it was left where it is: spawn gio ENOENT", "A program the box needs for this is missing there."],
    // A held act's failure as the host answers it, the program first (the Outbox, PM7): capitalized on the way.
    ["spawn osascript ENOENT", "A program the box needs for this is missing there."],
    ["forbidden: work.set needs admin", "This computer's key may not do that on the box. Do it from a computer that manages the box."],
  ];
  it.each(TWENTY)("%s", (raw, words, context) => expect(says(raw, context ?? box)).toBe(words));

  it("says a workbook the sheet's importer refused by its cause, naming the computer, with what Excel can do", () => {
    expect(says("This file cannot be opened here: it has a password")).toBe("The box cannot read a workbook locked with a password. Remove the password in Excel to edit it here.");
    expect(says("This file cannot be opened here: it is a binary workbook (.xlsb)")).toBe("The box cannot read a binary workbook (.xlsb). Save it as .xlsx in Excel to edit it here.");
    expect(says("This file cannot be opened here: it is saved as Strict Open XML", { host: "This Mac" })).toBe("This Mac cannot read Strict Open XML. Save it in Excel as an Excel Workbook (.xlsx) to edit it here.");
    expect(says("This file cannot be opened here: it is too big to read here")).toBe("This workbook is too big for the box to read. Edit it in Excel.");
    // the importer's own reason never reaches him
    expect(says("This file cannot be opened here: the package directory is damaged")).toBe("The box could not read this workbook. It may be damaged: open it in Excel and save it again.");
    expect(workErrorWords(new Error("This file cannot be opened here: not a zip package"))).toBe("That computer could not read this workbook. It may be damaged: open it in Excel and save it again.");
  });

  it("says a link closed for good, which rejects with its bare word, as a dropped connection", () => {
    expect(says("closed")).toBe("The connection to the box dropped. Try again once it is back.");
    expect(says("the file is closed")).toBe("The file is closed");
  });

  it("passes a refusal that is already plain, as the host wrote it", () => {
    expect(says("refused: only a document, sheet or deck can be a template")).toBe("Only a document, sheet or deck can be a template");
    expect(says("Budget.xlsx is open in Excel on This Mac. Close it there first.")).toBe("Budget.xlsx is open in Excel on This Mac. Close it there first.");
  });

  it("answers nothing for a line never written for him, so the act's own line shows", () => {
    expect(says("TypeError: Cannot read properties of undefined (reading 'path')\n    at open (/app/out/main/index.js:1:1)")).toBe("");
    expect(says("work.office.filesCopy: env_X__8UrVItMkZbSL_UlWV3g refused")).toBe("");
    // A method that starts the line is raised to "Work." by `refusalWords`: still a method.
    expect(says("work.slides.show: no answer in 30 s")).toBe("");
    expect(says("work.guests.forItem: socket hung")).toBe("");
    expect(says("work.set: write failed")).toBe("");
    expect(says("could not write /srv/agents/temp-code-data/work/x.tmp")).toBe("");
    expect(workErrorWords(undefined)).toBe("");
  });

  it("names no computer it was not told of, and leaves a line that is plain without one", () => {
    expect(workErrorWords(new Error("No answer in 4 s"))).toBe("That computer did not answer. Try again once it is connected.");
    expect(workErrorWords(new Error("Work is off on this host"))).toBe("Work is off on this host");
    expect(workErrorWords(new Error("not connected"))).toBe("Not connected");
    // Told which computer, the bare word says which is away.
    expect(workErrorWords(new Error("not connected"), { host: "the box" })).toBe("The box is not connected. Try again once it is back.");
  });

  // The converter's refusals (main/server/work/formats/jobs.ts), as Preview showed them raw: a pair's id, the host's id, "his own press".
  const CONVERTER: [string, string][] = [
    ["no converter from docx to pdf", "The box has no app that draws Word files."],
    ["no converter from tcdoc to rtf", "The box has no app that draws this file."],
    ["tempcode-box cannot convert docx to pdf now, and a shared library's file is never carried to another host", "A shared file is drawn only on the computer that holds it, and the box cannot draw it now."],
    ["libreoffice is not installed on tempcode-box, and a shared library's file is never carried to another host", "The box is missing the tools that draw and read this file. Install them under Settings, Connections, Conversion tools."],
    ["the machine that converts docx to pdf+word is asleep, and only his own press wakes it", "The Windows VM is asleep. Check in Word wakes it."],
    ["the machine that converts xlsx to pdf is asleep, and only his own press wakes it", "The Windows VM is asleep. Check in Excel wakes it."],
    ["the machine that converts docx to pdf+word is asleep on env_abcdef12, and only his own press at a window of that host wakes it", "The Windows VM that draws it is asleep. Wake it from a window on the computer that runs it."],
    ["the app that converts pptx to pdf+powerpoint is not open on tempcode-box", "PowerPoint is not open on the box."],
    ["tempcode-box cannot convert pdf to png now, and no linked host converts pdf to png", "The box cannot draw PDFs now, and no computer linked to it can."],
    ["tempcode-box cannot convert docx to pdf now", "The box cannot draw Word files now."],
    ["Preview.docx is 120 MB; a job carried to another host takes at most 50 MB", "Preview.docx is 120 MB, more than the 50 MB another computer is sent to draw."],
    ["the pdf that came back is 80 MB; a job carried from another host takes at most 50 MB", "What came back from the computer that drew it was too big to bring here."],
    ["Invalid PDF structure.", "This PDF is damaged, or only part of it arrived. Open it again from Files."],
    ["pymupdf4llm is not installed on tempcode-box", "The box is missing the tools that draw and read this file. Install them under Settings, Connections, Conversion tools."],
  ];
  it.each(CONVERTER)("says the converter's %s", (raw, words) => expect(says(raw)).toBe(words));
});
