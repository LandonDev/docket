import { describe, expect, it } from "vitest";
import { mailChatSubject } from "./subject";
import { mailRoom } from "./layout";

describe("the room the chat leaves Mail", () => {
  it("sits beside the mail at its width, Mail laying out in what it leaves", () => {
    expect(mailRoom(1280, true, 360)).toEqual({ over: false, dock: 360, mail: 920, narrow: false });
  });

  it("leaves the list and the reader to take turns when the room left is 640px or less", () => {
    expect(mailRoom(1000, true, 360)).toEqual({ over: false, dock: 360, mail: 640, narrow: true });
  });

  it("lies over the whole view when the room left would be under 480px", () => {
    expect(mailRoom(800, true, 360)).toEqual({ over: true, dock: 0, mail: 800, narrow: false });
    expect(mailRoom(600, true, 360).over).toBe(true);
  });

  it("never takes more than leaves the mail 480px, nor goes under 360 or over 720", () => {
    expect(mailRoom(1000, true, 700).dock).toBe(520);
    expect(mailRoom(2000, true, 900).dock).toBe(720);
    expect(mailRoom(2000, true, 100).dock).toBe(360);
  });

  it("closed, leaves Mail the whole view", () => {
    expect(mailRoom(1280, false, 360)).toEqual({ over: false, dock: 0, mail: 1280, narrow: false });
    expect(mailRoom(600, false, 360).narrow).toBe(true);
  });
});

describe("what the chat is about", () => {
  const view = { box: "inbox" as const, threadId: null, subject: null, query: null, picked: [] as string[] };

  it("is the open mail, named by its subject, its chip the mail", () => {
    const s = mailChatSubject("w1", { ...view, threadId: "t1", subject: "Lunch on Friday", picked: ["a", "b"] });
    expect(s).toMatchObject({ kind: "mail", key: "mail/w1/mail:t1", title: "Lunch on Friday", mailThreadId: "t1" });
    expect(s.chip).toEqual({ kind: "mail", label: "Lunch on Friday", ref: { at: "lifeos", table: "mailThreads", id: "t1" } });
  });

  it("keeps a long subject to one line of 300 characters", () => {
    const s = mailChatSubject("w1", { ...view, threadId: "t1", subject: `Hi\n${"x".repeat(900)}` });
    expect(s.title.length).toBe(300);
    expect(s.chip.label).not.toContain("\n");
  });

  it("is two or more ticked rows, named by their count, their chip ids alone", () => {
    const s = mailChatSubject("w1", { ...view, picked: ["b", "a", "c"] });
    expect(s).toMatchObject({ kind: "picked", key: "mail/w1/picked:a,b,c", title: "3 mails" });
    expect(s.chip).toEqual({ kind: "selection", label: "3 mails", quote: "a\nb\nc", ref: { at: "work", pillar: "mail", id: "picked" } });
  });

  it("is the search in view, else the mailbox", () => {
    expect(mailChatSubject("w1", { ...view, query: "from:dana" })).toMatchObject({ kind: "box", title: "Search: from:dana", key: "mail/w1/search:from:dana" });
    const box = mailChatSubject("w1", { ...view, box: "waiting", picked: ["a"] });
    expect(box).toMatchObject({ kind: "box", title: "Waiting on", key: "mail/w1/box:waiting" });
    expect(box.chip.quote).toBe("Mailbox: waiting");
  });
});

describe("a mail chat's harness", () => {
  it("starts on Claude where the default is Muse, which cannot be kept from its shell, and is left alone otherwise", async () => {
    const { onClaude } = await import("./MailDock");
    const { newSession } = await import("../../../lib/session");
    const muse = { ...newSession("box", "muse", "/w", undefined, undefined, undefined, { projectId: null, workspaceId: "w1" }), id: "d1" };
    const moved = onClaude(muse);
    expect(moved).toMatchObject({ id: "d1", harness: "claude", workspaceId: "w1" });
    const codex = newSession("box", "codex", "/w");
    expect(onClaude(codex)).toBe(codex);
  });
});

describe("a task's or an event's time", () => {
  it("reads a day alone as 09:00 that day in his zone, never the day before", async () => {
    const { formOf, localOf } = await import("./AddRow");
    expect(formOf("2026-11-25")).toEqual({ day: "2026-11-25", time: "09:00" });
    expect(formOf("2026-12-04T12:30:00")).toEqual({ day: "2026-12-04", time: "12:30" });
    expect(localOf("not a time")).toBeNull();
  });
});
