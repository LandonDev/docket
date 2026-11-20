import { describe, expect, it } from "vitest";
import { giveComposerFiles, takeComposerDraft, takeComposerFiles } from "./composerDrafts";
import type { Attachment } from "./session";

const zip: Attachment = { id: "z", name: "site.zip", kind: "file", size: 1 };

describe("files handed to a thread's composer", () => {
  it("go to the mounted composer at once, else wait in its draft for the next mount", () => {
    const took: Attachment[][] = [];
    const release = takeComposerFiles("s1", (files) => took.push(files));
    giveComposerFiles("s1", [zip]);
    expect(took).toEqual([[zip]]);
    expect(takeComposerDraft("s1")).toBeUndefined();
    release();
    giveComposerFiles("s1", [zip]);
    expect(took).toHaveLength(1);
    expect(takeComposerDraft("s1")).toEqual({ segments: [], attachments: [zip] });
  });
});
