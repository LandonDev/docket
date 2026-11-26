// @vitest-environment jsdom
/**
 * A file that could not go up says so once: its chip turns Failed in red, and the line under the chips gives
 * only the cause, never "Could not attach <name>" again.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./CwdPicker", () => ({ CwdPicker: () => null }));
vi.mock("./DraftHostPicker", () => ({ DraftHostPicker: () => null }));
vi.mock("./BranchPicker", () => ({ BranchPicker: () => null }));
vi.mock("./ThreadTypeChip", () => ({ ThreadTypeChip: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
// A paste whose file the host cannot take fails with the host's raw text.
vi.mock("../lib/attachments", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/attachments")>();
  return { ...real, attachmentsFromFiles: () => Promise.reject(new Error("EACCES: permission denied, open '/Users/me/.tc/attachments/a1/shot.png'")) };
});
vi.mock("../lib/attachmentUpload", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/attachmentUpload")>();
  return {
    ...real,
    needsUpload: () => true,
    uploadAttachments: () => Promise.reject(new real.AttachmentUploadError("f1", "Could not attach notes.txt: not connected", "Not connected")),
  };
});

import { Composer } from "./Composer";
import { saveComposerDraft } from "../lib/composerDrafts";

afterEach(cleanup);

describe("a failed upload", () => {
  it("is the chip's Failed, and the line under the chips says only why", async () => {
    saveComposerDraft("chat-up", {
      segments: [{ text: "read this" }],
      attachments: [{ id: "f1", name: "notes.txt", kind: "file", mimeType: "text/plain", size: 10, path: "/Users/me/notes.txt", environmentId: "mac" }],
    });
    const view = render(
      <Composer
        focused={false}
        harness="claude"
        model="claude-opus-5-5"
        runtimeMode={"supervised" as never}
        executionCwd="/jobs/app"
        cwd="/jobs/app"
        sessionId="chat-up"
        onFocus={() => {}}
        onCwdChange={() => {}}
        onModelChange={() => {}}
        onRuntimeModeChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const field = view.container.querySelector<HTMLElement>("[data-composer-input]")!;
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    const chip = view.container.querySelector<HTMLElement>('[data-attachment-path="/Users/me/notes.txt"]')!;
    expect(chip.dataset.state).toBe("error");
    expect(chip.textContent).toContain("Failed");
    // The chips sit on the box row's 6px inset, 6px-round, so 12 = 6 + 6 with the box's corner.
    const row = view.container.querySelector<HTMLElement>("[data-composer-attachments]")!;
    expect(row.className.split(" ")).toEqual(expect.arrayContaining(["px-1.5", "pt-1.5", "[&>[data-slot=attachment]]:rounded-md"]));
    const note = view.getByRole("alert");
    expect(note.textContent).toBe("Not connected");
    expect(note.textContent).not.toContain("notes.txt");
  });

  // S F4.2 (council 2): a pick or a paste that fails says why in words, never the failure's raw text.
  it("a paste that fails puts no raw failure in the red line: Couldn't attach the file", async () => {
    const view = render(
      <Composer
        focused={false}
        harness="claude"
        model="claude-opus-5-5"
        runtimeMode={"supervised" as never}
        executionCwd="/jobs/app"
        cwd="/jobs/app"
        sessionId="chat-paste"
        onFocus={() => {}}
        onCwdChange={() => {}}
        onModelChange={() => {}}
        onRuntimeModeChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const field = view.container.querySelector<HTMLElement>("[data-composer-input]")!;
    const file = new File(["png"], "shot.png", { type: "image/png" });
    await act(async () => {
      fireEvent.paste(field, { clipboardData: { files: [file], items: [], getData: () => "", types: ["Files"] } });
    });
    const note = await view.findByRole("alert");
    expect(note.textContent).toBe("Couldn't attach the file");
    expect(note.textContent).not.toMatch(/EACCES|\/Users/);
  });
});
