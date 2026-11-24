// @vitest-environment jsdom
/** A deck section not added or renamed says why in his words (`workErrorWords`), never the host's raw text. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HandSession } from "./session";
import type { NameAsk } from "./slides";
import { SectionName } from "./SectionName";

afterEach(cleanup);

/** The dialog's red line, once it is drawn. */
const said = () =>
  waitFor(() => {
    const line = document.querySelector<HTMLElement>("p.text-destructive");
    if (!line) throw new Error("no line yet");
    return line;
  });

const ask = { act: "add", slide: { id: "s2" } } as unknown as NameAsk;
const failing = (error: Error) => ({ editOrThrow: () => Promise.reject(error) }) as unknown as HandSession;

describe("a section that does not save", () => {
  it("says a lost answer is unsure, and its own line for raw text", async () => {
    render(<SectionName ask={ask} session={failing(new Error("No answer in 4 s"))} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await said()).textContent).toBe("That computer did not confirm the change. Check whether it went through before you try again.");
    cleanup();
    render(<SectionName ask={ask} session={failing(new Error("work.slides.edit: deck /srv/x.pptx locked"))} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await said()).textContent).toBe("The section did not save.");
  });
});
