// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_RELEASE_NOTES } from "../lib/releaseNotes";
import { listedNotes } from "../lib/releaseNotesParse";
import { WhatsNewDialog, whatsNewLine } from "./WhatsNewDialog";

afterEach(cleanup);

describe("WhatsNewDialog", () => {
  it("sizes to its notes up to min(72vh, 640px), with no fixed height or second scroller", () => {
    render(
      <WhatsNewDialog
        version="9.9.9"
        markdown={"## [9.9.9] - 2026-09-03\n\n### Changed\n\n- One line\n"}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    const classes = dialog.className.split(/\s+/);
    expect(classes).toContain("max-h-[min(72vh,640px)]");
    expect(classes.some((c) => /^h-\[/.test(c))).toBe(false);
    expect(dialog.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
    expect(dialog.textContent).toContain("One line");
  });

  it("sets the date 4px after the release, and says missing notes in the release tab's words", () => {
    const { container } = render(<>{whatsNewLine("1.0.9", "Nov 5, 2026")}</>);
    expect((container.firstElementChild as HTMLElement).className).toContain("gap-1");
    expect((container.firstElementChild as HTMLElement).className).not.toContain("gap-1.5");
    cleanup();
    render(<WhatsNewDialog version="0.0.0-none" markdown="" onClose={vi.fn()} />);
    expect(screen.getByText(NO_RELEASE_NOTES)).toBeTruthy();
    expect(NO_RELEASE_NOTES).not.toMatch(/\.$/);
  });

  it("lists release.json-shaped notes, without the old Core marker, cut with and N more", () => {
    const subjects = Array.from({ length: 23 }, (_, i) => `Change ${i + 1} lands.`);
    render(<WhatsNewDialog version="9.9.8" markdown={`TempCode Core; ${subjects.join("; ")}`} onClose={vi.fn()} />);
    // The markdown handed to the drawer (jsdom shows it raw until the worker parses it; the preview shows the list).
    const text = screen.getByRole("dialog").querySelector("article")!.textContent!;
    expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(20);
    expect(text.startsWith("- Change 1 lands.\n")).toBe(true);
    expect(text).not.toContain("TempCode Core");
    expect(text.trimEnd().endsWith("and 3 more")).toBe(true);
    expect(listedNotes("- Already a list; with a semicolon")).toBe("- Already a list; with a semicolon");
    expect(listedNotes("Bug fixes.")).toBe("Bug fixes.");
    // A subject's own "; " stays inside it when subjects end with a stop.
    expect(listedNotes("TempCode Core; Fix the gate; test in a.test.ts.; Docs say so.")).toBe("- Fix the gate; test in a.test.ts.\n- Docs say so.");
  });
});
