import { describe, expect, it } from "vitest";
import { LifeosStateSchema } from "@shared/contract-work-lifeos";
import { sessionFailure } from "./lifeos";
import { lifeosDownWords } from "./lifeosWords";

/** The rule's words with no weight (the capture window's), the same function lifeos.ts says them by. */
describe("lifeosDownWords", () => {
  const states = [...LifeosStateSchema.options.map((o) => o.shape.state.value), "unanswered" as const];
  it.each(states)("says %s as sessionFailure does", (state) => {
    for (const host of [undefined, null, "The box", "This Mac", "MacBook"])
      for (const withheld of [false, true]) expect(lifeosDownWords(state, withheld, host)).toBe(sessionFailure(state, withheld, host));
  });

  it("names this Mac mid-line and at the head", () => {
    expect(lifeosDownWords("signed-out", false, "This Mac")).toBe("Not signed in to LifeOS on this Mac");
    expect(lifeosDownWords("unreachable", false, "This Mac")).toBe("LifeOS did not answer this Mac");
    expect(lifeosDownWords("pairing", false, "This Mac")).toBe("The LifeOS sign-in on this Mac waits for your approval");
    expect(lifeosDownWords("refused", false, "This PC")).toBe("LifeOS refused this PC's sign-in");
    expect(lifeosDownWords("off", false, "This Mac")).toBe("Work is off on this Mac");
    expect(lifeosDownWords("unanswered", false, "This Mac")).toBe("This Mac did not answer");
  });
});
