import { describe, expect, it } from "vitest";
import { ACT_KINDS, ACT_PILLAR, CANVAS_KINDS, CANVAS_PILLAR, type ActKind, type CanvasSource } from "@shared/work";
import { ACT_VIEWS } from "../acts/registry";
import { agendaActs } from "../agenda/act";
import { browserActs } from "../browser/act";
import { formsActs } from "../forms/act";
import { frameioActs } from "../frameio/act";
import { messagesActs } from "../messages/act";
import { googleActs } from "../google/act";
import { guestsActs } from "../guests/act";
import { mailActs } from "../mail/act";
import { officeActs } from "../office/act";
import { outboxActs } from "../outbox/act";
import { kindOfFile } from "@shared/work/docFind";
import { extsOfCanvas, kindOfEntry } from "@shared/work/files";
import { CANVAS, kindFor, kindForFile } from "./registry";

/** The two registries Work's pillars plug into: every kind and every act kind once, each in its pillar's own file. */

describe("the canvas kinds", () => {
  it("lists every kind once, under its own name", () => {
    expect(Object.keys(CANVAS)).toEqual([...CANVAS_KINDS]);
    for (const kind of CANVAS_KINDS) expect(CANVAS[kind].kind).toBe(kind);
  });

  it("loads every kind's chunk, and each has a body", async () => {
    for (const kind of CANVAS_KINDS) {
      const module = await CANVAS[kind].chunk.load();
      expect(typeof module.Body, kind).toBe("function");
      for (const part of ["Bar", "TabEnd"] as const) expect(["function", "undefined"], `${kind}.${part}`).toContain(typeof module[part]);
    }
  });

  it("names each kind's chunk for the pillar that owns it", () => {
    for (const kind of CANVAS_KINDS) expect(CANVAS[kind].chunk.name).toBe(`work-${CANVAS_PILLAR[kind]}-canvas`);
  });

  it("shows every kind on the phone, and lets a guest into documents and sheets alone", () => {
    for (const kind of CANVAS_KINDS) expect(["web", "native"]).toContain(CANVAS[kind].phone);
    expect(CANVAS_KINDS.filter((kind) => CANVAS[kind].guestable)).toEqual(["document", "sheet"]);
  });

  it("gives each kind a label and a glyph", () => {
    for (const kind of CANVAS_KINDS) {
      expect(CANVAS[kind].label).toMatch(/^[A-Z]/);
      expect(CANVAS[kind].icon, kind).toBeTruthy();
    }
  });
});

describe("kindFor", () => {
  const file = (path: string): CanvasSource => ({ at: "file", host: "box", path });
  const office = (app: "excel" | "word" | "powerpoint"): CanvasSource => ({ at: "microsoft", host: "mac", app, name: "Budget", ref: { kind: "url", url: "https://example.sharepoint.com/x" } });

  it("goes by the source first: a LifeOS row by its table, a Microsoft file by its Office app, a browser session", () => {
    expect(kindFor({ at: "lifeos", table: "docs", id: "d" })).toBe("document");
    expect(kindFor({ at: "lifeos", table: "projectDocs", id: "d" })).toBe("document");
    expect(kindFor({ at: "lifeos", table: "sheets", id: "s" })).toBe("sheet");
    expect(kindFor({ at: "lifeos", table: "outbox", id: "m" })).toBe("mail");
    expect(kindFor(office("excel"))).toBe("sheet");
    expect(kindFor(office("word"))).toBe("document");
    expect(kindFor(office("powerpoint"))).toBe("slides");
    expect(kindFor({ at: "browser", host: "mac", sessionId: "b" })).toBe("browser");
    expect(kindFor({ at: "frameio", account: "a", fileId: "f" })).toBe("media");
  });

  it("the source beats what a hint says of the type", () => {
    expect(kindFor(office("word"), { mime: "application/pdf", name: "x.xlsx" })).toBe("document");
  });

  it("then goes by the mime type, a Google file's own included", () => {
    expect(kindFor({ at: "google", account: "a", fileId: "f", mime: "application/vnd.google-apps.spreadsheet" })).toBe("sheet");
    expect(kindFor({ at: "google", account: "a", fileId: "f", mime: "application/vnd.google-apps.document" })).toBe("document");
    expect(kindFor(file("/w/scan"), { mime: "application/pdf" })).toBe("pdf");
    expect(kindFor(file("/w/poster.bin"), { mime: "image/png" })).toBe("media");
    expect(kindFor(file("/w/sync.bin"), { mime: "audio/mpeg" })).toBe("meeting");
  });

  it("the mime type beats the extension", () => {
    expect(kindFor(file("/w/contract.docx"), { mime: "application/pdf" })).toBe("pdf");
  });

  it("then goes by the file's extension, whatever its case", () => {
    expect(kindFor(file("/w/Ballroom contract.PDF"))).toBe("pdf");
    expect(kindFor(file("/w/budget.xlsx"))).toBe("sheet");
    expect(kindFor(file("/w/notes.tcdoc"))).toBe("document");
    expect(kindFor(file("/w/deck.pptx"))).toBe("slides");
    expect(kindFor(file("C:\\Users\\me\\trailer.mp4"))).toBe("media");
    expect(kindFor({ at: "thread" }, { name: "Sponsor deck.pptx" })).toBe("slides");
  });

  it("claims nothing it does not know", () => {
    expect(kindFor(file("/w/archive.zip"))).toBeNull();
    expect(kindFor(file("/w/Makefile"))).toBeNull();
    expect(kindFor({ at: "thread" })).toBeNull();
    expect(kindFor({ at: "lifeos", table: "calendarOps", id: "c" })).toBeNull();
  });
});

