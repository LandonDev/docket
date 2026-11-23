/** The sheet kind's words and rules that the host and the canvas both say. No zod: the canvas imports values from here. */
/**
 * Why a change cannot be saved into an opened workbook, in the words he reads as it is stopped: the
 * canvas says them at the press and the host says the same if one reaches it. `google`: the workbook
 * lives in Google Sheets, so that is where the change is made.
 */
export function sheetStopWords(kind: 'moved' | 'rich' | 'fill' | 'other', google = false, why?: MoveRefusal): string {
  const there = google ? 'Google Sheets' : 'Excel'
  const file = google ? 'a Google sheet' : 'an Excel file'
  if (kind === 'moved') return `Move this in ${there}${why ? `: ${MOVE_WHY[why]}` : ''}`
  if (kind === 'rich') return `Text with more than one style in a cell is not saved in ${file} yet`
  if (kind === 'fill') return `That fill could not be saved in ${file}`
  return `That change is not saved in ${file} yet. Make it in ${there}`
}

/**
 * Why a move cannot be saved into an opened Excel file, said after "Move this in Excel": the host
 * finds these in the file before LibreOffice runs (sheets/moves.ts) and the canvas finds the ones
 * the grid can see at the press (`forPackage`), in the same words.
 */
export const MOVE_WHY = {
  table: 'it crosses a table',
  merge: 'it crosses a merged cell',
  array: 'part of an array formula',
  spill: 'part of a spilled formula',
  pivot: "a pivot table's cells or source",
  filter: "it crosses the sheet's filter",
  protected: 'the sheet is protected',
  lands: 'a formula or chart reads where it lands',
  rule: 'its conditional formats overlap',
} as const
export type MoveRefusal = keyof typeof MOVE_WHY

/** A sheet's rules by kind: its conditional formats, its validations, the workbook's names, its filter, its tables. */
export type SheetRuleKind = 'conditional' | 'validation' | 'names' | 'filter' | 'tables'

/** The grid's mutations that change a rule, and the list each changes. */
export const RULE_MUTATIONS: Readonly<Record<string, SheetRuleKind>> = {
  'sheet.mutation.add-conditional-rule': 'conditional',
  'sheet.mutation.set-conditional-rule': 'conditional',
  'sheet.mutation.move-conditional-rule': 'conditional',
  'sheet.mutation.delete-conditional-rule': 'conditional',
  'data-validation.mutation.addRule': 'validation',
  'data-validation.mutation.updateRule': 'validation',
  'data-validation.mutation.removeRule': 'validation',
  'formula.mutation.set-defined-name': 'names',
  'formula.mutation.remove-defined-name': 'names',
  'sheet.mutation.set-filter-range': 'filter',
  'sheet.mutation.set-filter-criteria': 'filter',
  'sheet.mutation.remove-filter': 'filter',
  'sheet.mutation.re-calc-filter': 'filter',
  'sheet.mutation.add-table': 'tables',
  'sheet.mutation.delete-table': 'tables',
  'sheet.mutation.set-sheet-table': 'tables',
  'sheet.mutation.set-table-filter': 'tables',
  'sheet.mutation.move-table': 'tables'
}

/** Sent beside a filter's change, with nothing of its own to keep. */
export const RULE_NOISE: ReadonlySet<string> = new Set(['sheet.mutation.mark-dirty-filter-change'])

/**
 * What an opened Excel file is sent in place of a rule's own mutation: the whole list the change
 * left (a sheet's conditional formats, validations or tables, the workbook's names, a sheet's filter
 * or null), since the file is written a list at a time. `subUnitId` is absent for the names.
 */
export const RULES_SET = 'tempcode.sheet.rules'
export interface RulesSetParams {
  kind: SheetRuleKind
  subUnitId?: string
  list: unknown
}

/**
 * The format row's controls a guest with an Edit link gets on the hosted page: every one whose
 * press the live route lets a guest send (`GUEST_OPS`, sheets/host/live.ts; rowMatrix.test.ts holds
 * each press against it). No Data menu: a rule, a name and the filter are the owner's.
 */
