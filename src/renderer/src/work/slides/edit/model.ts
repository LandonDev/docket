import type { DeckParagraph, DeckShape, SlideOp, DeckColour } from "@shared/contract-work-slides";

/**
 * His words in a shape as the typing box holds them (docs/agents/work-slides.md
 * "Typing on a slide"). Pure: no DOM. A shape's paragraphs come from the
 * outline as runs, each with the look it is drawn in and the run of the file
 * it came from; what he types, splits and sets goes on top, and the box's
 * words go back to the host as one `runs` edit that names, for every run and
 * paragraph, the one it came from and only what he set on it.
 *
 * Places are `[paragraph, character]`, both from 0, counted as the host
 * counts them: a line break is one character, `\n`, inside a run's text.
 */

export type Align = DeckParagraph["align"];
export type ListKind = DeckParagraph["list"];

/** A run's look: what the outline says it is drawn in, or what he set. */
export interface RunLook {
  font?: string;
  /** points, as drawn */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** hex, no hash: the colour as it is drawn */
  color?: string;
  /**
   * Where `color` is one of the deck's theme colours: its slot and tint, sent in the hex's place so the words
   * stay the theme's colour when the theme changes. Null for a plain colour he picked over a theme one.
   */
  theme?: Exclude<DeckColour, string> | null;
}
export interface ParaLook {
  level?: number;
  align?: Align;
  list?: ListKind;
}

export interface EditRun {
  text: string;
  /** the outline's run it came from, `[paragraph, run]`; absent for words in a paragraph that had none */
  from?: [number, number];
  /** as it is drawn: the outline's look with `set` on top */
  look: RunLook;
  /** what he set on it */
  set: RunLook;
}

export interface EditPara {
  /** the outline's paragraph it came from (a paragraph made with Return keeps the one it was split from) */
  from?: number;
  level: number;
  align: Align;
  list: ListKind;
  /** what he set on it */
  set: ParaLook;
  runs: EditRun[];
  /** the look words typed into it take while it has no runs */
  look: RunLook;
  /** what he set while it had no words, for the words he types next */
  pending: RunLook;
  /** the run a paragraph made by Return continues: the words typed into it come from that run */
  carry?: { from?: [number, number]; set: RunLook };
}

export type Model = EditPara[];
export type Point = readonly [para: number, char: number];
/** A selection, `from` never after `to`. */
export interface Sel {
  from: Point;
  to: Point;
}

/** The text size for words with none in the outline, in points: PowerPoint's own body default. */
export const DEFAULT_SIZE = 18;

const LOOK_KEYS = ["font", "size", "bold", "italic", "underline", "color", "theme"] as const;
const PARA_KEYS = ["level", "align", "list"] as const;

/** A shape with words a hand can type into: a text shape whose paragraphs the outline lists. */
export const typable = (shape: DeckShape): boolean => (shape.kind === "text" || shape.kind === "other") && Array.isArray(shape.paragraphs);

/** One cell of a table, row and column from 0. */
export interface Cell {
  row: number;
  col: number;
}

/** A shape his words go into: a text shape, or a table, one cell at a time (`cellShape`). */
export const typesIn = (shape: DeckShape): boolean => typable(shape) || (shape.kind === "table" && !!shape.cells?.length && !!shape.quad);

/** PowerPoint's own margins inside a cell, in EMU: a tenth of an inch at the sides, a twentieth above and below. */
const CELL_FRAME = { anchor: "top", insets: [91_440, 45_720, 91_440, 45_720], fit: "none", wrap: true } as const;

/** Where each column and row of a table starts and ends, as shares of its box: the file's widths and heights, else even. */
function cellLines(table: DeckShape): [cols: number[], rows: number[]] {
  const rows = table.cells?.length ?? 0;
  const cols = table.cells?.[0]?.length ?? 0;
  const lines = (sizes: number[] | undefined, n: number): number[] => {
    const own = sizes?.length === n && sizes.every((v) => v > 0) ? sizes : Array.from({ length: n }, () => 1);
    const sum = own.reduce((a, b) => a + b, 0);
    let at = 0;
    return [0, ...own.map((v) => (at += v) / sum)];
  };
  return [lines(table.grid?.[0], cols), lines(table.grid?.[1], rows)];
}

