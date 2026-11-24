import { describe, expect, it } from "vitest";
import { nameInLine } from "./hostWords";

/** Council round 5 (Opus Today 1): one rule for a host's name mid-line, the local computer's too. */
describe("a host's name mid-line", () => {
  it("lowers a name that is a common noun, the registry's words for this machine included, and keeps a proper name", () => {
    expect(nameInLine("The box")).toBe("the box");
    expect(nameInLine("This Mac")).toBe("this Mac");
    expect(nameInLine("This PC")).toBe("this PC");
    expect(nameInLine("This host")).toBe("this host");
    expect(nameInLine("The Purdue Office")).toBe("The Purdue Office");
    expect(nameInLine("MacBook")).toBe("MacBook");
    expect(nameInLine("tempcode-box")).toBe("tempcode-box");
  });
});
