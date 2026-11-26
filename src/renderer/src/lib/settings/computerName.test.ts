import { describe, expect, it, vi } from "vitest";

vi.mock("../native", () => ({ thisDesktopName: () => "This Mac", thisDesktopInLine: () => "this Mac", nativePlatform: () => "darwin" }));
vi.mock("../nativeWeb", () => ({ isWebMode: () => false }));

import { computerInLine, computerNameOf, type ComputerNames } from "./computerName";

const MAC = "env_mac";
const BOX = "env_box";

/** The Mac's own window: environment zero is itself, and it is linked to the box. */
const macWindow: ComputerNames = { own: { id: MAC, name: "MacBook-Pro" }, environments: [{ id: "local", name: "This Mac" }, { id: BOX, name: "The box" }], web: false };
/** A PC's window, linked to the Mac under the name the Mac gave in its hello. */
const linkedWindow: ComputerNames = { own: { id: "env_pc", name: "PURDUE-LT" }, environments: [{ id: "local", name: "This PC" }, { id: MAC, name: "MacBook-Pro" }, { id: BOX, name: "The box" }], web: false };
/** The box's web page: no link to the Mac; the box lists it by its hostname. */
const unlinkedWindow: ComputerNames = { own: { id: BOX, name: "The box" }, environments: [{ id: "web", name: "The box" }], web: true };

describe("a computer's one name", () => {
  it("is the same for one computer in its own window, a linked window and a window with no link", () => {
    expect(computerNameOf(MAC, macWindow).name).toBe("MacBook-Pro");
    expect(computerNameOf("local", macWindow).name).toBe("MacBook-Pro");
    expect(computerNameOf(MAC, linkedWindow).name).toBe("MacBook-Pro");
    expect(computerNameOf(MAC, unlinkedWindow, "MacBook-Pro.attlocal.net").name).toBe("MacBook-Pro");
  });

  it("marks only this window's own computer, by either of its ids", () => {
    expect(computerNameOf(MAC, macWindow).own).toBe(true);
    expect(computerNameOf("local", macWindow).own).toBe(true);
    expect(computerNameOf(BOX, macWindow)).toEqual({ name: "The box", own: false });
    expect(computerNameOf(MAC, linkedWindow).own).toBe(false);
  });

  it("calls no computer this Mac in a browser: the page's own computer is the one it is served from", () => {
    expect(computerNameOf(BOX, unlinkedWindow)).toEqual({ name: "The box", own: false });
    expect(computerNameOf("web", unlinkedWindow)).toEqual({ name: "The box", own: false });
  });

  it("keeps the name he gave a linked computer", () => {
    const renamed: ComputerNames = { ...linkedWindow, environments: [{ id: MAC, name: "Desk Mac" }] };
    expect(computerNameOf(MAC, renamed).name).toBe("Desk Mac");
  });

  it("falls back to its window's word before this computer has said its name, and never to an id", () => {
    expect(computerNameOf("local", { ...macWindow, own: { id: null, name: null } })).toEqual({ name: "This Mac", own: true });
    // An id never goes on screen.
    expect(computerNameOf("env_x", macWindow).name).toBe("Another computer");
    // At the box's web page the page's own computer is the one saved under the page's id, whatever that id is.
    expect(computerNameOf("local", { own: { id: null, name: null }, environments: [{ id: "local", name: "The box" }], web: true })).toEqual({ name: "The box", own: false });
  });

  it("reads mid-line: this Mac for the window's own, a common noun lowered", () => {
    expect(computerInLine(computerNameOf(MAC, macWindow))).toBe("this Mac");
    expect(computerInLine(computerNameOf(BOX, macWindow))).toBe("the box");
    expect(computerInLine(computerNameOf(MAC, linkedWindow))).toBe("MacBook-Pro");
  });
});

describe("a job's row for one computer", () => {
  it("reads the same name in a Mac window, a linked window and an unlinked window", async () => {
    const { jobDesktopNameIn } = await import("./jobComputers");
    // The Mac's own window lists it by its link; the PC's window by its saved link; the box's web page by what the box said.
    expect(jobDesktopNameIn({ link: "local", host: MAC, name: "This Mac" }, macWindow)).toEqual({ name: "MacBook-Pro", own: true });
    expect(jobDesktopNameIn({ link: MAC, host: MAC, name: "MacBook-Pro" }, linkedWindow)).toEqual({ name: "MacBook-Pro", own: false });
    expect(jobDesktopNameIn({ link: MAC, host: MAC, name: "MacBook-Pro.attlocal.net" }, unlinkedWindow)).toEqual({ name: "MacBook-Pro", own: false });
  });

  it("says a computer refuses the job's computer only where its Files and commands for it are Off", async () => {
    const { refusesJob, refusalWords } = await import("./jobComputers");
    expect(refusesJob([{ environmentId: BOX, policy: "off" }], BOX)).toBe(true);
    expect(refusesJob([{ environmentId: BOX, policy: "read" }], BOX)).toBe(false);
    expect(refusesJob([{ environmentId: "env_other", policy: "off" }], BOX)).toBe(false);
    expect(refusesJob(null, BOX)).toBe(false);
    expect(refusalWords({ name: "MacBook-Pro", own: true }, "the box")).toBe("This Mac gives the box no access.");
    expect(refusalWords({ name: "PURDUE-LT", own: false }, "the box")).toBe("PURDUE-LT gives the box no access. Change it on PURDUE-LT, under Sharing.");
  });
});