/** The cell of a table under a point on the slide (shares of its width and height): the nearest one to a point outside. */
export function cellAt(table: DeckShape, x: number, y: number): Cell {
  const quad = table.quad;
  if (!quad) return { row: 0, col: 0 };
  const [cols, rows] = cellLines(table);
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const [left, top] = [Math.min(...xs), Math.min(...ys)];
  const u = (x - left) / (Math.max(...xs) - left || 1);
  const v = (y - top) / (Math.max(...ys) - top || 1);
  const find = (lines: number[], at: number): number => {
    for (let i = 1; i < lines.length - 1; i++) if (at < lines[i]) return i - 1;
    return Math.max(0, lines.length - 2);
  };
  return { row: find(rows, v), col: find(cols, u) };
}

/**
 * One cell of a table as a text shape of its own, for the typing box: on the cell's corners (its share of the table's
 * box, turned with it), its words a paragraph a line of the cell, in no look of their own, so the box draws them in the
 * table's ink and the file keeps the table style's. Null for a cell the table does not have.
 */
export function cellShape(table: DeckShape, { row, col }: Cell): DeckShape | null {
  const words = table.cells?.[row]?.[col];
  const quad = table.quad;
  if (words === undefined || !quad) return null;
  const [cols, rows] = cellLines(table);
  const [tl, tr, , bl] = quad;
  const at = (u: number, v: number): [number, number] => [tl[0] + (tr[0] - tl[0]) * u + (bl[0] - tl[0]) * v, tl[1] + (tr[1] - tl[1]) * u + (bl[1] - tl[1]) * v];
  const [u0, u1, v0, v1] = [cols[col], cols[col + 1], rows[row], rows[row + 1]];
  return {
    ...table,
    kind: "text",
    label: `Row ${row + 1}, column ${col + 1}`,
    quad: [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)],
    text: words,
    // A line break inside a paragraph is the outline's vertical tab and the box's \n.
    paragraphs: words.split("\n").map((line) => ({ level: 0, align: "left", list: "none", runs: line ? [{ text: line.replace(/\v/g, "\n") }] : [] })),
    frame: CELL_FRAME,
  };
}

const pick = (run: RunLook): RunLook => {
  const out: RunLook = {};
  for (const key of LOOK_KEYS) if (run[key] !== undefined) (out as Record<string, unknown>)[key] = run[key];
  return out;
};

/**
 * The model of a shape's words. `fallback` is the look of words in a shape
 * with none at all (an empty placeholder): the deck's body font and ink.
 */
export function modelOf(shape: DeckShape, fallback: RunLook): Model {
  const paras = shape.paragraphs ?? [];
  // A paragraph with no runs takes the look of the nearest one that has some (an empty one says its own, `end`), else the fallback.
  const firstLook = (p: number): RunLook => {
    for (let d = 0; d < paras.length; d++) {
      for (const at of [p - d, p + d]) {
        const run = paras[at]?.runs.find((r) => r.text !== "") ?? paras[at]?.end;
        if (run) return { ...fallback, ...pick(run) };
      }
    }
    return { ...fallback };
  };
  const model: Model = paras.map((para, p) => ({
    from: p,
    level: para.level,
    align: para.align,
    list: para.list,
    set: {},
    look: firstLook(p),
    pending: {},
    runs: para.runs.flatMap((run, r) => (run.text === "" ? [] : [{ text: run.text, from: [p, r] as [number, number], look: { ...fallback, ...pick(run) }, set: {} }])),
  }));
  return model.length > 0 ? model : [{ level: 0, align: "left", list: "none", set: {}, look: { ...fallback }, pending: {}, runs: [] }];
}

const sameLook = (a: RunLook, b: RunLook): boolean => LOOK_KEYS.every((k) => (k === "theme" ? JSON.stringify(a.theme ?? null) === JSON.stringify(b.theme ?? null) : a[k] === b[k]));

/** A look as an edit carries it: a theme colour by its slot and tint, a plain one by its hex. */
export function wireLook(look: RunLook): Omit<RunLook, "color" | "theme"> & { color?: DeckColour } {
  const { theme, color, ...rest } = pick(look);
  if (color === undefined) return rest;
  return { ...rest, color: theme ? { slot: theme.slot, ...(theme.tint ? { tint: theme.tint } : {}) } : color };
}
const sameFrom = (a?: [number, number], b?: [number, number]): boolean => a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);

