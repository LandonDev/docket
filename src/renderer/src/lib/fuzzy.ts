/** Sequential fuzzy match — all query characters in order, with bonuses
 *  for consecutive runs, path separators, and camelCase boundaries. */

export type FuzzyHit = {
  score: number;
  positions: number[];
};

export function fuzzyMatch(query: string, text: string): FuzzyHit | null {
  return fuzzyMatchPrepared(prepareQuery(query), text, text.toLowerCase());
}

/** A query's tokens, split and lower-cased once a key rather than once a row. */
export function prepareQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** `fuzzyMatch` with the query prepared once (`prepareQuery`) and the text's lower case already in hand. */
export function fuzzyMatchPrepared(tokens: readonly string[], text: string, lower: string): FuzzyHit | null {
  if (tokens.length === 0) return { score: 0, positions: [] };
  if (tokens.length === 1) return matchToken(tokens[0], text, lower);

  const positions: number[] = [];
  let score = 0;
  for (const token of tokens) {
    const hit = matchToken(token, text, lower);
    if (!hit) return null;
    score += hit.score;
    for (const index of hit.positions) positions.push(index);
  }
  positions.sort((a, b) => a - b);
  return { score, positions };
}

/** `needle` is lower case already; `hay` is `text` lower-cased. */
function matchToken(needle: string, text: string, hay: string): FuzzyHit | null {
  if (!needle) return { score: 0, positions: [] };

  const positions: number[] = [];
  let score = 0;
  let consecutive = 0;
  let qi = 0;

  for (let i = 0; i < hay.length && qi < needle.length; i++) {
    if (hay[i] !== needle[qi]) {
      consecutive = 0;
      continue;
    }
    positions.push(i);
    consecutive += 1;
    score += 1 + consecutive * 4;
    if (i === 0 || isBreak(text[i - 1])) score += 14;
    else if (isUpper(text[i]) && !isUpper(text[i - 1])) score += 10;
    qi += 1;
  }

  if (qi !== needle.length) return null;
  score -= hay.length - needle.length;
  return { score, positions };
}

function isBreak(ch: string): boolean {
  return ch === "/" || ch === "\\" || ch === "-" || ch === "_" || ch === "." || ch === " ";
}

function isUpper(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}

/** Prefer filename hits over directory-only hits. Positions index `relative`. */
export function scorePath(
  query: string,
  relative: string,
  name: string,
): FuzzyHit | null {
  return scorePathPrepared(prepareQuery(query), relative, relative.toLowerCase(), name, name.toLowerCase());
}

/** `scorePath` with the query prepared once a key and the path's lower case kept once a list (`loweredPaths`). */
export function scorePathPrepared(
  tokens: readonly string[],
  relative: string,
  relativeLower: string,
  name: string,
  nameLower: string,
): FuzzyHit | null {
  if (tokens.length === 0) return { score: 0, positions: [] };

  const offset = Math.max(0, relative.length - name.length);
  const nameHit = fuzzyMatchPrepared(tokens, name, nameLower);
  if (nameHit) {
    return {
      score: nameHit.score + 400,
      positions: nameHit.positions.map((index) => index + offset),
    };
  }

  return fuzzyMatchPrepared(tokens, relative, relativeLower);
}

export type LoweredPaths = { relative: string[]; name: string[] };
const lowered = new WeakMap<readonly object[], LoweredPaths>();

/** Each path's and name's lower case, made once a list (kept while the list lives). */
export function loweredPaths(files: readonly { relative: string; name: string }[]): LoweredPaths {
  let out = lowered.get(files);
  if (!out) {
    out = { relative: new Array<string>(files.length), name: new Array<string>(files.length) };
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      out.relative[i] = file.relative.toLowerCase();
      out.name[i] = file.name.toLowerCase();
    }
    lowered.set(files, out);
  }
  return out;
}
