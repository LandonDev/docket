import { describe, expect, it } from "vitest";
import { sentChipsOf } from "./sentChips";

describe("a sent message's chips", () => {
  it("are the leading chip lines, their quoted lines left out, and his words follow", () => {
    const text = "About this task: Book the ballroom (LifeOS tasks k1)\n> For April 10\nAbout this held act: Reply to Dana (Work outbox h1)\n\nSay what the insurance must cover.";
    expect(sentChipsOf(text)).toEqual({
      chips: [
        { noun: "task", label: "Book the ballroom", ref: "LifeOS tasks k1" },
        { noun: "held act", label: "Reply to Dana", ref: "Work outbox h1" },
      ],
      text: "Say what the insurance must cover.",
    });
  });

  it("stand alone when nothing was typed, and follow a slash command", () => {
    expect(sentChipsOf("About this item: Budget (canvas item i1)")).toEqual({ chips: [{ noun: "item", label: "Budget", ref: "canvas item i1" }], text: "" });
    expect(sentChipsOf("/summarize the morning\n\nAbout this mail: Re: (Ballroom) (LifeOS mailThreads m1)")).toEqual({
      chips: [{ noun: "mail", label: "Re: (Ballroom)", ref: "LifeOS mailThreads m1" }],
      text: "/summarize the morning",
    });
  });

  it("leave a message alone that only looks like one", () => {
    expect(sentChipsOf("/review the plan\n\nfirst part\n\nAbout this task: X (LifeOS tasks k1)").chips).toHaveLength(1);
    for (const text of ["About this task: no reference here", "About this bug: login fails (see logs)\n\nIt started Monday.", "About this task: X (LifeOS tasks k1)\nand words with no blank line", "Hello\n\nAbout this task: X (LifeOS tasks k1)"]) {
      expect(sentChipsOf(text)).toEqual({ chips: [], text });
    }
  });
});