describe("kindForFile", () => {
  it("goes by the name first, then the type the desktop gave", () => {
    expect(kindForFile("Q3 Budget.XLSX", "application/octet-stream")).toBe("sheet");
    expect(kindForFile("export.csv", "application/vnd.ms-excel")).toBe("sheet");
    expect(kindForFile("main.ts", "video/mp2t")).toBeNull();
    expect(kindForFile("scan", "application/pdf")).toBe("pdf");
    expect(kindForFile("IMG_0042", "image/heic")).toBe("media");
    expect(kindForFile("README.md")).toBe("document");
    expect(kindForFile("notes.txt", "text/plain")).toBe("document");
    expect(kindForFile("call.m4a")).toBe("meeting");
    expect(kindForFile("archive.zip", "application/zip")).toBeNull();
  });

  it("the Docs view's list, which the host builds, reads files as the registry does", () => {
    for (const kind of CANVAS_KINDS) {
      for (const ext of CANVAS[kind].opens.ext ?? []) expect([ext, kindOfFile(`f.${ext}`)]).toEqual([ext, kind]);
    }
  });

  it("holds every kind's extensions to the one table of file types, both ways", () => {
    // A kind that claims an extension the table gives another kind (or none), or a table row no kind claims, fails here.
    for (const kind of CANVAS_KINDS) expect([kind, [...(CANVAS[kind].opens.ext ?? [])].sort()]).toEqual([kind, extsOfCanvas(kind).sort()]);
  });

  it("holds every kind's mime types to the table too", () => {
    for (const kind of CANVAS_KINDS) {
      for (const mime of CANVAS[kind].opens.mime ?? []) expect([mime, kindOfEntry("", mime.replace("/*", "/x")).canvas]).toEqual([mime, kind]);
    }
  });

  it("opens only what this build's registry holds", () => {
    const { pdf: _pdf, ...rest } = CANVAS;
    expect(kindForFile("scan.pdf", undefined, rest as never)).toBeNull();
  });
});

describe("the act views", () => {
  it("lists every act kind once, under its own name", () => {
    expect(Object.keys(ACT_VIEWS).sort()).toEqual([...ACT_KINDS].sort());
    for (const kind of ACT_KINDS) expect(ACT_VIEWS[kind].kind).toBe(kind);
  });

  it("each pillar's file holds the kinds that are its own, and no other", () => {
    const files = { agenda: agendaActs, browser: browserActs, forms: formsActs, frameio: frameioActs, google: googleActs, guests: guestsActs, mail: mailActs, messages: messagesActs, office: officeActs, outbox: outboxActs };
    const owned = (pillar: string): ActKind[] => ACT_KINDS.filter((kind) => ACT_PILLAR[kind] === pillar);
    expect(Object.keys(files).sort()).toEqual([...new Set(Object.values(ACT_PILLAR))].sort());
    for (const [pillar, views] of Object.entries(files)) expect(Object.keys(views).sort(), pillar).toEqual(owned(pillar).sort());
  });

  it("falls back to the generic view until a pillar gives a kind its own", () => {
    // Milestone 25 gave calendar.op its own view, milestone 23 mail.send, milestone 31 share.guestLink and milestone 50 office.calendar.op; the rest draw the generic view.
    const own = new Set<string>(["calendar.op", "mail.send", "share.guestLink", "office.calendar.op"]);
    for (const kind of ACT_KINDS) {
      if (own.has(kind)) expect(ACT_VIEWS[kind].chunk, kind).not.toBeNull();
      else expect(ACT_VIEWS[kind].chunk, kind).toBeNull();
    }
  });
});

describe("a kind this build does not know", () => {
  it("answers a known kind's own definition", async () => {
    const { kindDefOf, knowsKind } = await import("./registry");
    for (const kind of CANVAS_KINDS) expect(kindDefOf(CANVAS, kind)).toBe(CANVAS[kind]);
    expect(knowsKind(CANVAS, "sheet")).toBe(true);
  });

  it("stands a plain file in for one a newer host made: one definition per kind, claiming nothing, with a body", async () => {
    const { kindDefOf, knowsKind } = await import("./registry");
    const stand = kindDefOf(CANVAS, "hologram" as never);
    expect(knowsKind(CANVAS, "hologram" as never)).toBe(false);
    // A name every object has is no kind either.
    expect(knowsKind(CANVAS, "toString" as never)).toBe(false);
    expect(stand.kind).toBe("hologram");
    expect(stand.label).toBe("File");
    expect(stand.opens).toEqual({});
    expect(stand.history).toBeUndefined();
    expect(kindDefOf(CANVAS, "hologram" as never)).toBe(stand);
    expect(kindDefOf(CANVAS, "other" as never)).not.toBe(stand);
    const module = await stand.chunk.load();
    expect(typeof module.Body).toBe("function");
    expect(module.Bar).toBeUndefined();
  });
});