/** Runs with no words go; two runs side by side from one run of the file with one look become one. */
export function normalize(model: Model): Model {
  return model.map((para) => {
    const runs: EditRun[] = [];
    for (const run of para.runs) {
      if (run.text === "") continue;
      const last = runs[runs.length - 1];
      if (last && sameFrom(last.from, run.from) && sameLook(last.set, run.set) && sameLook(last.look, run.look)) runs[runs.length - 1] = { ...last, text: last.text + run.text };
      else runs.push(run);
    }
    if (runs.length === 0) return { ...para, runs };
    const done: EditPara = { ...para, runs, look: runs[0].look, pending: {} };
    delete done.carry;
    return done;
  });
}

export const paraText = (para: EditPara): string => para.runs.map((r) => r.text).join("");
export const modelText = (model: Model): string => model.map(paraText).join("\n");

const before = (a: Point, b: Point): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
export const collapsed = (sel: Sel): boolean => sel.from[0] === sel.to[0] && sel.from[1] === sel.to[1];
/** A selection with its ends in order. */
export const ordered = (a: Point, b: Point): Sel => (before(b, a) ? { from: b, to: a } : { from: a, to: b });
/** The whole of the words. */
export const allOf = (model: Model): Sel => ({ from: [0, 0], to: [model.length - 1, paraText(model[model.length - 1]).length] });
/** The end of the words. */
export const endOf = (model: Model): Sel => {
  const end = allOf(model).to;
  return { from: end, to: end };
};

/** A paragraph's runs cut at a character: the runs before it and the runs after. */
function cut(runs: readonly EditRun[], at: number): [EditRun[], EditRun[]] {
  const left: EditRun[] = [];
  const right: EditRun[] = [];
  let seen = 0;
  for (const run of runs) {
    const end = seen + run.text.length;
    if (end <= at) left.push(run);
    else if (seen >= at) right.push(run);
    else {
      left.push({ ...run, text: run.text.slice(0, at - seen) });
      right.push({ ...run, text: run.text.slice(at - seen) });
    }
    seen = end;
  }
  return [left, right];
}

/** The range of characters a selection covers in paragraph `p`, `[lo, hi)`. */
function span(model: Model, sel: Sel, p: number): [number, number] {
  const length = paraText(model[p]).length;
  return [p === sel.from[0] ? sel.from[1] : 0, p === sel.to[0] ? sel.to[1] : length];
}

