import { describe, expect, it } from "vitest";
import { MARGIN_PRESETS, marginPresetOf, NotInReach, PAPER_POINTS, PAPERS, type Drawn, type PreviewBytes, type PreviewSource } from "./preview";
import { previewProblems } from "./previewContract";

/**
 * The Preview contract's own test (preview.ts): a source that keeps the
 * rules passes, and each broken rule is named. The sheets and slides builds
 * run `previewProblems` on their real sources the same way.
 */

const pdf = (text = "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", rev = "r1"): PreviewBytes => {
  const all = new TextEncoder().encode(text);
  return { rev, size: all.length, read: async (offset, length) => all.slice(offset, offset + length) };
};

function fake(over: Partial<PreviewSource> = {}, draw?: (format: string, by?: "office") => Drawn): PreviewSource {
  return {
    formats: [
      { id: "docx", label: "Word", ext: "docx", paged: true, verb: "Export" },
      { id: "md", label: "Markdown", ext: "md", paged: false, verb: "Export" },
      { id: "print", label: "Print", paged: true, verb: "Print…" },
    ],
    async draw(format, opts) {
      if (opts.signal.aborted) throw new DOMException("cancelled", "AbortError");
      if (draw) return draw(format, opts.by);
      if (format === "md") return { picture: { kind: "text", text: "# Plan" }, drops: ["Fonts and colours stay behind"] };
      return { picture: { kind: "paged", pdf: pdf(), pages: 3, drawnBy: format === "print" ? "tempcode" : "libreoffice" }, drops: [] };
    },
    export: async (format) => ({ name: format === "print" ? "Plan" : `Plan.${format}` }),
    ...over,
  };
}

