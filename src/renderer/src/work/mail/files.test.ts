import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MailFile } from "work-kit/mail";

/** A mail's file pressed in the reader: shown in the canvas kind that takes it, beside the mail, or saved. */

const opened = vi.hoisted(() => [] as Array<{ env: string; pane: string; what: unknown }>);
vi.mock("../canvas/store", () => ({
  openItem: async (env: string, pane: string, what: unknown) => (opened.push({ env, pane, what }), { id: "i1" }),
}));

const { placeFiles, viewKind } = await import("./files");

const file = (name: string, over: Partial<MailFile> = {}): MailFile => ({ url: "https://lifeos.test/api/storage/x", name, threadId: "mt1", messageId: "mm1", partId: "2", ...over });
const saves: MailFile[] = [];
const save = async (f: MailFile): Promise<"saved"> => (saves.push(f), "saved");

beforeEach(() => {
  opened.length = 0;
  saves.length = 0;
});

describe("which files open beside the mail", () => {
  it("goes by the canvas registry's one lookup, among the kinds that read a fetched file", () => {
    expect(viewKind(file("Q3 report.pdf"))).toBe("pdf");
    expect(viewKind(file("Budget.XLSX", { contentType: "application/octet-stream" }))).toBe("sheet");
    expect(viewKind(file("export.csv", { contentType: "application/vnd.ms-excel" }))).toBe("sheet");
    expect(viewKind(file("IMG_0042.jpg"))).toBe("media");
    expect(viewKind(file("clip.mov"))).toBe("media");
    expect(viewKind(file("Sponsor deck.pptx"))).toBe("slides");
    // Documents read only, recordings as meetings.
    for (const name of ["notes.docx", "brief.odt", "terms.rtf", "README.md", "list.txt"]) expect(viewKind(file(name)), name).toBe("document");
    expect(viewKind(file("call.m4a"))).toBe("meeting");
    expect(viewKind(file("memo.mp3", { contentType: "audio/mpeg" }))).toBe("meeting");
    // What kindForFile gives no kind is saved: an archive, a spreadsheet of the old formats.
    expect(viewKind(file("archive.zip", { contentType: "application/zip" }))).toBeNull();
    expect(viewKind(file("old.xls", { contentType: "application/vnd.ms-excel" }))).toBeNull();
    expect(viewKind(file("plan.ods"))).toBeNull();
    // A file that does not name its mail thread, message and part cannot be found by the host.
    expect(viewKind(file("Q3 report.pdf", { partId: undefined }))).toBeNull();
    expect(viewKind(file("Q3 report.pdf", { threadId: undefined }))).toBeNull();
  });
});

describe("the reader's file members for a place", () => {
  it("opens a PDF as an item of the pane, from the mail thread the file names, and says it opened", async () => {
    const kit = placeFiles({ env: "box", pane: "mailpane_w1" }, save);
    expect(kit.viewsPictures).toBe(true);
    expect(kit.fileVerb!(file("Q3 report.pdf"))).toBe("view");
    expect(kit.fileVerb!(file("archive.zip"))).toBe("save");
    await expect(kit.openFile(file("Q3 report.pdf", { contentType: "application/pdf", size: 1200 }))).resolves.toBe("opened");
    expect(opened).toEqual([
      {
        env: "box",
        pane: "mailpane_w1",
        what: { kind: "pdf", title: "Q3 report.pdf", source: { at: "mail", threadId: "mt1", messageId: "mm1", partId: "2", name: "Q3 report.pdf", contentType: "application/pdf", size: 1200 } },
      },
    ]);
    expect(saves).toEqual([]);
    await expect(kit.openFile(file("Q3 report.pdf", { threadId: undefined }))).resolves.toBe("saved");
    await expect(kit.saveFile(file("Q3 report.pdf"))).resolves.toBe("saved");
    expect(saves).toHaveLength(2);
  });

  it("saves a file no canvas shows, and says it saved", async () => {
    const kit = placeFiles({ env: "box", pane: "t1" }, save);
    await expect(kit.openFile(file("archive.zip"))).resolves.toBe("saved");
    expect(opened).toEqual([]);
    expect(saves.map((f) => f.name)).toEqual(["archive.zip"]);
  });
});
