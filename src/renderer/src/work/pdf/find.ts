import type { Bbox } from "@shared/contract-work-pdf";
import type { TextRun } from "./engine";

/** One match of a find: the page and the box over the matched words in each run it spans. */
export interface FindHit {
  page: number;
  boxes: Bbox[];
}

const fold = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * The matches of `query` on one page, in reading order. Case and accents
 * are ignored, and a match may cross from one run of text into the next (a
 * phrase broken over two runs, or over a line end, where pdf.js's runs meet
 * with no space).
 */
export function findOnPage(page: number, runs: readonly TextRun[], query: string): FindHit[] {
  const q = fold(query.trim()).replace(/\s+/g, " ");
  if (!q) return [];
  // The page's words as one string, a space between runs; each character knows its run.
  let text = "";
  const owner: number[] = [];
  const offset: number[] = [];
  runs.forEach((run, index) => {
    if (index > 0 && !/\s$/.test(text)) {
      text += " ";
      owner.push(-1);
      offset.push(0);
    }
    const folded = fold(run.str);
    for (let i = 0; i < folded.length; i++) {
      owner.push(index);
      offset.push(Math.min(i, run.str.length - 1));
    }
    text += folded;
  });
  const squeezed = text.replace(/\s/g, " ");
  const hits: FindHit[] = [];
  for (let at = squeezed.indexOf(q); at >= 0; at = squeezed.indexOf(q, at + Math.max(1, q.length))) {
    const spans = new Map<number, [number, number]>();
    for (let i = at; i < at + q.length; i++) {
      const run = owner[i];
      if (run < 0) continue;
      const span = spans.get(run);
      spans.set(run, span ? [span[0], offset[i]] : [offset[i], offset[i]]);
    }
    const boxes: Bbox[] = [];
    for (const [run, [from, to]] of spans) {
      const { str, box } = runs[run];
      const n = Math.max(1, str.length);
      const w = box[2] - box[0];
      boxes.push([box[0] + (w * from) / n, box[1], box[0] + (w * (to + 1)) / n, box[3]]);
    }
    if (boxes.length) hits.push({ page, boxes });
  }
  return hits;
}
