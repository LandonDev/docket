import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MailFile } from "work-kit/mail";

/** A mail's file pressed in the reader: shown in the canvas kind that takes it, beside the mail, or saved. */

const opened = vi.hoisted(() => [] as Array<{ env: string; pane: string; what: unknown }>);
vi.mock("../canvas/store", () => ({
  openItem: async (env: string, pane: string, what: unknown) => (opened.push({ env, pane, what }), { id: "i1" }),
}));

const { placeFiles, viewKind } = await import("./files");

const file = (name: string, over: Partial<MailFile> = {}): MailFile => ({ url: "https://lifeos.test/api/storage/x", name, messageId: "mm1", partId: "2", ...over });
const saves: MailFile[] = [];
const save = async (f: MailFile): Promise<"saved"> => (saves.push(f), "saved");

beforeEach(() => {
  opened.length = 0;
  saves.length = 0;
});

describe("which files open beside the mail", () => {
  it("goes by the canvas registry's one lookup, among the kinds that read a fetched file", () => {
    expect(viewKind(file("Q3 report.pdf"), "mt1")).toBe("pdf");
    expect(viewKind(file("Budget.XLSX", { contentType: "application/octet-stream" }), "mt1")).toBe("sheet");
    expect(viewKind(file("export.csv", { contentType: "application/vnd.ms-excel" }), "mt1")).toBe("sheet");
    expect(viewKind(file("IMG_0042.jpg"), "mt1")).toBe("media");
    expect(viewKind(file("clip.mov"), "mt1")).toBe("media");
    expect(viewKind(file("Sponsor deck.pptx"), "mt1")).toBe("slides");
    // Kinds that do not read a mail's file yet, and files no kind shows, are saved.
    expect(viewKind(file("notes.docx"), "mt1")).toBeNull();
    expect(viewKind(file("call.m4a"), "mt1")).toBeNull();
    expect(viewKind(file("archive.zip", { contentType: "application/zip" }), "mt1")).toBeNull();
    // A file with no message or part, or a reader with no mail open, cannot be named to the host.
    expect(viewKind(file("Q3 report.pdf", { partId: undefined }), "mt1")).toBeNull();
    expect(viewKind(file("Q3 report.pdf"), null)).toBeNull();
  });
});

describe("the reader's file members for a place", () => {
  it("opens a PDF as an item of the pane, from the mail thread open now, and says it opened", async () => {
    let thread: string | null = "mt1";
    const kit = placeFiles({ env: "box", pane: "mailpane_w1", thread: () => thread }, save);
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
    thread = null;
    await expect(kit.openFile(file("Q3 report.pdf"))).resolves.toBe("saved");
    await expect(kit.saveFile(file("Q3 report.pdf"))).resolves.toBe("saved");
    expect(saves).toHaveLength(2);
  });

  it("saves a file no canvas shows, and says it saved", async () => {
    const kit = placeFiles({ env: "box", pane: "t1", thread: () => "mt1" }, save);
    await expect(kit.openFile(file("archive.zip"))).resolves.toBe("saved");
    expect(opened).toEqual([]);
    expect(saves.map((f) => f.name)).toEqual(["archive.zip"]);
  });
});
