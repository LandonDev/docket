import { describe, expect, it } from "vitest";
import type { ClientRequest } from "@shared/contract";
import { capsMay, managedElsewhere, signInElsewhere } from "./linkMay";

const key = { id: "k1", name: "a key" };
const owner = { caps: ["read", "operate", "approve", "admin"] as const, key };
/** What a setup link gives a computer (docs/agents/pc-setup.md). */
const laptop = { caps: ["operate", "approve", "device"] as const, key };
const reader = { caps: ["read"] as const, key };

describe("what a link may do, by the host's own rule", () => {
  it("an owner's key may change a host's settings; a given computer's and a read key may not", () => {
    expect(capsMay(owner, "work.set", { enabled: true })).toBe(true);
    expect(capsMay(laptop, "work.set", { enabled: true })).toBe(false);
    expect(capsMay(reader, "work.set", { enabled: true })).toBe(false);
  });

  it("a given computer may operate and approve, and is never handed the host's LifeOS session", () => {
    expect(capsMay(laptop, "session.send")).toBe(true);
    expect(capsMay(laptop, "work.lifeos.jwt")).toBe(false);
    expect(capsMay(owner, "work.lifeos.jwt")).toBe(true);
    expect(capsMay(reader, "session.send")).toBe(false);
  });

  it("the window's own socket holds no key and may do everything, local-only calls too", () => {
    expect(capsMay({ caps: ["read", "operate", "approve", "admin", "give"] }, "work.set")).toBe(true);
    expect(capsMay({ caps: ["read", "operate", "approve", "admin", "give"] }, "work.lifeos.setToken")).toBe(true);
    // The same call from any key is refused: it is local-only.
    expect(capsMay(owner, "work.lifeos.setToken")).toBe(false);
  });

  it("hides nothing on a guess: no hello yet answers true", () => {
    expect(capsMay(null, "work.set")).toBe(true);
  });
});

/**
 * Every Work control that hides or words itself by `linkMay` (docs/agents/work.md "The switch"): the verdict for an
 * owner's key, a given computer's and a read key. A change to the capability tables that would make a hidden control
 * usable, or a shown one refused, fails here by name: change the control with it.
 */
const GATED: [method: ClientRequest["method"], control: string, owner: boolean, laptop: boolean, reader: boolean][] = [
  ["work.outbox.grant", "Outbox: Send and stop holding", true, false, false],
  ["work.outbox.ungrant", "Outbox: a grant's Remove and Undo", true, false, false],
  ["work.outbox.takeOffer", "Outbox: an offer's Stop holding", true, false, false],
  ["work.outbox.dismissOffer", "Outbox: an offer's Dismiss", true, false, false],
  ["work.routines.save", "Routines: New routine, Edit, a proposal's Add…", true, false, false],
  ["work.routines.remove", "Routines: a proposal's Dismiss, Delete", true, false, false],
  ["work.routines.runNow", "Routines: Run now", true, true, false],
  ["work.routines.pause", "Routines: Pause and Resume", true, true, false],
  ["work.routines.playSave", "Plays: New play, Edit, proposals, starters, Save as a play…", true, false, false],
  ["work.routines.playRemove", "Plays: Delete", true, false, false],
  ["work.routines.playStart", "Plays: a play's row press", true, true, false],
  ["work.digest.set", "Settings → Work → Digest", true, false, false],
  ["workspace.setAccounts", "A workspace's Accounts", true, false, false],
  ["project.setAccounts", "A project's Accounts", true, false, false],
  ["work.lifeos.link", "A code workspace's LifeOS sector, on its page and its rail row", true, false, false],
  ["work.mail.setWaiting", "A workspace's Waiting on", true, false, false],
  ["work.winvm.setup", "Windows VM: Set up", true, false, false],
  ["work.winvm.settings", "Windows VM: Sleeps after, Screen size", true, false, false],
  ["work.winvm.point.restore", "Windows VM: a point's Go back…", true, false, false],
  ["work.winvm.point.delete", "Windows VM: a point's Delete", true, false, false],
  ["work.winvm.wake", "Windows VM: Wake", true, true, false],
  ["work.winvm.sleep", "Windows VM: Sleep", true, true, false],
  ["work.winvm.point.save", "Windows VM: Save a point", true, true, false],
  ["work.office.vmSignIn", "Windows VM and Files: Sign in to OneDrive", true, true, false],
  ["work.workspace.set", "A workspace's Computer use, VM, Voice, and Files' Allow", true, false, false],
  ["defaults.set", "A Work workspace's model (its thread defaults)", true, false, false],
  ["work.office.filesCopySet", "Copy Teams files to …, Files' Open copies here", true, false, false],
  ["work.lifeos.pairStart", "LifeOS: Sign in", true, false, false],
  ["work.lifeos.pairCancel", "LifeOS: the sign-in's Cancel", true, false, false],
  ["work.lifeos.signOut", "Connections: LifeOS's Sign out", true, false, false],
  ["work.lifeos.setToken", "LifeOS: Or a device token (this window's own host alone)", false, false, false],
  ["work.files.restore", "Files → Trash: Put Back", true, true, false],
  ["work.files.purge", "Files → Trash: Delete for Good, Empty Trash", true, true, false],
  ["work.slides.show.state", "The clicker: the show's state", true, true, true],
  ["work.slides.show.press", "The clicker: Next, Previous, Blank, End, the timer", true, true, false],
];

describe("the Work controls a key cannot use", () => {
  it.each(GATED)("%s (%s): owner %s, given computer %s, read key %s", (method, _control, mine, given, read) => {
    expect([capsMay(owner, method), capsMay(laptop, method), capsMay(reader, method)]).toEqual([mine, given, read]);
  });

  it("names who can in one wording", () => {
    expect(managedElsewhere("The box")).toBe("Changed from a computer that manages the box");
  });

  it("names who can sign a host in to LifeOS by the act", () => {
    expect(signInElsewhere("The box")).toBe("Sign in from a computer that manages the box");
  });
});