const WORD = /[\p{L}\p{N}_'’-]/u;

/** The word a caret stands in, or null at a word's edge or in a space. */
export function wordAt(model: Model, point: Point): Sel | null {
  const para = model[point[0]];
  if (!para) return null;
  const text = paraText(para);
  const at = point[1];
  if (!WORD.test(text[at - 1] ?? "") || !WORD.test(text[at] ?? "")) return null;
  let lo = at;
  let hi = at;
  while (lo > 0 && WORD.test(text[lo - 1])) lo--;
  while (hi < text.length && WORD.test(text[hi])) hi++;
  return { from: [point[0], lo], to: [point[0], hi] };
}

/**
 * A look laid on a selection, splitting the runs at its ends. A caret in a
 * word takes the whole word, as PowerPoint does; a caret anywhere else keeps
 * the look for the words typed next (`pending`).
 */
export function applyLook(model: Model, sel: Sel, look: RunLook, pending: RunLook = {}): { model: Model; pending: RunLook } {
  if (collapsed(sel)) {
    const word = wordAt(model, sel.from);
    if (!word) {
      const para = model[sel.from[0]];
      if (para && para.runs.length === 0) return { model: model.map((p, i) => (i === sel.from[0] ? { ...p, pending: { ...p.pending, ...look }, look: { ...p.look, ...look } } : p)), pending: {} };
      return { model, pending: { ...pending, ...look } };
    }
    sel = word;
  }
  const next = model.map((para, p) => {
    if (p < sel.from[0] || p > sel.to[0]) return para;
    const [lo, hi] = span(model, sel, p);
    if (para.runs.length === 0) return { ...para, pending: { ...para.pending, ...look }, look: { ...para.look, ...look } };
    const [head, rest] = cut(para.runs, lo);
    const [mid, tail] = cut(rest, hi - lo);
    return { ...para, runs: [...head, ...mid.map((run) => ({ ...run, set: { ...run.set, ...look }, look: { ...run.look, ...look } })), ...tail] };
  });
  return { model: normalize(next), pending };
}

/** A paragraph's level, alignment or list, on every paragraph the selection touches. */
export function applyPara(model: Model, sel: Sel, set: ParaLook): Model {
  return model.map((para, p) => (p < sel.from[0] || p > sel.to[0] ? para : { ...para, ...set, set: { ...para.set, ...set } }));
}

/** The selection's words taken out; answers the model and the caret where they were. */
export function deleteRange(model: Model, sel: Sel): { model: Model; at: Point } {
  if (collapsed(sel)) return { model, at: sel.from };
  const [p0, c0] = sel.from;
  const [p1, c1] = sel.to;
  const [head] = cut(model[p0].runs, c0);
  const [, tail] = cut(model[p1].runs, c1);
  const joined: EditPara = { ...model[p0], runs: [...head, ...tail] };
  return { model: normalize([...model.slice(0, p0), joined, ...model.slice(p1 + 1)]), at: [p0, c0] };
}

/**
 * Words put in at a caret (or over a selection): they join the run before the
 * caret, or the first run at a paragraph's start, and take `pending` on top.
 * `\n` in `text` is a line break; a new paragraph is `splitParagraph`.
 */
export function insertText(model: Model, sel: Sel, text: string, pending: RunLook = {}): { model: Model; at: Point } {
  const removed = deleteRange(model, sel);
  const [p, c] = removed.at;
  const para = removed.model[p];
  const [head, tail] = cut(para.runs, c);
  const near = head[head.length - 1] ?? tail[0];
  const extra = Object.keys(pending).length > 0;
  let runs: EditRun[];
  if (!near) runs = [{ text, ...(para.carry?.from ? { from: para.carry.from } : {}), look: { ...para.look, ...pending }, set: { ...para.carry?.set, ...para.pending, ...pending } }];
  else if (extra) runs = [...head, { text, ...(near.from ? { from: near.from } : {}), look: { ...near.look, ...pending }, set: { ...near.set, ...pending } }, ...tail];
  else if (head.length > 0) runs = [...head.slice(0, -1), { ...near, text: near.text + text }, ...tail];
  else runs = [{ ...near, text: text + near.text }, ...tail.slice(1)];
  const next = removed.model.map((q, i) => (i === p ? { ...para, runs } : q));
  return { model: normalize(next), at: [p, c + text.length] };
}

/** Return: the paragraph cut in two at the caret; the new one keeps the paragraph it came from, its level, alignment and list. */
export function splitParagraph(model: Model, sel: Sel): { model: Model; at: Point } {
  const removed = deleteRange(model, sel);
  const [p, c] = removed.at;
  const para = removed.model[p];
  const [head, tail] = cut(para.runs, c);
  const atCut = head[head.length - 1] ?? tail[0];
  const lookAtCut = atCut?.look ?? para.look;
  const carry = atCut ? { ...(atCut.from ? { from: atCut.from } : {}), set: atCut.set } : para.carry;
  const first: EditPara = { ...para, runs: head, look: head[0]?.look ?? lookAtCut, ...(carry ? { carry } : {}) };
  const second: EditPara = { ...para, runs: tail, look: tail[0]?.look ?? lookAtCut, pending: tail.length > 0 ? {} : para.pending, ...(carry ? { carry } : {}) };
  return { model: normalize([...removed.model.slice(0, p), first, second, ...removed.model.slice(p + 1)]), at: [p + 1, 0] };
}

/** Pasted words: each line a paragraph, as plain text. */
export function pasteText(model: Model, sel: Sel, text: string, pending: RunLook = {}): { model: Model; at: Point } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let out = insertText(model, sel, lines[0], pending);
  for (const line of lines.slice(1)) {
    const split = splitParagraph(out.model, { from: out.at, to: out.at });
    out = insertText(split.model, { from: split.at, to: split.at }, line, pending);
  }
  return out;
}

