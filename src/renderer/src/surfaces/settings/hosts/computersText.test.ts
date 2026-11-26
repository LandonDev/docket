import { describe, expect, it } from "vitest";
import { stepReasonWords, stepTitle } from "./computersText";

/** The setup steps' words (DOCKET's edges-20): the mark says the state, the title never does; no "Retry." beside Retry. */
describe("the setup steps' words", () => {
  it("names each step without its state", () => {
    expect(stepTitle("allow", "MacBook Pro")).toBe("Allow on MacBook Pro");
    expect(stepTitle("work", "MacBook Pro")).toBe("Work signed in to LifeOS");
  });

  it("says a failure without Retry in the sentence, and the LifeOS installer's without its exit code", () => {
    expect(stepReasonWords("link", "The box could not be saved. Retry.")).toBe("The box could not be saved.");
    expect(stepReasonWords("lifeos", "The installer stopped with code 1603")).toBe("The LifeOS installer did not finish.");
    expect(stepReasonWords("lifeos", "The installer did not finish: LifeOS-Setup.exe exited with code 1603")).toBe("The LifeOS installer did not finish.");
    expect(stepReasonWords("accounts", "The box is not connected")).toBe("The box is not connected.");
    expect(stepReasonWords("folders", null)).toBe("It did not finish.");
  });
});
