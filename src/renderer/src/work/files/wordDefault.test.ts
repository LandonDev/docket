// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setWordDefault, WORD_DEFAULTS, wordDefault } from "./wordDefault";

afterEach(() => localStorage.clear());

describe("how a Teams Word file saves before he chose for it", () => {
  it("asks the first time unless Settings → Work says otherwise, and keeps what he set", () => {
    expect(wordDefault()).toBe("ask");
    setWordDefault("press");
    expect(wordDefault()).toBe("press");
    localStorage.setItem("tc.work.wordSave", "nonsense");
    expect(wordDefault()).toBe("ask");
    expect(WORD_DEFAULTS.map((d) => d.label)).toEqual(["Ask the first time", "As I work", "When I press Save"]);
  });
});
