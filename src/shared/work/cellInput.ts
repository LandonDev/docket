/**
 * What a sheet cell typed as plain words holds (decision 15; docs/agents/work-sheets.md "Typed words"): one rule for
 * every writer, an .xlsx, a .tcsheet, a LifeOS sheet, a workbook in Excel and a Google spreadsheet.
 *
 * A plain decimal number ("42", "-3.5", "0.5", "0": no leading zero, no exponent, no sign but a minus, at most 15
 * significant digits, all Excel keeps) is that number; words that start with "=" are a formula; TRUE and FALSE are
 * true and false. Everything else is text as it stands: "007", "1e5", "3/4/2025", "$5", "10%". No date is guessed. A
 * leading apostrophe makes the rest text, as in Excel.
 */
export type TypedWords =
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "formula"; formula: string }
  | { kind: "text"; value: string };

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export function typedWords(words: string): TypedWords {
  if (words.startsWith("'")) return { kind: "text", value: words.slice(1) };
  if (words.length > 1 && words.startsWith("=")) return { kind: "formula", formula: words };
  if (/^(true|false)$/i.test(words)) return { kind: "bool", value: words.toUpperCase() === "TRUE" };
  // (a card's or an account's number past 15 digits would lose its tail as a number)
  if (DECIMAL.test(words) && words.replace(/[-.]/g, "").replace(/^0+/, "").length <= 15) return { kind: "number", value: Number(words) + 0 };
  return { kind: "text", value: words };
}

/** Univer's cell types (`CellValueType`): words held as text, a number, true or false, and text an apostrophe made. */
export const CELL_STRING = 1;
export const CELL_NUMBER = 2;
export const CELL_BOOLEAN = 3;
export const CELL_FORCE_STRING = 4;

/** A grid cell as a mutation carries it (Univer's `ICellData`, the keys read here). */
export interface TypedCellLike {
  v?: unknown;
  f?: unknown;
  si?: unknown;
  t?: unknown;
  p?: unknown;
  s?: unknown;
}

interface DocBody {
  dataStream?: unknown;
  textRuns?: { st?: number; ed?: number; ts?: unknown }[];
  paragraphs?: { bullet?: unknown }[];
  customRanges?: unknown[];
  customBlocks?: unknown[];
}

/**
 * A cell's document as the words he typed, or null when it is text he styled: more than one style, a link, a list,
 * a picture, more than one paragraph. The grid's cell editor hands back a document whose runs carry the editor's
 * own font and colour, split a key at a time ("1" and "0"); one style over every run is plain words.
 */
export function plainWords(p: unknown): string | null {
  const body = (p as { body?: DocBody } | null | undefined)?.body;
  if (!body || typeof body.dataStream !== "string") return null;
  const words = body.dataStream.replace(/\r\n$/, "");
  if (/[\r\n]/.test(words) || body.customRanges?.length || body.customBlocks?.length || (body.paragraphs ?? []).some((x) => x.bullet)) return null;
  const runs = (body.textRuns ?? []).filter((r) => (r.st ?? 0) < words.length);
  const styles = new Set(runs.map((r) => JSON.stringify(r.ts ?? {})));
  if (styles.size > 1) return null;
  // One style over part of the words leaves the rest in another (the cell's own).
  if (runs.length && styles.values().next().value !== "{}") {
    let at = 0;
    for (const r of [...runs].sort((a, b) => (a.st ?? 0) - (b.st ?? 0))) {
      if ((r.st ?? 0) > at) return null;
      at = Math.max(at, r.ed ?? 0);
    }
    if (at < words.length) return null;
  }
  return words;
}

const heldAsText = (t: unknown): boolean => t === CELL_STRING || t === CELL_FORCE_STRING;

/**
 * A cell as the grid commits his typing, its words typed by `typedWords`: a number or true or false as that value
 * (Univer's NUMBER or BOOLEAN, true as 1), a formula as one, text held as text (STRING, so no engine reads "007" as
 * 7). Left as it is: a formula or a fill's cell, a cell held as text (an apostrophe, a text format, an agent's
 * string), a value that is no string, and text he styled (its runs are his). `runs`: the store keeps a cell's runs (an
 * opened Excel file, a sheet of ours); where it keeps none (a workbook Excel or Google holds), plain words in the
 * editor's style are their words alone.
 */
export function typedCell<C extends TypedCellLike>(cell: C, { runs = true }: { runs?: boolean } = {}): C {
  if (!cell || typeof cell !== "object") return cell;
  if ((typeof cell.f === "string" && cell.f !== "") || (cell.si !== undefined && cell.si !== null) || heldAsText(cell.t)) return cell;
  const rich = cell.p !== undefined && cell.p !== null;
  const words = rich ? plainWords(cell.p) : typeof cell.v === "string" ? cell.v : null;
  if (words === null || words === "") return cell;
  const typed = typedWords(words);
  switch (typed.kind) {
    case "number":
      return { ...cell, v: typed.value, t: CELL_NUMBER, ...(rich ? { p: null } : {}) };
    case "bool":
      return { ...cell, v: typed.value ? 1 : 0, t: CELL_BOOLEAN, ...(rich ? { p: null } : {}) };
    case "formula":
      return { ...cell, f: typed.formula, v: null, ...(rich ? { p: null } : {}) };
    case "text":
      // The editor's runs stay where the store keeps runs; plain words are held as text, an apostrophe's without it.
      return rich && runs ? cell : { ...cell, v: typed.value, t: words.startsWith("'") ? CELL_FORCE_STRING : CELL_STRING, ...(rich ? { p: null } : {}) };
  }
}
