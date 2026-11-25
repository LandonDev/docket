import { describe, expect, it } from "vitest";
import { CELL_BOOLEAN, CELL_FORCE_STRING, CELL_NUMBER, CELL_STRING, plainWords, typedCell, typedWords } from "./cellInput";

/** The cell editor's document as the grid commits it: the words a key at a time, each run in the editor's own font. */
const typedDoc = (words: string) => {
  const ts = { cl: { rgb: "#151618" }, ff: "system-ui", fs: 9.75 };
  return { body: { dataStream: `${words}\r\n`, textRuns: [...words].map((_, i) => ({ st: i, ed: i + 1, ts })), paragraphs: [{ startIndex: words.length }] } };
};

describe("words typed into a sheet cell (decision 15)", () => {
  it("are a number when they are a plain decimal number with no leading zero", () => {
    for (const [words, n] of [["42", 42], ["-7", -7], ["3.5", 3.5], ["-0.25", -0.25], ["0.5", 0.5], ["0", 0], ["-0", 0], ["123456789012345", 123456789012345]] as const)
      expect(typedWords(words)).toEqual({ kind: "number", value: n });
  });

  it("are text as they stand otherwise: no leading zero dropped, no date, no exponent, no currency", () => {
    for (const words of ["007", "00", "1e5", "+5", ".5", "5.", "1,000", "$5", "10%", "3/4/2025", "2025-03-04", "Mar 4", " 42", "42 ", "1234567890123456", "Rent", "TRUEish"])
      expect(typedWords(words)).toEqual({ kind: "text", value: words });
  });

  it("are a formula from an equals sign, true or false from TRUE or FALSE, and text after an apostrophe", () => {
    expect(typedWords("=A1*2")).toEqual({ kind: "formula", formula: "=A1*2" });
    expect(typedWords("=")).toEqual({ kind: "text", value: "=" });
    expect(typedWords("TRUE")).toEqual({ kind: "bool", value: true });
    expect(typedWords("false")).toEqual({ kind: "bool", value: false });
    expect(typedWords("'007")).toEqual({ kind: "text", value: "007" });
    expect(typedWords("'=A1")).toEqual({ kind: "text", value: "=A1" });
  });
});

describe("a cell as the grid commits his typing", () => {
  it("reads the editor's document in one style as plain words, and styled text as none", () => {
    expect(plainWords(typedDoc("10"))).toBe("10");
    expect(plainWords({ body: { dataStream: "42\r\n", textRuns: [] } })).toBe("42");
    // a part in bold, two styles, a link, two paragraphs
    expect(plainWords({ body: { dataStream: "Net total\r\n", textRuns: [{ st: 4, ed: 9, ts: { bl: 1 } }] } })).toBeNull();
    expect(plainWords({ body: { dataStream: "10\r\n", textRuns: [{ st: 0, ed: 1, ts: { bl: 1 } }, { st: 1, ed: 2, ts: { it: 1 } }] } })).toBeNull();
    expect(plainWords({ body: { dataStream: "10\r\n", textRuns: [], customRanges: [{ startIndex: 0, endIndex: 1, rangeType: 0 }] } })).toBeNull();
    expect(plainWords({ body: { dataStream: "1\r2\r\n", textRuns: [] } })).toBeNull();
    expect(plainWords({ body: {} })).toBeNull();
  });

  it("holds a number, true or false and a formula as themselves, and text as text", () => {
    expect(typedCell({ v: null, f: null, si: null, p: typedDoc("42") })).toEqual({ v: 42, f: null, si: null, t: CELL_NUMBER, p: null });
    expect(typedCell({ v: null, p: typedDoc("-3.5"), s: { bl: 1 } })).toEqual({ v: -3.5, t: CELL_NUMBER, p: null, s: { bl: 1 } });
    expect(typedCell({ v: "42" })).toEqual({ v: 42, t: CELL_NUMBER });
    expect(typedCell({ v: "TRUE" })).toEqual({ v: 1, t: CELL_BOOLEAN });
    expect(typedCell({ v: null, p: typedDoc("=A1*2") })).toEqual({ v: null, f: "=A1*2", p: null });
    // Univer types "007" a number by its look: it stays words
    expect(typedCell({ v: "007", t: CELL_NUMBER })).toEqual({ v: "007", t: CELL_STRING });
    expect(typedCell({ v: "3/4/2025" })).toEqual({ v: "3/4/2025", t: CELL_STRING });
    expect(typedCell({ v: "'42" })).toEqual({ v: "42", t: CELL_FORCE_STRING });
  });

  it("leaves what is not his plain typing as it came", () => {
    const styled = { v: null, p: { body: { dataStream: "Net total\r\n", textRuns: [{ st: 4, ed: 9, ts: { bl: 1 } }] } } };
    const plainText = { v: null, p: typedDoc("007") };
    for (const cell of [styled, plainText, { v: "42", t: CELL_STRING }, { v: "42", t: CELL_FORCE_STRING }, { f: "=A1", v: 3 }, { si: "x" }, { v: 42 }, { v: "" }, { s: { bl: 1 } }])
      expect(typedCell(cell)).toBe(cell);
  });
});