export const GUEST_ROW = ['undo', 'style', 'font', 'size', 'bold', 'italic', 'underline', 'colour', 'fill', 'align', 'vertical', 'wrap', 'merge', 'borders', 'number'] as const

/** One of the grid's mutations (the contract's `SheetMutationJson`; named here so this file imports nothing). */
export interface SheetMutation {
  id: string
  params: unknown
}

const SET_RANGE_VALUES = 'sheet.mutation.set-range-values'
/** A row told to fit what it holds: an Excel file that keeps formatting takes it (its height leaves the file); every other store works the fit out again itself. */
export const AUTO_FIT = 'sheet.mutation.set-worksheet-row-is-auto-height'

/**
 * What an opened Excel file saves (docs/agents/work-sheets.md "Structural edits"): rows and columns
 * inserted or deleted, a sort, sheets added, removed or renamed (through LibreOffice on the host), and
 * cell contents (through the patch writer).
 */
const STRUCTURAL_SAVED = new Set([
  "sheet.mutation.insert-row",
  "sheet.mutation.remove-rows",
  "sheet.mutation.insert-col",
  "sheet.mutation.remove-col",
  "sheet.mutation.reorder-range",
  "sheet.mutation.insert-sheet",
  "sheet.mutation.remove-sheet",
  "sheet.mutation.set-worksheet-name",
]);

/** The grid's moves (a block dragged, or cut and pasted; whole rows or columns dragged): saved through LibreOffice where the host says it can (`moves`). */
export const SHEET_MOVES: ReadonlySet<string> = new Set(["sheet.mutation.move-range", "sheet.mutation.move-rows", "sheet.mutation.move-columns"]);

type Cells = Record<string, Record<string, Record<string, unknown> | null>>;

/** What an opened Excel file keeps of the grid's formatting: a column's width, a row's height he set, a merge made or parted. A cell's style rides in its set-range-values. */
const FORMAT_SAVED = new Set([
  "sheet.mutation.set-worksheet-col-width",
  "sheet.mutation.set-worksheet-row-height",
  // a row told to fit what it holds (a double-click on its border): its own height leaves the file
  "sheet.mutation.set-worksheet-row-is-auto-height",
  "sheet.mutation.add-worksheet-merge",
  "sheet.mutation.remove-worksheet-merge",
]);


/** The kinds of rule a sheet's row lists (the host's word on what its store keeps). */
export function ruleKinds(row: readonly string[] | undefined): Set<SheetRuleKind> {
  const out = new Set<SheetRuleKind>();
  for (const kind of ["conditional", "validation", "names", "filter"] as const) if (row?.includes(kind)) out.add(kind);
  // (the row's control makes one table; the list is the sheet's tables)
  if (row?.includes("table")) out.add("tables");
  return out;
}

/** One turn's mutations with each rule list sent once: the last of a kind on a sheet is the list as it stands. */
export function latestRules(mutations: SheetMutation[]): SheetMutation[] {
  const last = new Map<string, number>();
  const key = (m: SheetMutation): string | null => {
    if (m.id !== RULES_SET) return null;
    const p = m.params as RulesSetParams;
    return `${p.kind}\u0000${p.subUnitId ?? ""}`;
  };
  mutations.forEach((m, i) => {
    const k = key(m);
    if (k !== null) last.set(k, i);
  });
  return last.size === 0 ? mutations : mutations.filter((m, i) => {
    const k = key(m);
    return k === null || last.get(k) === i;
  });
}

/**
 * A mutation as an opened Excel file takes it, or why it cannot. Cell contents are saved as they
 * are; so are rows and columns inserted or deleted, a sort and a sheet added, removed or renamed. A
 * fill's cells carry only a shared formula's id: each gets its own formula text from the grid, which
 * the file needs. Where the host keeps formatting (`formats`: it listed controls for the row), a
 * cell's style, a column's width, a row's height and a merge are saved too; where it does not (a
 * workbook Excel or Google holds), a pasted cell's style is left out. What cannot be kept (moved
 * cells, rich text, a hidden row and the like) answers `stop`: the caller takes the change back as
 * he makes it and says why, so nothing he made stays in the grid that the file does not have.
 * A rule's change (a conditional format, a validation, a name, the filter) goes as the whole list
 * it left (`RULES_SET`), where the host listed that kind for the row (`kinds`).
 */
