import { describe, expect, it } from "vitest";
import { NotInReach } from "../formats/preview";
import { previewProblems } from "../formats/previewContract";
import { sheetPreviewSource } from "./preview";

/**
 * "Check in Excel" in the sheet's PreviewSource (preview.ts `office`), over a stand-in for the host: which format
 * offers it, what each state of Excel does at the press, and what is asked of `work.sheets.previewOffice` and
 * `work.sheets.preview`. The host's side is checkExcel.test.ts.
 */
type State = "ready" | "asleep" | "not open" | "none";
const PDF = new TextEncoder().encode("%PDF-1.7\n% a stand-in for Excel's pages\n%%EOF\n");
const REV = "e".repeat(32);

function host(start: State | "old host") {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const h = {
    calls,
    state: start,
    /** what a press answers in place of a picture: Excel went out of reach since the look */
    refuse: null as Exclude<State, "ready"> | null,
    request: async <T,>(_env: string, method: string, params: unknown): Promise<T> => {
      const p = params as Record<string, unknown>;
      calls.push({ method, params: p });
      if (method === "work.sheets.previewOffice") {
        if (h.state === "old host") throw new Error("Unknown method work.sheets.previewOffice");
        return { app: "excel", state: h.state } as T;
      }
      if (method === "work.sheets.preview") {
        if (p.by === "office") return (h.refuse ? { notInReach: h.refuse } : { kind: "paged", rev: REV, size: PDF.length, pages: 4, drawnBy: "excel", drops: ["2 charts made here stay behind"] }) as T;
        return { kind: "paged", rev: "a".repeat(32), size: PDF.length, pages: 1, drawnBy: "libreoffice", drops: [] } as T;
      }
      if (method === "work.sheets.previewRead") return { data: btoa(String.fromCharCode(...PDF.subarray(p.offset as number, (p.offset as number) + (p.length as number)))) } as T;
      throw new Error(`no ${method}`);
    },
  };
  return h;
}

const sourceOf = (h: ReturnType<typeof host>) => sheetPreviewSource({ env: "local", itemId: "item1", store: "package", name: "Budget.xlsx", request: h.request });
const signal = (): AbortSignal => new AbortController().signal;
const asked = (h: ReturnType<typeof host>, method: string) => h.calls.filter((c) => c.method === method).map((c) => c.params);

describe("Check in Excel", () => {
  it("keeps the Preview contract in every state of Excel: a picture when ready or asleep, NotInReach when shut or none", async () => {
    for (const state of ["ready", "asleep", "not open", "none"] as const) expect(await previewProblems(sourceOf(host(state)), { only: ["xlsx"] }), state).toEqual([]);
    expect(await previewProblems(sourceOf(host("old host")), { only: ["xlsx"] })).toEqual([]);
  });

  it("is offered on the Excel format alone, by the host's word", async () => {
    const h = host("asleep");
    const source = sourceOf(h);
    expect(await source.office!("xlsx")).toEqual({ app: "Excel", state: "asleep" });
    expect(asked(h, "work.sheets.previewOffice")).toEqual([{ itemId: "item1" }]);
    // Excel draws the file itself: no PDF, no Print, no OpenDocument, and the host is not asked for them.
    for (const format of ["pdf", "print", "ods", "xls", "csv"]) expect(await source.office!(format)).toEqual({ app: "Excel", state: "none" });
    expect(asked(h, "work.sheets.previewOffice")).toHaveLength(1);
  });

  it("is not offered by a host a release behind, which does not know the question", async () => {
    const h = host("old host");
    const source = sourceOf(h);
    expect(await source.office!("xlsx")).toEqual({ app: "Excel", state: "none" });
    await expect(source.draw("xlsx", { by: "office", signal: signal() })).rejects.toEqual(new NotInReach("Excel", "none"));
    expect(asked(h, "work.sheets.preview")).toEqual([]);
  });

  it("asks the host for Excel's own pages of the workbook, and reads them at their rev", async () => {
    const h = host("ready");
    const drawn = await sourceOf(h).draw("xlsx", { by: "office", signal: signal() });
    expect(asked(h, "work.sheets.preview")).toEqual([{ itemId: "item1", format: "xlsx", by: "office" }]);
    expect(drawn.drops).toEqual(["2 charts made here stay behind"]);
    if (drawn.picture.kind !== "paged") throw new Error("paged");
    expect(drawn.picture).toMatchObject({ pages: 4, drawnBy: "excel" });
    expect(await drawn.picture.pdf.read(0, PDF.length)).toEqual(PDF);
    expect(asked(h, "work.sheets.previewRead")).toEqual([{ itemId: "item1", rev: REV, offset: 0, length: PDF.length }]);
  });

  it("never asks Excel for another format's picture, and a plain draw carries no press", async () => {
    const h = host("ready");
    const source = sourceOf(h);
    await expect(source.draw("pdf", { by: "office", signal: signal() })).rejects.toEqual(new NotInReach("Excel", "none"));
    await source.draw("xlsx", { signal: signal() });
    expect(asked(h, "work.sheets.preview")).toEqual([{ itemId: "item1", format: "xlsx" }]);
  });

  it("looks again at the press: an Excel shut since the look is said, and nothing is asked of it", async () => {
    const h = host("ready");
    const source = sourceOf(h);
    expect((await source.office!("xlsx"))?.state).toBe("ready");
    h.state = "not open";
    const err = await source.draw("xlsx", { by: "office", signal: signal() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotInReach);
    expect(err).toMatchObject({ app: "Excel", why: "not open" });
    expect(asked(h, "work.sheets.preview")).toEqual([]);
  });

  it("says so when Excel went out of reach while the host was drawing", async () => {
    const h = host("ready");
    h.refuse = "asleep";
    await expect(sourceOf(h).draw("xlsx", { by: "office", signal: signal() })).rejects.toMatchObject({ app: "Excel", why: "asleep" });
  });

  it("gives up a draw he cancelled before Excel's pages are shown", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(sourceOf(host("ready")).draw("xlsx", { by: "office", signal: stop.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
