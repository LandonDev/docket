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
export const typable = (shape: DeckShape): boolean => shape.kind === "text" && Array.isArray(shape.paragraphs);

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
  // A paragraph with no runs takes the look of the nearest one that has some, else the fallback.
  const firstLook = (p: number): RunLook => {
    for (let d = 0; d < paras.length; d++) {
      for (const at of [p - d, p + d]) {
        const run = paras[at]?.runs.find((r) => r.text !== "");
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

/** One `runs` edit: each paragraph and run with the one it came from, and only what he set. */
export function runsOp(model: Model, slide: number, shape: number): Extract<SlideOp, { op: "runs" }> {
  return {
    op: "runs",
    slide,
    shape,
    paragraphs: model.map((para) => ({
      ...(para.from !== undefined ? { from: para.from } : {}),
      ...Object.fromEntries(PARA_KEYS.filter((k) => para.set[k] !== undefined).map((k) => [k, para.set[k]])),
      runs: para.runs.map((run) => ({ text: run.text, ...(run.from ? { from: run.from } : {}), ...wireLook(run.set) })),
    })),
  };
}

/** Whether the box holds what the shape held: then nothing is sent. */
export const unchanged = (model: Model, initial: Model): boolean => JSON.stringify(runsOp(normalize(model), 0, 0)) === JSON.stringify(runsOp(normalize(initial), 0, 0));

/** Whether the shape's words in a newer view are still the ones the box was opened on: its `from`s still name the same runs. */
export const sameWords = (a: DeckShape | undefined, b: DeckShape | undefined): boolean => !!a && !!b && JSON.stringify(a.paragraphs) === JSON.stringify(b.paragraphs);

/**
 * His words kept over a shape that changed under him: each `from` that the
 * new words still have stays, the others go (those runs take their
 * paragraph's first look from the host), and what he set stays.
 */
export function rebase(model: Model, shape: DeckShape): Model {
  const paras = shape.paragraphs ?? [];
  return model.map(({ from, ...para }) => ({
    ...para,
    ...(from !== undefined && from < paras.length ? { from } : {}),
    runs: para.runs.map((run) => (run.from && paras[run.from[0]]?.runs[run.from[1]] ? run : { text: run.text, look: run.look, set: run.set })),
  }));
}

/** The look of the whole shape as one `format` edit sets it. */
export function formatOp(slide: number, shape: number, set: RunLook & ParaLook): Extract<SlideOp, { op: "format" }> {
  const { level, align, list, ...look } = set;
  return { op: "format", slide, shape, set: { ...wireLook(look), ...(level !== undefined ? { level } : {}), ...(align !== undefined ? { align } : {}), ...(list !== undefined ? { list } : {}) } };
}
