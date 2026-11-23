// @vitest-environment jsdom
/**
 * Print… from the window (docs/agents/work-editors.md "Print"): the desktop
 * hands the PDF to main for this computer's own viewer; a browser opens it
 * in a tab on his press.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const web = vi.hoisted(() => ({ on: false }));
vi.mock("../../lib/native", () => ({
  isWebMode: () => web.on,
  // native.ts's own: the preload's call, which each test stands in for.
  printPdfFile: (name: string, bytes: Uint8Array) => (window as unknown as { api: { printPdf(name: string, bytes: Uint8Array): unknown } }).api.printPdf(name, bytes),
}));

import { PRINT_WORDS, TAB_MS, printPdf, type PrintSay } from "./printOut";

const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");

type Said = [string, { label: string; run(): void } | undefined];
function sayer(): { say: PrintSay; said: Said[] } {
  const said: Said[] = [];
  return { say: (words, action) => void said.push([words, action]), said };
}

beforeEach(() => {
  web.on = false;
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Print… from the window", () => {
  it("in the desktop app hands the name and the bytes to main, and says where they went", async () => {
    const asked: [string, Uint8Array][] = [];
    (window as unknown as { api: unknown }).api = { printPdf: async (name: string, bytes: Uint8Array) => (asked.push([name, bytes]), { ok: true, via: "viewer" }) };
    const { say, said } = sayer();
    expect(await printPdf("Plan.pdf", PDF, say)).toBe("viewer");
    expect(asked).toEqual([["Plan.pdf", PDF]]);
    expect(said).toEqual([["Opened in your PDF viewer to print", undefined]]);
  });

  it("says why when this computer could not open it, and nothing else", async () => {
    (window as unknown as { api: unknown }).api = { printPdf: async () => ({ ok: false, error: "No application knows how to open this file" }) };
    const { say, said } = sayer();
    await expect(printPdf("Plan.pdf", PDF, say)).rejects.toThrow("No application knows how to open this file");
    expect(said).toEqual([]);
  });

  it("in a browser says the PDF is ready and opens it in a tab only on his press", async () => {
    web.on = true;
    vi.useFakeTimers();
    const made: Blob[] = [];
    URL.createObjectURL = ((blob: Blob) => (made.push(blob), "blob:print")) as typeof URL.createObjectURL;
    const revoked = vi.fn();
    URL.revokeObjectURL = revoked;
    const main = vi.fn();
    (window as unknown as { api: unknown }).api = { printPdf: main };
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const { say, said } = sayer();

    expect(await printPdf("Plan.pdf", PDF, say)).toBe("tab");
    expect(main).not.toHaveBeenCalled();
    expect(made).toHaveLength(1);
    expect(made[0]!.type).toBe("application/pdf");
    expect(made[0]!.size).toBe(PDF.length);
    // Nothing opens by itself (a browser would block it, unseen), and nothing is put in the page.
    expect(opened).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBeNull();
    expect(said).toHaveLength(1);
    expect(said[0]![0]).toBe(PRINT_WORDS.tab);
    expect(said[0]![1]!.label).toBe("Open");

    said[0]![1]!.run();
    expect(opened).toHaveBeenCalledWith("blob:print", "_blank", "noopener");

    // The copy is let go once it has had its time.
    expect(revoked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TAB_MS);
    expect(revoked).toHaveBeenCalledWith("blob:print");
  });
});