describe("the Preview contract", () => {
  it("a source that keeps every rule has no problems, with its exports too", async () => {
    expect(await previewProblems(fake())).toEqual([]);
    expect(await previewProblems(fake(), { exports: true })).toEqual([]);
  });

  it("names a format list that is empty, repeated or badly spelled", async () => {
    expect(await previewProblems(fake({ formats: [] }))).toEqual(["no formats"]);
    const twice = await previewProblems(fake({ formats: [{ id: "docx", label: "Word", ext: ".DOCX", paged: true, verb: "Export" }, { id: "docx", label: " ", ext: "docx", paged: true, verb: "Export" }] }));
    expect(twice).toEqual(expect.arrayContaining(['docx: the extension ".DOCX" is not a bare lower-case one', "docx: listed twice", "docx: no label"]));
  });

  it("holds a paged format to a real PDF it can read twice at one rev", async () => {
    expect(await previewProblems(fake({}, () => ({ picture: { kind: "text", text: "x" }, drops: [] })), { only: ["docx"] })).toEqual(["docx: the format says paged and drew text"]);
    expect(await previewProblems(fake({}, () => ({ picture: { kind: "paged", pdf: pdf("PK\u0003\u0004 not a pdf at all"), pages: 1, drawnBy: "libreoffice" }, drops: [] })), { only: ["docx"] })).toEqual(["docx: the bytes are not the file they claim to be"]);
    expect(await previewProblems(fake({}, () => ({ picture: { kind: "paged", pdf: pdf(undefined, ""), pages: 0, drawnBy: "libreoffice" }, drops: [] })), { only: ["docx"] })).toEqual(["docx: 0 pages", "docx: the render has no rev"]);
    let reads = 0;
    const shifting: PreviewBytes = { rev: "r1", size: 8, read: async () => new TextEncoder().encode(reads++ ? "%PDF-9.9" : "%PDF-1.7") };
    expect(await previewProblems(fake({}, () => ({ picture: { kind: "paged", pdf: shifting, pages: 1, drawnBy: "libreoffice" }, drops: [] })), { only: ["docx"] })).toContain("docx: two reads at one rev differ");
    expect(await previewProblems(fake({}, () => ({ picture: { kind: "paged", pdf: pdf(), pages: 2, drawnBy: "libreoffice", shown: { from: 1, to: 50, of: 20 } }, drops: [] })), { only: ["docx"] })).toEqual(["docx: the pages shown are not a range of the whole"]);
    // `pages` is what the PDF in hand holds; `shown` says which pages of the whole those are.
    const part = (pages: number) => fake({}, () => ({ picture: { kind: "paged", pdf: pdf(), pages, drawnBy: "libreoffice", shown: { from: 51, to: 100, of: 2084 } }, drops: [] }));
    expect(await previewProblems(part(50), { only: ["docx"] })).toEqual([]);
    expect(await previewProblems(part(2084), { only: ["docx"] })).toEqual(["docx: pages 51 to 100 are shown and the PDF holds 2084"]);
  });

  it("holds a loss to one plain line that says what happens, and a cancelled draw to no picture", async () => {
    const problems = await previewProblems(fake({}, () => ({ picture: { kind: "text", text: "x" }, drops: ["Comments are not supported", "two\nlines", " "] })), { only: ["md"] });
    expect(problems).toEqual(['md: a loss says what happens to the thing, never "not supported"', 'md: a loss is one plain line, got "two\\nlines"', 'md: a loss is one plain line, got " "']);
    const deaf = fake({ draw: async () => ({ picture: { kind: "text", text: "x" }, drops: [] }) });
    expect(await previewProblems(deaf, { only: ["md"] })).toEqual(["md: a cancelled draw answered a picture"]);
    // A draw that throws where it stands, not as a rejection, is still a refusal the check reads.
    let calls = 0;
    const blunt = fake({
      draw: (_format, opts) => {
        if (opts.signal.aborted) throw new Error("cancelled");
        calls++;
        return Promise.resolve({ picture: { kind: "text" as const, text: "x" }, drops: [] });
      },
    });
    expect(await previewProblems(blunt, { only: ["md"] })).toEqual([]);
    expect(calls).toBe(1);
  });

  it("says when a format cannot be drawn or its export is misnamed", async () => {
    const broken = fake({
      draw: async (_format, opts) => {
        if (opts.signal.aborted) throw new Error("cancelled");
        throw new Error("LibreOffice did not answer");
      },
      export: async () => ({ name: "Plan.pdf" }),
    });
    expect(await previewProblems(broken, { only: ["docx"], exports: true })).toEqual(["docx: could not be drawn: LibreOffice did not answer", "docx: the export is named Plan.pdf, not .docx"]);
  });

  it("holds Check in Word to Word's own picture, or NotInReach naming Word", async () => {
    const only = { only: ["docx"] };
    const office = (state: "ready" | "asleep" | "not open" | "none") => async () => ({ app: "Word" as const, state });
    const word = fake({ office: office("ready") }, (_f, by) => ({ picture: { kind: "paged", pdf: pdf(), pages: 3, drawnBy: by ? "word" : "libreoffice" }, drops: [] }));
    expect(await previewProblems(word, only)).toEqual([]);
    const lying = fake({ office: office("ready") }, () => ({ picture: { kind: "paged", pdf: pdf(), pages: 3, drawnBy: "libreoffice" }, drops: [] }));
    expect(await previewProblems(lying, only)).toEqual(["docx: Office's picture must say Word drew it"]);
    const asleep = (state: "ready" | "asleep", app: "Word" | "Excel" = "Word") =>
      fake({ office: office(state) }, (_f, by) => {
        if (by) throw new NotInReach(app, "asleep");
        return { picture: { kind: "paged", pdf: pdf(), pages: 3, drawnBy: "libreoffice" }, drops: [] };
      });
    // The press on an asleep machine is what wakes it: answering "asleep" to the press itself is a broken source.
    expect(await previewProblems(asleep("asleep"), only)).toEqual(["docx: office() said asleep and the draw said asleep"]);
    expect(await previewProblems(asleep("ready"), only)).toEqual(["docx: office() said ready and the draw said asleep"]);
    const woken = fake({ office: office("asleep") }, (_f, by) => ({ picture: { kind: "paged", pdf: pdf(), pages: 3, drawnBy: by ? "word" : "libreoffice" }, drops: [] }));
    expect(await previewProblems(woken, only)).toEqual([]);
    // An app he has shut is never started unseen, and one that is not there draws nothing.
    for (const state of ["not open", "none"] as const) {
      const shut = fake({ office: office(state) }, (_f, by) => {
        if (by) throw new NotInReach("Word", state);
        return { picture: { kind: "paged", pdf: pdf(), pages: 3, drawnBy: "libreoffice" }, drops: [] };
      });
      expect(await previewProblems(shut, only)).toEqual([]);
      const started = fake({ office: office(state) }, (_f, by) => ({ picture: { kind: "paged", pdf: pdf(), pages: 3, drawnBy: by ? "word" : "libreoffice" }, drops: [] }));
      expect(await previewProblems(started, only)).toEqual([`docx: office() said ${state} and the draw answered a picture`]);
    }
    expect(await previewProblems(asleep("asleep", "Excel"), only)).toEqual(["docx: NotInReach names Excel, office() names Word"]);
    const odd = fake({ office: office("none") }, (_f, by) => {
      if (by) throw new Error("no carrier");
      return { picture: { kind: "paged", pdf: pdf(), pages: 3, drawnBy: "libreoffice" }, drops: [] };
    });
    expect(await previewProblems(odd, only)).toEqual(["docx: Office's draw failed with something other than NotInReach"]);
  });

  it("checks the page set-up every kind shares", async () => {
    const common = { paper: "Letter" as const, orientation: "portrait" as const, margins: { ...MARGIN_PRESETS.Normal }, header: true, footer: true };
    const good = fake({ setup: { kind: "document", common, columns: 1, differentFirst: false, set: async () => {} } });
    expect(await previewProblems(good)).toEqual([]);
    const bad = fake({ setup: { kind: "document", common: { ...common, paper: "Foolscap" as "Letter", margins: { ...common.margins, left: -1 } }, columns: 1, differentFirst: false, set: async () => {} } });
    expect(await previewProblems(bad)).toEqual(["set-up: Foolscap is no paper", "set-up: a margin under zero"]);
  });

  it("names Word's margins and sizes every paper in points", () => {
    expect(marginPresetOf({ top: 72, right: 72, bottom: 72, left: 72 })).toBe("Normal");
    expect(marginPresetOf({ top: 36, right: 36, bottom: 36, left: 36 })).toBe("Narrow");
    expect(marginPresetOf({ top: 72, right: 71, bottom: 72, left: 72 })).toBeNull();
    for (const paper of PAPERS) expect(PAPER_POINTS[paper].height).toBeGreaterThan(PAPER_POINTS[paper].width);
    expect(PAPER_POINTS.Letter).toEqual({ width: 612, height: 792 });
    expect(new NotInReach("Word", "asleep")).toMatchObject({ app: "Word", why: "asleep", name: "NotInReach" });
  });
});