/** What one control of the row shows: the one value the selection has, or null when it mixes several. */
export type Shown<T> = T | null;
export interface Showing {
  font: Shown<string | undefined>;
  size: Shown<number | undefined>;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: Shown<string | undefined>;
  align: Shown<Align>;
  list: Shown<ListKind>;
  level: Shown<number>;
}

const one = <T>(values: readonly T[]): Shown<T> => (values.length > 0 && values.every((v) => v === values[0]) ? values[0] : null);

/**
 * What the row shows for a selection: a caret shows the look of the words
 * before it (and what waits for the next words); a range shows each part of
 * the look where every run in it agrees, else mixed. A toggle is on only
 * when the whole range has it.
 */
export function showing(model: Model, sel: Sel, pending: RunLook = {}): Showing {
  const looks: RunLook[] = [];
  if (collapsed(sel)) {
    const para = model[sel.from[0]];
    const [head, tail] = cut(para?.runs ?? [], sel.from[1]);
    looks.push({ ...(head[head.length - 1]?.look ?? tail[0]?.look ?? para?.look ?? {}), ...pending });
  } else {
    for (let p = sel.from[0]; p <= sel.to[0]; p++) {
      const [lo, hi] = span(model, sel, p);
      const [, rest] = cut(model[p].runs, lo);
      const [mid] = cut(rest, hi - lo);
      if (mid.length > 0) looks.push(...mid.map((r) => r.look));
      else if (model[p].runs.length === 0) looks.push(model[p].look);
    }
    if (looks.length === 0) looks.push(model[sel.from[0]]?.look ?? {});
  }
  const paras = model.slice(sel.from[0], sel.to[0] + 1);
  return {
    font: one(looks.map((l) => l.font)),
    size: one(looks.map((l) => l.size)),
    bold: looks.every((l) => !!l.bold),
    italic: looks.every((l) => !!l.italic),
    underline: looks.every((l) => !!l.underline),
    color: one(looks.map((l) => l.color)),
    align: one(paras.map((p) => p.align)),
    list: one(paras.map((p) => p.list)),
    level: one(paras.map((p) => p.level)),
  };
}

/** The look of every run in it: what the row shows for a shape picked whole. */
export const showingAll = (model: Model): Showing => showing(model, allOf(model));

/**
 * A shape's words, a paragraph each as the words of its runs: what a box's edit says it was made on (`runsOp`'s `was`).
 * Runs, not words alone: a look changed in PowerPoint cuts a run in two with the words alike, and the box's `from`s
 * would then name other runs.
 */
export const wordsOf = (shape: DeckShape): string[][] => (shape.paragraphs ?? []).map((p) => p.runs.map((r) => r.text));

/**
 * One `runs` edit: each paragraph and run with the one it came from, and only what he set. `was`: the shape's words
 * its `from`s name, so the host writes nothing over words that changed since (saved in PowerPoint, another window).
 */
export function runsOp(model: Model, slide: number, shape: number, was?: readonly string[][]): Extract<SlideOp, { op: "runs" }> {
  return {
    op: "runs",
    slide,
    shape,
    ...(was ? { was: was.map((p) => [...p]) } : {}),
    paragraphs: model.map((para) => ({
      ...(para.from !== undefined ? { from: para.from } : {}),
      ...Object.fromEntries(PARA_KEYS.filter((k) => para.set[k] !== undefined).map((k) => [k, para.set[k]])),
      runs: para.runs.map((run) => ({ text: run.text, ...(run.from ? { from: run.from } : {}), ...wireLook(run.set) })),
    })),
  };
}

/**
 * Where a box's paragraphs and runs lie in the file once the host wrote `sent` (deckScript.ts `op_runs`): paragraph
 * i is the edit's paragraph i, and a run is as many of the file's runs as it has pieces between line breaks, each
 * break one of them. Answers what moves every `from` a model of the box holds onto them, so the next send names the
 * runs its words now lie in: a run by the run it came from and what he set on it (two runs alike in both are written
 * alike), a paragraph likewise. One whose run or paragraph of the file was written, but with another look on top (his
 * box's Undo took back a look the keep wrote), still names it, so it keeps all its own run held (a link, a raised
 * letter, a custom mark, margins), and sets over it only what differs from what was written there. One whose source
 * was not written at all (words taken out, then brought back) names nothing: it sets its whole look as drawn, a
 * paragraph its level, alignment and list.
 */
