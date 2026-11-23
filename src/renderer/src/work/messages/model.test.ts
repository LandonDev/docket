import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@shared/work/messages";
import { aroundMatch, blocksOf, isPicture, pictureBox, chatFact, dayWords, linkParts, markWords, newSince, opensOutside, rowLine, rowTime, wantsRead } from "./model";
import { unreadFact } from "./facts";

const at = (d: number, h: number, mi = 0): number => new Date(2026, 10, d, h, mi).getTime();
const NOW = at(23, 15, 42);
const DANA = { name: "Dana Lee", me: false, personId: "p_dana" };
const OMAR = { name: "Omar Reyes", me: false, personId: "p_omar" };
const ME = { name: "Alex Kim", me: true };

/** Messages from lines, oldest first in, newest first out, as LifeOS answers. */
const page = (lines: [typeof DANA | typeof ME, number, string?][]): ChatMessage[] =>
  lines.map(([who, sentAt, text], i) => ({ _id: `m${i}`, who, sentAt, text: text ?? `line ${i}`, files: [] })).reverse();

describe("time words", () => {
  it("names a row's time by how long ago it was", () => {
    expect(rowTime(at(23, 9, 5), NOW)).toMatch(/9:05/);
    expect(rowTime(at(22, 23, 0), NOW)).toBe("Yesterday");
    expect(rowTime(at(19, 12), NOW)).toBe(new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(at(19, 12)));
    expect(rowTime(at(3, 12), NOW)).toBe(new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(at(3, 12)));
    expect(rowTime(new Date(2025, 4, 2).getTime(), NOW)).toMatch(/2025/);
  });

  it("names a conversation's day", () => {
    expect(dayWords(at(23, 8), NOW)).toBe("Today");
    expect(dayWords(at(22, 8), NOW)).toBe("Yesterday");
    expect(dayWords(at(20, 8), NOW)).toBe(new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(at(20, 8)));
    expect(dayWords(at(2, 8), NOW)).toBe(new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(at(2, 8)));
  });
});

describe("a row's words", () => {
  const row = { kind: "channel" as const, lastText: "Nightly is   green\nagain", lastWho: "Theo Park", lastFromMe: false };
  it("leads a channel's or group's words with the writer's first name", () => {
    expect(rowLine(row)).toBe("Theo: Nightly is green again");
  });
  it("leads his own with You and a direct chat's with nothing", () => {
    expect(rowLine({ ...row, lastFromMe: true })).toBe("You: Nightly is green again");
    expect(rowLine({ ...row, kind: "direct" })).toBe("Nightly is green again");
  });
  it("says the source and the account once", () => {
    expect(chatFact({ source: "slack", accountName: "Starboard Games" })).toBe("Slack, Starboard Games");
    expect(chatFact({ source: "imessage" })).toBe("iMessage");
  });
  it("counts the unread fact only when there is one", () => {
    expect(unreadFact(3)).toBe("3");
    expect(unreadFact(0)).toBeNull();
    expect(unreadFact(undefined)).toBeNull();
  });
});

