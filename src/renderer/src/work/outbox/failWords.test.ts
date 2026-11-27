/** The Outbox's failures in his words: a host's text inside an answer is worded, a raw one gives way to the act's line. */
import { describe, expect, it } from "vitest";
import { itemFailWords, pressFailWords } from "./failWords";
import { notSentWords } from "./store";

describe("a failed held item's reason", () => {
  it("keeps a reason already written for him", () => {
    expect(itemFailWords({ error: "LifeOS refused the send: the attachment is over 25 MB" })).toBe("LifeOS refused the send: the attachment is over 25 MB");
  });

  it("words a raw reason, and gives way to its own line where nothing is fit to show", () => {
    expect(itemFailWords({ error: "forbidden: work.outbox.send needs admin" }, "the box")).toBe("This computer's key may not do that on the box. Do it from a computer that manages the box.");
    expect(itemFailWords({ error: "ENOENT: /srv/agents/x/y.json" })).toBe("The file or folder was moved or removed. Refresh Files and open it from where it is now.");
    expect(itemFailWords({ error: "work.outbox.send failed at /home/u/.temp-code/x" })).toBe("It couldn't be sent");
    expect(itemFailWords({ error: null })).toBe("It couldn't be sent");
  });

  it("says a lost answer is unknown only when the send may have gone", () => {
    expect(itemFailWords({ error: "No answer in 4 s", outcomeUnknown: true }, "the box")).toMatch(/did not confirm the change/);
    expect(itemFailWords({ error: "No answer in 4 s" }, "the box")).toMatch(/did not answer/);
  });
});

describe("a press that went wrong", () => {
  it("is worded as a change, else says the act's own line", () => {
    expect(pressFailWords(new Error("timed out"), "It was not discarded", "the box")).toMatch(/^The box did not confirm the change/);
    expect(pressFailWords(new Error('[{"code":"invalid_type","path":["ref"]}]'), "It was not discarded")).toMatch(/could not read this request/);
    expect(pressFailWords(new Error("at work.outbox.discard /x/y"), "It was not discarded")).toBe("It was not discarded");
  });

  it("words what a refused press answers", () => {
    expect(notSentWords({ state: "failed", error: "spawn osascript ENOENT" })).toBe("That computer is missing a program it needs for this.");
    expect(notSentWords({ state: "stale", error: null })).toBe("It changed since it was held; look again");
    expect(notSentWords({ state: "discarded", error: null })).toBe("Already discarded");
  });
});
