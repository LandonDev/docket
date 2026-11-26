// @vitest-environment jsdom
/**
 * Council 5 S F4.1: while a file goes up to the thread's host, Send is held (another press would do nothing);
 * the chip's progress is what shows the work underway.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./CwdPicker", () => ({ CwdPicker: () => null }));
vi.mock("./DraftHostPicker", () => ({ DraftHostPicker: () => null }));
vi.mock("./BranchPicker", () => ({ BranchPicker: () => null }));
vi.mock("./ThreadTypeChip", () => ({ ThreadTypeChip: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
const h = vi.hoisted(() => ({ release: (_: unknown) => {} }));
vi.mock("../lib/attachmentUpload", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/attachmentUpload")>();
  return {
    ...real,
    needsUpload: () => true,
    uploadAttachments: ({ files }: { files: unknown[] }) => new Promise((resolve) => (h.release = () => resolve(files))),
  };
});

import { Composer } from "./Composer";
import { saveComposerDraft } from "../lib/composerDrafts";

afterEach(cleanup);

describe("an upload under way", () => {
  it("holds Send until the files have gone up", async () => {
    saveComposerDraft("chat-uploading", {
      segments: [{ text: "read this" }],
      attachments: [{ id: "f1", name: "notes.txt", kind: "file", mimeType: "text/plain", size: 10, path: "/Users/me/notes.txt", environmentId: "mac" }],
    });
    const onSubmit = vi.fn();
    const view = render(
      <Composer
        focused={false}
        harness="claude"
        model="claude-opus-5-5"
        runtimeMode={"supervised" as never}
        executionCwd="/jobs/app"
        cwd="/jobs/app"
        sessionId="chat-uploading"
        onFocus={() => {}}
        onCwdChange={() => {}}
        onModelChange={() => {}}
        onRuntimeModeChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const send = () => view.getByRole("button", { name: /^Send/ }) as HTMLButtonElement;
    expect(send().disabled).toBe(false);
    const field = view.container.querySelector<HTMLElement>("[data-composer-input]")!;
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(send().disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      h.release(undefined);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
