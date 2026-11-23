import { afterEach, describe, expect, it } from "vitest";
import type { FileEntry, FilePlace } from "@shared/work/files";
import { forgetPictures, mayPicture, mayReadText, pageWidth, readsAsText, thumbPx, wholeChars, type PictureFrom } from "./previews";

const place = (over: Partial<FilePlace> = {}): FilePlace => ({ id: "folder", kind: "folder", name: "Dummy Esports", shared: false, state: { state: "ok" }, root: { at: "file", host: "h", path: "/w" }, can: [], ...over }) as FilePlace;
const from = (over: Partial<FilePlace> = {}, wire: "files" | "office" = "files"): PictureFrom => ({ workspaceId: "ws", copy: { link: "box", place: place(over), wire } });
const file = (name: string, kind: FileEntry["kind"], over: Partial<FileEntry> = {}): FileEntry => ({ key: `k:${name}`, ref: { at: "file", host: "h", path: `/w/${name}` }, folder: null, name, kind, ...over });

afterEach(() => forgetPictures());

describe("which files a picture is asked for", () => {
  it("asks for a document, a sheet, a deck, a PDF, a picture, a video and a text file, never a sound, an archive or a file of no kind", () => {
    const kinds: FileEntry["kind"][] = ["document", "sheet", "deck", "pdf", "picture", "video", "text", "audio", "archive", "other"];
    expect(kinds.filter((kind) => mayPicture(file("a", kind), from()))).toEqual(["document", "sheet", "deck", "pdf", "picture", "video", "text"]);
  });

  it("never asks for a folder, a file kept in the cloud, a file in the Windows VM, or of a host on the old wire", () => {
    expect(mayPicture({ ref: null, kind: "folder" }, from())).toBe(false);
    expect(mayPicture(file("a.pdf", "pdf", { local: false }), from())).toBe(false);
    expect(mayPicture(file("a.pdf", "pdf", { state: { is: "cloud" } }), from())).toBe(false);
    expect(mayPicture(file("a.pdf", "pdf"), from({ vm: true }))).toBe(false);
    expect(mayPicture(file("a.pdf", "pdf"), from({}, "office"))).toBe(false);
    expect(mayPicture(file("a.pdf", "pdf"), null)).toBe(false);
  });
});

describe("the sizes asked", () => {
  it("asks a thumbnail at twice a tile's width, in the host's three sizes", () => {
    expect([thumbPx(64), thumbPx(96), thumbPx(144), thumbPx(208)]).toEqual([192, 192, 288, 416]);
  });

  it("asks a page a step up from what the pane needs, so a small resize asks nothing new, and never past the wire's bound", () => {
    expect([pageWidth(300, 1), pageWidth(300, 2), pageWidth(600, 2), pageWidth(900, 2), pageWidth(2000, 3)]).toEqual([640, 640, 1600, 2048, 2048]);
    expect(pageWidth(520, 1)).toBe(pageWidth(600, 1));
  });
});

describe("a text file's first lines", () => {
  it("reads as text what the file kind would edit as text: a text file, and a file of no known kind small enough", () => {
    expect(readsAsText(file("notes.txt", "text"))).toBe(true);
    expect(readsAsText(file("Makefile", "other"))).toBe(true);
    expect(readsAsText(file("dump", "other", { size: 3 * 1024 * 1024 }))).toBe(false);
    expect(readsAsText(file("Plan.pdf", "pdf"))).toBe(false);
    expect(readsAsText({ name: "Events", kind: "folder", ref: null })).toBe(false);
  });

  it("reads under the picture rules: never a file kept in the cloud, in the Windows VM, or of a host on the old wire", () => {
    expect(mayReadText(file("notes.txt", "text"), from())).toBe(true);
    expect(mayReadText(file("notes.txt", "text", { local: false }), from())).toBe(false);
    expect(mayReadText(file("notes.txt", "text", { state: { is: "cloud" } }), from())).toBe(false);
    expect(mayReadText(file("notes.txt", "text"), from({ vm: true }))).toBe(false);
    expect(mayReadText(file("notes.txt", "text"), from({}, "office"))).toBe(false);
    expect(mayReadText(file("notes.txt", "text"), null)).toBe(false);
  });

  it("ends a head that the read cut inside a character on the character before it", () => {
    const bytes = new TextEncoder().encode("café ✓ 😀");
    expect(new TextDecoder().decode(wholeChars(bytes))).toBe("café ✓ 😀");
    // Cut one, two and three bytes into the four-byte face: back to before it.
    for (const cut of [1, 2, 3]) expect(new TextDecoder("utf-8", { fatal: true }).decode(wholeChars(bytes.subarray(0, bytes.length - 4 + cut)))).toBe("café ✓ ");
    // Cut inside the three-byte tick.
    const tick = bytes.indexOf(0xe2);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(wholeChars(bytes.subarray(0, tick + 2)))).toBe("café ");
  });
});