export function renumber(sent: Model): (model: Model) => Model {
  const runs = new Map<string, [number, number]>();
  const paras = new Map<string, number>();
  /** Where each run and paragraph of the file was written, with the look the edit laid on it there. */
  const runsOf = new Map<string, { at: [number, number]; set: RunLook }>();
  const parasOf = new Map<string, { at: number; set: ParaLook }>();
  const runKey = (from: unknown, set: RunLook): string => JSON.stringify([from, wireLook(set)]);
  const paraKey = (from: unknown, set: ParaLook): string => JSON.stringify([from, PARA_KEYS.map((k) => set[k] ?? null)]);
  const first = <V>(map: Map<string, V>, key: string, value: V): void => void (map.has(key) || map.set(key, value));
  sent.forEach((para, p) => {
    if (para.from !== undefined) {
      first(paras, paraKey(para.from, para.set), p);
      first(parasOf, String(para.from), { at: p, set: para.set });
    }
    let at = 0;
    for (const run of para.runs) {
      if (run.from) {
        first(runs, runKey(run.from, run.set), [p, at] as [number, number]);
        first(runsOf, JSON.stringify(run.from), { at: [p, at], set: run.set });
      }
      const pieces = run.text.split(/[\n\v]/);
      at += pieces.length - 1 + pieces.filter(Boolean).length;
    }
  });
  /** A run moved onto where it was written: by its source and look, else by its source with the look it differs by, else none. */
  const moveRun = (from: [number, number] | undefined, set: RunLook, look: RunLook): { from?: [number, number]; set: RunLook } => {
    if (!from) return { set };
    const same = runs.get(runKey(from, set));
    if (same) return { from: same, set };
    const there = runsOf.get(JSON.stringify(from));
    return there ? { from: there.at, set: { ...lookOver(there.set, set, look), ...set } } : { set: { ...lookSet(look), ...set } };
  };
  return (model) =>
    model.map(({ from, carry, ...para }) => {
      const same = from === undefined ? undefined : paras.get(paraKey(from, para.set));
      const there = from === undefined || same !== undefined ? undefined : parasOf.get(String(from));
      const moved = carry ? moveRun(carry.from, carry.set, para.look) : null;
      return {
        ...para,
        ...(same !== undefined
          ? { from: same }
          : there
            ? { from: there.at, set: { ...paraOver(there.set, para), ...para.set } }
            : from !== undefined
              ? { set: { level: para.level, align: para.align, list: para.list, ...para.set } }
              : {}),
        ...(moved ? { carry: { set: moved.set, ...(moved.from ? { from: moved.from } : {}) } } : {}),
        runs: para.runs.map(({ from: was, ...r }) => {
          const now = moveRun(was, r.set, r.look);
          return { ...r, set: now.set, ...(now.from ? { from: now.from } : {}) };
        }),
      };
    });
}

/**
 * What a run must set over the run of the file it names to look as drawn, where the edit wrote that run with `written`
 * on top and the run now sets `set`: each part `written` set that `set` does not, put back as it is drawn.
 */
function lookOver(written: RunLook, set: RunLook, look: RunLook): RunLook {
  const out: RunLook = {};
  for (const key of LOOK_KEYS) {
    if (written[key] === undefined || set[key] !== undefined) continue;
    if (key === "bold" || key === "italic" || key === "underline") out[key] = !!look[key];
    else if (key === "theme") out.theme = look.theme ?? null;
    else if (look[key] !== undefined) (out as Record<string, unknown>)[key] = look[key];
  }
  if (out.color !== undefined && look.theme) out.theme = look.theme;
  return out;
}

/** The same for a paragraph: its level, alignment or list where the edit wrote one it no longer sets. */
function paraOver(written: ParaLook, para: Pick<EditPara, "level" | "align" | "list" | "set">): ParaLook {
  const out: ParaLook = {};
  for (const key of PARA_KEYS) if (written[key] !== undefined && para.set[key] === undefined) (out as Record<string, unknown>)[key] = para[key];
  return out;
}