describe("runs and days", () => {
  it("groups one writer's messages inside five minutes, and starts a run past them or for another writer", () => {
    const blocks = blocksOf(
      page([
        [DANA, at(23, 10, 0)],
        [DANA, at(23, 10, 4)],
        [DANA, at(23, 10, 12)],
        [OMAR, at(23, 10, 13)],
        [ME, at(23, 10, 14)],
        [ME, at(23, 10, 15)],
      ]),
      null,
      NOW,
    );
    expect(blocks.map((b) => b.head)).toEqual([true, false, true, true, true, false]);
  });

  it("opens each day with its date and starts a run there", () => {
    const blocks = blocksOf(
      page([
        [DANA, at(22, 23, 58)],
        [DANA, at(23, 0, 1)],
      ]),
      null,
      NOW,
    );
    expect(blocks.map((b) => b.day)).toEqual(["Yesterday", "Today"]);
    expect(blocks.map((b) => b.head)).toEqual([true, true]);
  });

  it("puts New over the first message from someone else after he last saw it, and starts a run there", () => {
    const lines = page([
      [DANA, at(23, 10, 0)],
      [ME, at(23, 10, 1)],
      [DANA, at(23, 10, 2)],
      [DANA, at(23, 10, 3)],
    ]);
    const blocks = blocksOf(lines, at(23, 10, 1), NOW);
    expect(blocks.map((b) => b.isNew)).toEqual([false, false, true, false]);
    expect(blocks[2]!.head).toBe(true);
    expect(blocksOf(lines, null, NOW).some((b) => b.isNew)).toBe(false);
  });

  it("puts no New over the first message held while older ones are still to come", () => {
    const blocks = blocksOf(page([[DANA, at(23, 10)]]), at(23, 9), NOW, false);
    expect(blocks[0]!.isNew).toBe(false);
  });

  it("knows where New starts as a conversation opens", () => {
    expect(newSince({ unread: false, readAt: undefined })).toBeNull();
    expect(newSince({ unread: true, readAt: undefined, lastOutAt: 5 })).toBe(5);
    expect(newSince({ unread: false, readAt: 9, sourceReadAt: 12 })).toBe(12);
  });

  it("marks a conversation read on open when it is unread or someone wrote since", () => {
    expect(wantsRead({ unread: true })).toBe(true);
    expect(wantsRead({ unread: false, lastInAt: 10, readAt: 5 })).toBe(true);
    expect(wantsRead({ unread: false, lastInAt: 10, readAt: 12 })).toBe(false);
    expect(wantsRead({ unread: false, lastInAt: 10, lastOutAt: 11 })).toBe(false);
  });
});

describe("links", () => {
  it("finds http, https and mailto links and leaves a sentence's stop outside", () => {
    expect(linkParts("See https://x.dev/a?b=1. Or mail me: mailto:dana@x.dev")).toEqual([
      { text: "See " },
      { text: "https://x.dev/a?b=1", href: "https://x.dev/a?b=1" },
      { text: ". Or mail me: " },
      { text: "mailto:dana@x.dev", href: "mailto:dana@x.dev" },
    ]);
    expect(linkParts("(https://x.dev/wiki/Foo_(bar))")[1]).toEqual({ text: "https://x.dev/wiki/Foo_(bar)", href: "https://x.dev/wiki/Foo_(bar)" });
  });

  it("opens nothing but http, https and mailto", () => {
    expect(opensOutside("https://x.dev")).toBe(true);
    expect(opensOutside("mailto:a@b.c")).toBe(true);
    expect(opensOutside("javascript:alert(1)")).toBe(false);
    expect(opensOutside("file:///etc/passwd")).toBe(false);
    expect(linkParts("ftp://x.dev/a").every((part) => !part.href)).toBe(true);
  });

  it("keeps plain text whole", () => {
    expect(linkParts("two\nlines")).toEqual([{ text: "two\nlines" }]);
  });
});

describe("a search's lit words", () => {
  it("lights the words where a word starts, whatever their case", () => {
    expect(markWords("The controller fix is in", "CONTROL fix")).toEqual([
      ["The ", false],
      ["control", true],
      ["ler ", false],
      ["fix", true],
      [" is in", false],
    ]);
  });
  it("starts a long message's line a little before what it found", () => {
    const text = "Seeing a spike of save sync failures on the new build, and the controller fix is still pending";
    expect(aroundMatch(text, "controller")).toBe("…the new build, and the controller fix is still pending");
    expect(aroundMatch("The controller fix", "controller")).toBe("The controller fix");
    expect(aroundMatch("nothing here", "zebra")).toBe("nothing here");
  });
  it("leaves a word's middle alone", () => {
    expect(markWords("recontrol", "control")).toEqual([["recontrol", false]]);
  });
});

describe("pictures", () => {
  it("draws a picture in its own shape inside 360 by 270, never larger than it is", () => {
    expect(pictureBox({ width: 1600, height: 900 })).toEqual({ width: 360, height: 203 });
    expect(pictureBox({ width: 900, height: 1200 })).toEqual({ width: 203, height: 270 });
    expect(pictureBox({ width: 120, height: 80 })).toEqual({ width: 120, height: 80 });
    expect(pictureBox({})).toEqual({ width: 270, height: 270 });
  });
  it("knows a picture by its type, else by its name", () => {
    expect(isPicture({ name: "a.bin", contentType: "image/heic" })).toBe(true);
    expect(isPicture({ name: "IMG_2041.HEIC" })).toBe(true);
    expect(isPicture({ name: "budget.xlsx", contentType: "application/vnd.ms-excel" })).toBe(false);
  });
});
