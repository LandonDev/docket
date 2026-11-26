import { describe, expect, it } from "vitest";
import { dialogErrorWords } from "./dialogErrorWords";

describe("dialogErrorWords", () => {
  it("words the link, a silent host and a refused key, naming the host mid-line", () => {
    expect(dialogErrorWords(new Error("not connected"), "The box")).toBe("The box is not connected. Try again once it is back.");
    expect(dialogErrorWords(new Error("socket closed"))).toBe("Its host is not connected. Try again once it is back.");
    expect(dialogErrorWords(new Error("no answer in 30 s"), "The box")).toBe("The box did not answer. Try again.");
    expect(dialogErrorWords(new Error("forbidden: turnpass.set needs admin"), "The box")).toBe("This computer's key may not do that on the box.");
  });

  it("keeps git's first sentence, without its prefix, file list or Aborting", () => {
    const stderr = "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\nPlease commit your changes or stash them before you switch branches.\nAborting";
    expect(dialogErrorWords(new Error(stderr))).toBe("Your local changes to the following files would be overwritten by checkout");
    expect(dialogErrorWords("fatal: not a git repository (or any of the parent directories): .git")).toBe("Not a git repository (or any of the parent directories): .git");
  });

  it("drops the call's name the link puts before the host's words", () => {
    expect(dialogErrorWords(new Error("devServer.start: the host has no copy of this project"), "The box")).toBe("The host has no copy of this project");
    expect(dialogErrorWords(new Error("work.files.list: refused: the project is moving"))).toBe("The project is moving");
    expect(dialogErrorWords(new Error("session.create: not connected"), "The box")).toBe("The box is not connected. Try again once it is back.");
    // A program's name with no dot stays, as does a file's name with no colon after it.
    expect(dialogErrorWords(new Error("simctl: device is booting"))).toBe("simctl: device is booting");
    expect(dialogErrorWords(new Error("index.lock exists"))).toBe("index.lock exists");
  });

  it("passes a worded refusal with refused: dropped, a plain first word raised and its own ending", () => {
    expect(dialogErrorWords(new Error("refused: the project is moving"))).toBe("The project is moving");
    expect(dialogErrorWords(new Error("index.lock exists"))).toBe("index.lock exists");
    // A program naming itself before a colon keeps its case too.
    expect(dialogErrorWords(new Error("simctl: device is booting"))).toBe("simctl: device is booting");
    expect(dialogErrorWords(new Error("Name is taken."))).toBe("Name is taken.");
    expect(dialogErrorWords("")).toBe("");
    expect(dialogErrorWords(null)).toBe("");
  });
});
