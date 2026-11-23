import { beforeEach, describe, expect, it } from "vitest";
import type { ContextChip } from "@shared/work";
import { chipPort } from "../../lib/contextChips";
import { aboutFor, addContextChip, chipLine, CHIPS_MAX, contextChipsOf, removeContextChip, resetContextChips, startAboutChip, takeContextChips, withContextChips } from "./chips";

const task: ContextChip = { kind: "task", label: "Book the ballroom for April 10", ref: { at: "lifeos", table: "tasks", id: "k1" } };
const mail: ContextChip = { kind: "mail", label: "Re: Ballroom for April 10", ref: { at: "lifeos", table: "mailThreads", id: "m1" } };
const selection: ContextChip = {
  kind: "selection",
  label: "“Pools run on 24 stations”, Spring LAN run of show",
  ref: { at: "file", host: "box", path: "/w/Spring LAN/run of show.tcdoc" },
  quote: "Pools run on 24 stations\nuntil noon.",
};

beforeEach(resetContextChips);

describe("what a message is about", () => {
  it("holds a thread's chips in the order they came, each once", () => {
    addContextChip("t1", task);
    addContextChip("t1", mail);
    addContextChip("t1", { ...task });
    addContextChip("t2", selection);
    expect(contextChipsOf("t1")).toEqual([task, mail]);
    expect(contextChipsOf("t2")).toEqual([selection]);
    expect(contextChipsOf("t3")).toEqual([]);
    expect(contextChipsOf(undefined)).toEqual([]);
  });

  it("removes one by its place, and holds a few, not a list", () => {
    addContextChip("t1", task);
    addContextChip("t1", mail);
    removeContextChip("t1", 0);
    expect(contextChipsOf("t1")).toEqual([mail]);
    for (let i = 0; i < CHIPS_MAX + 3; i++) addContextChip("t1", { ...task, ref: { at: "lifeos", table: "tasks", id: `k${i}` } });
    expect(contextChipsOf("t1")).toHaveLength(CHIPS_MAX);
  });

  const draft = (): boolean => false;
  const exists = (): boolean => true;

  it("gives the chips to the send that takes them, once", () => {
    addContextChip("t1", task);
    expect(takeContextChips("t1", false)).toEqual([task]);
    expect(contextChipsOf("t1")).toEqual([]);
    expect(takeContextChips("t1", false)).toEqual([]);
    // A thread that exists has nothing for a create to say.
    expect(aboutFor("t1", draft)).toBeUndefined();
  });

  it("keeps a draft's first chip for its create until the thread exists, so a create tried again still says it", () => {
    addContextChip("d1", mail);
    addContextChip("d1", task);
    takeContextChips("d1", true);
    expect(aboutFor("d1", draft)).toEqual(mail);
    // The create failed and is tried again.
    expect(aboutFor("d1", draft)).toEqual(mail);
    // The thread exists: nothing is left to say, now or later.
    expect(aboutFor("d1", exists)).toBeUndefined();
    expect(aboutFor("d1", draft)).toBeUndefined();
    // A first send with no chip says nothing.
    takeContextChips("d2", true);
    expect(aboutFor("d2", draft)).toBeUndefined();
  });

  it("answers the composer through the first paint's port", () => {
    expect(chipPort.get()?.count("t1")).toBe(0);
    addContextChip("t1", task);
    expect(chipPort.get()?.count("t1")).toBe(1);
    expect(chipPort.get()?.send("t1", false, "Go")).toBe(`${chipLine(task)}\n\nGo`);
    expect(chipPort.get()?.count("t1")).toBe(0);
    // With no chip the words go as they are.
    expect(chipPort.get()?.send("t1", false, "Go")).toBe("Go");
  });
});

describe("a thread started about something", () => {
  it("leads with the chip just picked, which replaces a LifeOS chip an unsent draft held, and keeps a selection", () => {
    addContextChip("d", task);
    addContextChip("d", selection);
    startAboutChip("d", mail);
    expect(contextChipsOf("d")).toEqual([mail, selection]);
    // What the first send says the thread is about is the newest start's.
    takeContextChips("d", true);
    expect(aboutFor("d", () => false)).toEqual(mail);
  });
});

describe("a chip as the model reads it", () => {
  it("is one line that names the thing and where it is", () => {
    expect(chipLine(task)).toBe("About this task: Book the ballroom for April 10 (LifeOS tasks k1)");
    expect(chipLine(mail)).toBe("About this mail: Re: Ballroom for April 10 (LifeOS mailThreads m1)");
    expect(chipLine({ kind: "chat", label: "Dana Lee in Slack", ref: { at: "lifeos", table: "chats", id: "c1" } })).toBe("About this conversation: Dana Lee in Slack (LifeOS chats c1)");
  });

  it("quotes a task's notes under its line when the chip carries them (a code thread that cannot read LifeOS)", () => {
    expect(chipLine({ ...task, quote: "Ask for the east hall.\nBudget 2k" })).toBe("About this task: Book the ballroom for April 10 (LifeOS tasks k1)\n> Ask for the east hall.\n> Budget 2k");
  });

  it("quotes a selection's words under its line", () => {
    expect(chipLine(selection)).toBe(
      "About this selection: “Pools run on 24 stations”, Spring LAN run of show (/w/Spring LAN/run of show.tcdoc)\n> Pools run on 24 stations\n> until noon.",
    );
    // A LifeOS row reads by its table and id; any other source as it is written, for the model's tools to take.
    expect(chipLine({ ...selection, ref: { at: "lifeos", table: "docs", id: "d1" }, quote: undefined })).toBe(
      "About this selection: “Pools run on 24 stations”, Spring LAN run of show (LifeOS docs d1)",
    );
    expect(chipLine({ kind: "selection", label: "B4:C9, Invoices 2026", ref: { at: "google", account: "a", fileId: "f", mime: "m" } })).toBe(
      'About this selection: B4:C9, Invoices 2026 ({"at":"google","account":"a","fileId":"f","mime":"m"})',
    );
  });

  it("names a mention by its noun and reference, its excerpt quoted under it", () => {
    expect(chipLine({ kind: "held", label: "Reply to Dana", ref: { at: "work", pillar: "outbox", id: "h1" }, excerpt: "Thanks, the 10th works.\nSee you then." })).toBe(
      "About this held act: Reply to Dana (Work outbox h1)\n> Thanks, the 10th works.\n> See you then.",
    );
    expect(chipLine({ kind: "item", label: "Budget", ref: { at: "item", id: "i1" } })).toBe("About this item: Budget (canvas item i1)");
    expect(chipLine({ kind: "project", label: "Spring LAN", ref: { at: "lifeos", table: "projects", id: "p1" }, excerpt: "  " })).toBe(
      "About this project: Spring LAN (LifeOS projects p1)",
    );
  });

  it("goes above the person's words, and stands alone when there are none", () => {
    expect(withContextChips([], "Tighten the morning")).toBe("Tighten the morning");
    expect(withContextChips([task], "")).toBe(chipLine(task));
    expect(withContextChips([task, mail], "Say what the insurance must cover.")).toBe(`${chipLine(task)}\n${chipLine(mail)}\n\nSay what the insurance must cover.`);
  });

  it("leaves a slash command at the start, where a harness reads it", () => {
    expect(withContextChips([selection], "/summarize the morning")).toBe(`/summarize the morning\n\n${chipLine(selection)}`);
  });
});
