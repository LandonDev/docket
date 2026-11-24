// @vitest-environment jsdom
/** A signature that does not save says why in his words (`workErrorWords`), never the host's raw text. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SignaturePad } from "./Fields";

afterEach(cleanup);

/** The dialog's red line, once it is drawn. */
const said = () =>
  waitFor(() => {
    const line = document.querySelector<HTMLElement>("p.text-destructive");
    if (!line) throw new Error("no line yet");
    return line;
  });

async function failWith(error: Error): Promise<string> {
  render(<SignaturePad onClose={() => undefined} onSave={() => Promise.reject(error)} />);
  const pad = (await waitFor(() => document.querySelector("[data-signature-pad]")!)) as unknown as SVGSVGElement;
  pad.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 160, right: 480, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
  (pad as unknown as HTMLElement).setPointerCapture = () => undefined;
  fireEvent.pointerDown(pad, { clientX: 10, clientY: 100, pointerId: 1 });
  fireEvent.pointerUp(pad, { pointerId: 1 });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sign" }));
  return (await said()).textContent ?? "";
}

describe("a signature that does not save", () => {
  it("says a lost answer is unsure, not a failure", async () => {
    expect(await failWith(new Error("No answer in 4 s"))).toBe("That computer did not confirm the change. Check whether it went through before you try again.");
  });

  it("says its own line where the host's text was never his", async () => {
    expect(await failWith(new Error("work.pdf.setSignature: EACCES at /srv/agents/x/sig.json"))).toBe("This computer could not change the file in that folder. Check that you may edit it there, or save a copy somewhere you may.");
    cleanup();
    expect(await failWith(new Error("work.pdf.setSignature failed at /srv/agents/x"))).toBe("The signature did not save.");
  });
});
