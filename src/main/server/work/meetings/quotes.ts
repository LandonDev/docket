import type { RawWord } from './raw'

/**
 * Keeping a writer's quotes true (docs/agents/work-meetings.md, "Notes").
 * A model proposes a quote; the host finds it in the transcript and keeps
 * the transcript's own words, the turns they sit in and the moment they
 * start. A quote that is not there (a paraphrase, an invention) comes back
 * null and is dropped.
 */

export interface QuoteSegment {
  id: string
  start: number
  end: number | null
  text: string
  /** the words with their times, when the transcript has them */
  words?: RawWord[]
}

export interface QuoteHit {
  /** the transcript's own text, never the writer's wording */
  text: string
  segIds: string[]
  /** seconds: where the matched words start and end */
  start: number
  end: number
  /** 1: the same words once case and punctuation are set aside; lower: a near match */
  score: number
}

/** The least agreement a quote needs: nine tokens in ten, which lets a dropped "um" or one misheard word pass and no paraphrase. */
export const QUOTE_MIN_SCORE = 0.9

const TOKEN = /[A-Za-z0-9’']+/g
const norm = (s: string): string => s.toLowerCase().replace(/[’']/g, '')
/** A text's tokens: lower case, apostrophes dropped, split at anything that is not a letter or a digit. */
export const tokensOf = (s: string): string[] =>
  norm(s)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)

interface Tok {
  t: string
  /** index of its segment */
  seg: number
  /** where its source word starts and ends in the segment's text */
  from: number
  to: number
  start: number
  end: number
}

/** Every token of the transcript in order, each with its place in its segment's text and its time. */
function flatten(segs: readonly QuoteSegment[]): Tok[] {
  const flat: Tok[] = []
  segs.forEach((seg, si) => {
    const spans: { from: number; to: number; tokens: string[] }[] = []
    for (const m of seg.text.matchAll(TOKEN)) {
      const tokens = tokensOf(m[0])
      if (tokens.length) spans.push({ from: m.index, to: m.index + m[0].length, tokens })
    }
    const total = spans.reduce((n, s) => n + s.tokens.length, 0)
    const end = seg.end ?? seg.start
    // Word times when the text is still the recogniser's own words; else spread evenly across the turn.
    const timed = seg.words && seg.words.reduce((n, w) => n + tokensOf(w.w).length, 0) === total ? seg.words.flatMap((w) => tokensOf(w.w).map(() => w)) : null
    let k = 0
    for (const span of spans) {
      for (const t of span.tokens) {
        const w = timed?.[k]
        flat.push({
          t,
          seg: si,
          from: span.from,
          to: span.to,
          start: w ? w.s : seg.start + ((end - seg.start) * k) / Math.max(1, total),
          end: w ? w.e : seg.start + ((end - seg.start) * (k + 1)) / Math.max(1, total)
        })
        k++
      }
    }
  })
  return flat
}

function editDistance(a: readonly string[], b: readonly string[]): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

/** A transcript made ready for many quotes. */
export interface QuoteIndex {
  segs: readonly QuoteSegment[]
  flat: Tok[]
}
export const quoteIndex = (segs: readonly QuoteSegment[]): QuoteIndex => ({ segs, flat: flatten(segs) })

/**
 * Finds a quote in the transcript, across turns if it runs over one. The
 * exact run of tokens first; else the closest window of the quote's length
 * give or take two tokens, kept only at `minScore` agreement or better.
 * `near` (segment ids) breaks a tie between equal matches: the one in or
 * nearest those turns wins.
 */
export function matchQuote(quote: string, index: QuoteIndex, opts: { minScore?: number; near?: readonly string[] } = {}): QuoteHit | null {
  const q = tokensOf(quote)
  const { flat, segs } = index
  if (q.length === 0 || flat.length === 0) return null
  const minScore = opts.minScore ?? QUOTE_MIN_SCORE
  const near = new Set((opts.near ?? []).map((id) => segs.findIndex((s) => s.id === id)).filter((i) => i >= 0))
  const distanceTo = (seg: number): number => (near.size ? Math.min(...[...near].map((n) => Math.abs(n - seg))) : 0)
  let best = { score: 0, i: -1, len: 0, far: Infinity }
  // The quote's own length first: of two windows that agree as well, the one as long as the quote is kept.
  const lengths = [0, -1, 1, -2, 2].map((d) => q.length + d).filter((len) => len >= 1)
  for (const len of lengths) {
    for (let i = 0; i + len <= flat.length; i++) {
      // A cheap anchor: a window worth scoring starts or ends on the quote's own first or last token.
      if (flat[i].t !== q[0] && flat[i + len - 1].t !== q[q.length - 1]) continue
      const d = editDistance(
        q,
        flat.slice(i, i + len).map((x) => x.t)
      )
      const score = 1 - d / Math.max(q.length, len)
      const far = distanceTo(flat[i].seg)
      if (score > best.score || (score === best.score && far < best.far)) best = { score, i, len, far }
    }
  }
  // One token agrees with nothing by chance less often than it should: a single common word is no quote.
  if (best.i < 0 || best.score < minScore || (q.length < 3 && best.score < 1)) return null
  const first = flat[best.i]
  const last = flat[best.i + best.len - 1]
  const text =
    first.seg === last.seg
      ? segs[first.seg].text.slice(first.from, last.to)
      : [segs[first.seg].text.slice(first.from), ...segs.slice(first.seg + 1, last.seg).map((s) => s.text), segs[last.seg].text.slice(0, last.to)].join(' ')
  return {
    text,
    segIds: segs.slice(first.seg, last.seg + 1).map((s) => s.id),
    start: Number(first.start.toFixed(2)),
    end: Number(last.end.toFixed(2)),
    score: Number(best.score.toFixed(3))
  }
}
