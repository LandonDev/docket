import { describe, expect, it } from "vitest";
import { editVerb } from "./EditRow";

/** A Work thread's edit row leads with what happened to the file; a code thread keeps the tool's verb. */
describe("an edit row's verb", () => {
  it("in a Work thread says Changed, Made or Removed once the edit is done", () => {
    expect(editVerb({ create: false, remove: false }, "Edited", { work: true, running: false })).toBe("Changed");
    expect(editVerb({ create: true, remove: false }, "Created", { work: true, running: false })).toBe("Made");
    expect(editVerb({ create: false, remove: true }, "Deleted", { work: true, running: false })).toBe("Removed");
  });

  it("keeps the tool's verb while it runs, and always in a code thread", () => {
    expect(editVerb({ create: false, remove: false }, "Editing", { work: true, running: true })).toBe("Editing");
    expect(editVerb({ create: true, remove: false }, "Created", { work: false, running: false })).toBe("Created");
  });
});
