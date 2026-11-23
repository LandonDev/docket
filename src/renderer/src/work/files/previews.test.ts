import { afterEach, describe, expect, it } from "vitest";
import type { FileEntry, FilePlace } from "@shared/work/files";
import { forgetPictures, mayPicture, pageWidth, thumbPx, type PictureFrom } from "./previews";

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
