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
    ["LifeOS is not connected on this computer.", "Not signed in to LifeOS on the box. Sign in under Settings, Connections."],
    ["LibreOffice is not installed on this host or on one it reaches.", "The box is missing the tools that draw and read this file. Install them under Settings, Connections, Conversion tools."],
    ["ffprobe is not installed on this host", "The box is missing the tools that draw and read this file. Install them under Settings, Connections, Conversion tools."],
    ["no such guest link on this host", "This link is not on the box. Look for it on the computer that made it."],
    ["A file in the Windows VM is copied on this host (filesCopy): its bytes go to no caller.", "Open this file from its library in Files. The copy is made on the computer that runs the Windows VM."],
    ["Scrim notes.txt could not go to the Trash, so it was left where it is: spawn gio ENOENT", "A program the box needs for this is missing there."],
    ["forbidden: work.set needs admin", "This computer's key may not do that on the box. Do it from a computer that manages the box."],
  ];
  it.each(TWENTY)("%s", (raw, words, context) => expect(says(raw, context ?? box)).toBe(words));

  it("passes a refusal that is already plain, as the host wrote it", () => {
    expect(says("refused: only a document, sheet or deck can be a template")).toBe("Only a document, sheet or deck can be a template");
    expect(says("Budget.xlsx is open in Excel on This Mac. Close it there first.")).toBe("Budget.xlsx is open in Excel on This Mac. Close it there first.");
  });

  it("answers nothing for a line never written for him, so the act's own line shows", () => {
    expect(says("TypeError: Cannot read properties of undefined (reading 'path')\n    at open (/app/out/main/index.js:1:1)")).toBe("");
    expect(says("work.office.filesCopy: env_X__8UrVItMkZbSL_UlWV3g refused")).toBe("");
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
});
