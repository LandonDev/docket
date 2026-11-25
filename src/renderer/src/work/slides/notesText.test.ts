import { describe, expect, it } from "vitest";
import { notesShown, notesTyped } from "./notesText";

/** A line break inside a notes paragraph (python-pptx's `\v`) shown as a line and written back as one. */
describe("notes' line breaks", () => {
  const notes = "Thank the sponsors\vDoors open at six\nThen the plan";

  it("draw a break inside a paragraph as a line break, never as a box", () => {
    expect(notesShown(notes)).toBe("Thank the sponsors\nDoors open at six\nThen the plan");
  });

  it("go back as they came when he types in a line, and a line he starts is a paragraph", () => {
    expect(notesTyped("Thank the sponsors\nDoors open at six\nThen the plan", notes)).toBe(notes);
    expect(notesTyped("Thank all the sponsors\nDoors open at six sharp\nThen the plan", notes)).toBe("Thank all the sponsors\vDoors open at six sharp\nThen the plan");
    expect(notesTyped("Thank the sponsors\nDoors open at six\nThen the plan\nQuestions", notes)).toBe(`${notes}\nQuestions`);
    expect(notesTyped("Welcome\nThank the sponsors\nDoors open at six\nThen the plan", notes)).toBe(`Welcome\n${notes}`);
    expect(notesTyped("Thank the sponsors\nDoors open\nat six\nThen the plan", notes)).toBe("Thank the sponsors\vDoors open\nat six\nThen the plan");
    // A break he takes out goes; notes with none are as he typed them.
    expect(notesTyped("Thank the sponsors Doors open at six\nThen the plan", notes)).toBe("Thank the sponsors Doors open at six\nThen the plan");
    expect(notesTyped("One\nTwo", "One")).toBe("One\nTwo");
  });

  it("keep each old break once: Return beside a break makes one paragraph, never a second break", () => {
    // Council r4 (Sol 2): Return just before PowerPoint's Shift+Return came back as two breaks in one paragraph.
    expect(notesTyped("first\n\nsecond", "first\vsecond")).toBe("first\v\nsecond");
    expect(notesTyped("first\n\nsecond", "first\vsecond", 7)).toBe("first\v\nsecond");
    expect(notesTyped("first\nmiddle\nsecond", "first\vsecond")).toBe("first\vmiddle\nsecond");
    expect(notesTyped("a\nb\n\nc\nd", "a\vb\vc\nd")).toBe("a\vb\v\nc\nd");
    // Lines taken out between two ends: the end after the head stays.
    expect(notesTyped("a\nc", "a\vb\nc")).toBe("a\vc");
  });

  it("make a paragraph where Return was pressed, by the caret: before a break, the break stays after it", () => {
    // Council r5 (Sol 5): Return at the end of "first", before the break, wrote the paragraph after the break.
    expect(notesTyped("first\n\nsecond", "first\vsecond", 6)).toBe("first\n\vsecond");
    // Typed on, the field's next edit keeps that order.
    expect(notesTyped("first\nmore\n\nsecond", "first\n\vsecond", 10)).toBe("first\nmore\n\vsecond");
    // A break he joins with Delete just before it goes, the paragraph after it stays.
    expect(notesTyped("firstsecond\nthird", "first\vsecond\nthird", 5)).toBe("firstsecond\nthird");
    // An edit away from the caret (undo) is read as late as it can be.
    expect(notesTyped("first\n\nsecond", "first\vsecond", 0)).toBe("first\v\nsecond");
  });
});
