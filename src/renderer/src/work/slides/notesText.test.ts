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
});
