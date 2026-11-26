import { describe, expect, it } from "vitest";
import { steerFailureWords } from "./steerWords";

describe("steerFailureWords", () => {
  it("words the cause, never the host's raw line", () => {
    expect(steerFailureWords(new Error("not connected"), true)).toBe("Couldn't steer. Its computer isn't answering.");
    expect(steerFailureWords(new Error("forbidden: queue.add needs operate"), true)).toBe("Couldn't steer. This computer may not message it.");
    expect(steerFailureWords(new Error("no live harness"), true)).toBe("Couldn't steer. It has already finished.");
    expect(steerFailureWords(new Error("unknown session s1"), false)).toBe("Couldn't send. This agent is gone.");
    expect(steerFailureWords("server router not bound (queue.add)", true)).toBe("Couldn't steer. Try again.");
  });
});
