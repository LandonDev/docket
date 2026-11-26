// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FailLine, rawError } from "./FailLine";

afterEach(cleanup);

describe("FailLine", () => {
  it("says a failure as one red 12px line in plain words, the raw text never on screen", () => {
    render(<FailLine words="Couldn't load this issue" detail="gh: HTTP 502" className="px-3" />);
    const line = screen.getByRole("alert");
    expect(line.textContent).toBe("Couldn't load this issue");
    expect(line.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-xs", "text-destructive", "px-3"]));
    expect(document.body.textContent).not.toContain("502");
  });

  it("draws the bare line when there is no raw text, or the raw text is the words", () => {
    render(<FailLine words="Run gh auth login to connect GitHub." detail="Run gh auth login to connect GitHub." />);
    expect(screen.getByRole("alert").getAttribute("data-slot")).toBe("fail-line");
  });

  it("reads the message of whatever a promise rejected with", () => {
    expect(rawError(new Error("boom"))).toBe("boom");
    expect(rawError("plain")).toBe("plain");
  });
});
