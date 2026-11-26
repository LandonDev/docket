// @vitest-environment jsdom
/** The `@` menu when the project's file read fails: it says so, keeps the names in hand, and reads again on the next open. */
import { act, cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "../lib/fs";

vi.mock("./ComposerBar", async (importOriginal) => ({ ...(await importOriginal<typeof import("./ComposerBar")>()), useDraftRow: () => false }));
vi.mock("../lib/contextCache", () => ({ useContextReading: () => null }));
vi.mock("../lib/tcserver/slashCommands", () => ({ useSlashCommands: () => ({ commands: [], loaded: true, failed: false }) }));
const h = vi.hoisted(() => ({ load: vi.fn() }));
const files: ProjectFile[] = ["src/app.ts", "README.md"].map((relative) => ({ name: relative.split("/").pop()!, path: `/repo/${relative}`, relative }));
vi.mock("../lib/fileIndex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/fileIndex")>()),
  peekProjectFiles: () => files,
  loadProjectFiles: h.load,
}));

import { Composer } from "./Composer";
import { commandMenuChunk } from "../surfaces/chunks";

const noop = () => {};
const props: ComponentProps<typeof Composer> = {
  sessionId: "t-files",
  focused: false,
  harness: "claude",
  model: "claude:opus-5.5",
  runtimeMode: "supervised",
  executionCwd: "/repo",
  onFocus: noop,
  onCwdChange: noop,
  onModelChange: noop,
  onRuntimeModeChange: noop,
  onSubmit: noop,
};

/** Sets the field's whole text with the caret at its end, as typing would. */
async function typeAll(field: HTMLElement, text: string) {
  await act(async () => {
    field.textContent = text;
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
  });
}

beforeAll(async () => {
  Element.prototype.scrollIntoView = () => {};
  await commandMenuChunk.load();
});
afterEach(cleanup);

describe("the @ menu over a failed file read", () => {
  it("says Couldn't search files, keeps the names in hand, and reads again on the next open", async () => {
    h.load.mockRejectedValueOnce(new Error("files.list: no answer in 10 s"));
    const { container } = render(<Composer {...props} />);
    const field = container.querySelector<HTMLElement>("[data-composer-input]")!;
    field.focus();
    const menu = () => container.querySelector("[data-command-popover]");
    await typeAll(field, "@app");
    // The names in hand still match, with the failure said under them.
    expect(menu()?.textContent).toContain("app.ts");
    expect(container.querySelector("[data-command-note]")?.textContent).toBe("Couldn't search files");
    // Nothing matches: the failure, never "No matches".
    await typeAll(field, "@zzqx");
    expect(container.querySelector("[data-command-empty]")?.textContent).toBe("Couldn't search files");
    // Closed, then opened again: the read is asked again, and its answer clears the line.
    h.load.mockResolvedValueOnce(files);
    await typeAll(field, "");
    await typeAll(field, "@app");
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(menu()?.textContent).toContain("app.ts");
    expect(container.querySelector("[data-command-note]")).toBeNull();
  });
});