/** A look as one he set it all: what a run takes when it no longer names a run of the file to keep its look from. */
function lookSet(look: RunLook): RunLook {
  const out: RunLook = { bold: !!look.bold, italic: !!look.italic, underline: !!look.underline };
  if (look.font !== undefined) out.font = look.font;
  if (look.size !== undefined) out.size = look.size;
  if (look.color !== undefined) out.color = look.color;
  if (look.theme) out.theme = look.theme;
  return out;
}

/** Whether the box holds what the shape held: then nothing is sent. */
export const unchanged = (model: Model, initial: Model): boolean => JSON.stringify(runsOp(normalize(model), 0, 0)) === JSON.stringify(runsOp(normalize(initial), 0, 0));

/** Whether the shape's words in a newer view are still the ones the box was opened on: its `from`s still name the same runs. */
export const sameWords = (a: DeckShape | undefined, b: DeckShape | undefined): boolean => !!a && !!b && JSON.stringify(a.paragraphs) === JSON.stringify(b.paragraphs);

/**
 * His words kept over a shape that changed under him (`was` the words his `from`s were read from, `now` the shape as
 * it is): each run and paragraph is moved onto the one of the new words that is the same (its words and its look, as
 * the outline gives them; a paragraph whose words changed, by a run of it still there), in its own paragraph first, else
 * the one alike anywhere; never onto whatever now stands at its old place (a run put in before it there by another save would lend it its look). What has no such one names
 * nothing and keeps its look by setting it, as `renumber` does, and what he set stays.
 */
export function rebase(model: Model, was: DeckShape | undefined, now: DeckShape): Model {
  const olds = was?.paragraphs ?? [];
  const news = now.paragraphs ?? [];
  const paraWord = (p: DeckParagraph): string => JSON.stringify([p.runs.map((r) => r.text).join(""), p.level, p.align, p.list]);
  const one = <T>(found: T[]): T | undefined => (found.length === 1 ? found[0] : undefined);
  const para = (p: number): number | undefined => {
    const old = olds[p];
    if (!old) return undefined;
    const pick = (found: number[]): number | undefined => (found.includes(p) ? p : one(found));
    // The same paragraph, words and all; else, where words changed in it, the one of its level and list that still
    // holds one of its runs as it was.
    const alike = pick(news.flatMap((n, q) => (paraWord(n) === paraWord(old) ? [q] : [])));
    if (alike !== undefined) return alike;
    const runWords = new Set(old.runs.filter((r) => r.text).map((r) => JSON.stringify(r)));
    return pick(news.flatMap((n, q) => (n.level === old.level && n.list === old.list && n.runs.some((x) => runWords.has(JSON.stringify(x))) ? [q] : [])));
  };
  const run = ([p, r]: [number, number]): [number, number] | undefined => {
    const old = olds[p]?.runs[r];
    if (!old) return undefined;
    const word = JSON.stringify(old);
    const alike = news.flatMap((n, q) => n.runs.flatMap((x, s) => (JSON.stringify(x) === word ? [[q, s] as [number, number]] : [])));
    const home = alike.filter(([q, s]) => q === p && s === r);
    return home[0] ?? one(alike.filter(([q]) => q === p)) ?? one(alike);
  };
  return model.map(({ from, ...p }) => {
    const to = from === undefined ? undefined : para(from);
    return {
      ...p,
      ...(to !== undefined ? { from: to } : from !== undefined ? { set: { level: p.level, align: p.align, list: p.list, ...p.set } } : {}),
      runs: p.runs.map(({ from: at, ...r }) => {
        const moved = at ? run(at) : undefined;
        return moved ? { ...r, from: moved } : at ? { ...r, set: { ...lookSet(r.look), ...r.set } } : r;
      }),
    };
  });
}

/** The look of the whole shape as one `format` edit sets it. */
export function formatOp(slide: number, shape: number, set: RunLook & ParaLook): Extract<SlideOp, { op: "format" }> {
  const { level, align, list, ...look } = set;
  return { op: "format", slide, shape, set: { ...wireLook(look), ...(level !== undefined ? { level } : {}), ...(align !== undefined ? { align } : {}), ...(list !== undefined ? { list } : {}) } };
}