export function forPackage(
  mutation: SheetMutation,
  formula: (sheet: string, row: number, col: number) => string | null,
  opts: { formats?: boolean; google?: boolean; style?: (id: string) => Record<string, unknown> | null; rules?: (kind: SheetRuleKind, sheet?: string) => unknown; kinds?: ReadonlySet<SheetRuleKind>; moves?: boolean } = {},
): { keep: SheetMutation[] } | { stop: string } {
  if (STRUCTURAL_SAVED.has(mutation.id)) return { keep: [mutation] };
  if (SHEET_MOVES.has(mutation.id)) {
    // What a move may not cut through (a table, a merge, an array) the host finds in the file and says in the same words.
    return opts.moves ? { keep: [mutation] } : { stop: sheetStopWords("moved", opts.google) };
  }
  if (RULE_NOISE.has(mutation.id)) return { keep: [] };
  const kind = RULE_MUTATIONS[mutation.id];
  if (kind) {
    // A rule is saved as the whole list its change left: the file is written a list at a time.
    if (!opts.rules || !opts.kinds?.has(kind)) return { stop: sheetStopWords("other", opts.google) };
    const sheet = kind === "names" ? undefined : (mutation.params as { subUnitId?: string } | null)?.subUnitId;
    if (kind !== "names" && !sheet) return { stop: sheetStopWords("other", opts.google) };
    const params: RulesSetParams = { kind, ...(sheet ? { subUnitId: sheet } : {}), list: opts.rules(kind, sheet) ?? null };
    return { keep: [{ id: RULES_SET, params }] };
  }
  if (mutation.id === AUTO_FIT && !opts.formats) return { keep: [] };
  if (FORMAT_SAVED.has(mutation.id)) return opts.formats ? { keep: [mutation] } : { stop: sheetStopWords("other", opts.google) };
  if (mutation.id !== SET_RANGE_VALUES) return { stop: sheetStopWords("other", opts.google) };
  const params = mutation.params as { subUnitId?: string; cellValue?: Cells } | null;
  if (!params?.cellValue) return { keep: [mutation] };
  const cellValue: Cells = {};
  let kept = 0;
  for (const [r, row] of Object.entries(params.cellValue))
    for (const [c, cell] of Object.entries(row)) {
      let out = cell;
      if (cell !== null) {
        let next: Record<string, unknown> = cell;
        if (cell.p != null) return { stop: sheetStopWords("rich", opts.google) };
        if (cell.si != null && cell.f == null) {
          const f = formula(params.subUnitId ?? "", Number(r), Number(c));
          if (!f) return { stop: sheetStopWords("fill", opts.google) };
          next = { ...cell, f };
        }
        if ("s" in next && !opts.formats) {
          const { s: _style, ...rest } = next;
          // A cell that carried only a style has nothing for a store that keeps none.
          if (!("v" in rest) && !("f" in rest)) continue;
          next = rest;
        } else if (typeof next.s === "string") {
          // The file's style ids are not the grid's: the style itself is sent.
          const style = opts.style?.(next.s) ?? null;
          if (!style) return { stop: sheetStopWords("other", opts.google) };
          // (laid over what the cell has, as the grid lays a style it names by id)
          next = { ...next, s: style };
        }
        // A cell with neither contents nor a style (a type alone, custom data) has no saved form.
        if (!("v" in next) && !("f" in next) && !("s" in next)) return { stop: sheetStopWords("other", opts.google) };
        out = next;
      }
      (cellValue[r] ??= {})[c] = out;
      kept++;
    }
  if (!kept) return { keep: [] };
  return { keep: [{ id: mutation.id, params: { ...params, cellValue } }] };
}

