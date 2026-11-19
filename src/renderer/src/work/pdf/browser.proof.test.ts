// @vitest-environment node
/**
 * Milestone 33's done-when lines in a real browser with the real pdf.js:
 * "a 300-page PDF opens and searches" and "a citation link lands on its
 * clause". proof/run.ts builds the page, serves a 300-page file by range at
 * the host link's pace, and drives headless Chrome over CDP; this checks what
 * it measured. It takes Chrome and half a minute, so it runs only when asked
 * (`TEMP_CODE_PDF_PROOF=1`, as fence.proof.test.ts is asked for), never in a
 * commit's gate, and writes into a folder of its own.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chromePath, CITE_PAGE, FIND_PAGES, PAGES, type ProofResult } from "./proof/run";

const bun = [process.env.BUN_INSTALL && join(process.env.BUN_INSTALL, "bin/bun"), join(process.env.HOME ?? "", ".bun/bin/bun")].find((p): p is string => !!p && existsSync(p));
const chrome = chromePath();

const asked = process.env.TEMP_CODE_PDF_PROOF === "1";

describe.skipIf(!asked || !chrome || !bun)("the PDF canvas in headless Chrome with pdf.js", () => {
  let result: ProofResult;
  const out = mkdtempSync(join(tmpdir(), "m33-proof-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("runs", () => {
    const run = spawnSync(bun!, [join(import.meta.dirname, "proof/run.ts"), out], { encoding: "utf8", timeout: 240_000 });
    expect(run.status, run.stderr).toBe(0);
    result = JSON.parse(readFileSync(join(out, "result.json"), "utf8")) as ProofResult;
  }, 250_000);

  it("opens a 300-page file and paints page 1 from its first megabytes", () => {
    const open = result.open.packed;
    expect(result.pages).toBe(PAGES);
    expect(open.ink).toBeGreaterThan(1000);
    expect(open.pager).toBe(true);
    expect(open.bytesBeforePaint).toBeLessThan(open.fileBytes / 10);
    expect(open.mountedPages).toBeLessThan(10);
    expect(open.rail).toBe(true);
  });

  it("finds the phrase on exactly its pages and steps to the last", () => {
    expect(result.find.hitPages).toEqual(FIND_PAGES);
    expect(result.find.firstLanded).toBe(FIND_PAGES[0]);
    expect(result.find.pager287).toBe(true);
    expect(result.find.currentOn287).toBeGreaterThan(0);
    expect(result.find.hitOverWordsShare).toBeGreaterThan(0.7);
  });

  it("lands a clicked citation on its clause", () => {
    const cite = result.cite;
    expect(cite.scrolledTo).toBe(CITE_PAGE);
    expect(cite.pageInView).toBe(true);
    expect(cite.citeOnPage).toBe(true);
    expect(cite.citeCoversClause).toBeGreaterThan(0.85);
    expect(cite.clauseCoversCite).toBeGreaterThan(0.85);
    expect(cite.hashUntouched).toBe(true);
    expect(cite.shown).toEqual(["proof/proof-pdf"]);
  });
});
