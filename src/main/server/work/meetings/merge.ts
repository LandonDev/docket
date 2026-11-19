import type { RawTurn, RawVoices, RawWord } from './raw'

/**
 * From the transcriber's words and speaker turns to the meeting's segments
 * (docs/agents/work-meetings.md, "The pipeline"): each word takes the turn
 * it overlaps most, and a run of one speaker's words is a segment.
 */

/** A segment as the meeting keeps it: the wire's segment plus the words' times. */
export interface DocSegment {
  id: string
  speaker: string | null
  start: number
  end: number | null
  text: string
  words?: RawWord[]
  /** the owner corrected its text; its id and times stay */
  edited?: boolean
}

/** A pause this long between one speaker's words starts a new segment. */
export const SEGMENT_GAP_SEC = 1.5
/** A segment this long ends at its next sentence end, so a monologue reads as paragraphs and a citation names a part of it. */
export const SEGMENT_LONG_SEC = 45
/** A speaker heard for less than this in all is a stray cluster. */
export const STRAY_SEC = 10

const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/**
 * Folds stray speakers into the ones that held the meeting. The diarizer's
 * clustering leaves a few labels with seconds of speech (a cough, a
 * cross-talk fragment); each joins the larger speaker its voice is nearest,
 * or, with no voice to compare, the speaker of the turn nearest in time.
 */
export function foldStrays(turns: readonly RawTurn[], voices: RawVoices, minSec = STRAY_SEC): { turns: RawTurn[]; voices: RawVoices } {
  const spoke = new Map<number, number>()
  for (const t of turns) spoke.set(t.speaker, (spoke.get(t.speaker) ?? 0) + Math.max(0, t.end - t.start))
  const kept = [...spoke].filter(([, sec]) => sec >= minSec).map(([s]) => s)
  // A meeting of nothing but fragments keeps its speakers as found.
  if (kept.length === 0 || kept.length === spoke.size) return { turns: [...turns], voices: { ...voices } }
  const to = new Map<number, number>()
  for (const [speaker] of spoke) {
    if (kept.includes(speaker)) continue
    const voice = voices[String(speaker)]
    let best: number | null = null
    if (voice) {
      let top = -Infinity
      for (const k of kept) {
        const kv = voices[String(k)]
        if (!kv) continue
        const c = cosine(voice, kv)
        if (c > top) [top, best] = [c, k]
      }
    }
    if (best === null) {
      const mine = turns.filter((t) => t.speaker === speaker)
      let gap = Infinity
      for (const t of turns) {
        if (!kept.includes(t.speaker)) continue
        for (const m of mine) {
          const g = Math.max(0, Math.max(t.start, m.start) - Math.min(t.end, m.end))
          if (g < gap) [gap, best] = [g, t.speaker]
        }
      }
    }
    to.set(speaker, best ?? kept[0])
  }
  const outVoices: RawVoices = {}
  for (const k of kept) if (voices[String(k)]) outVoices[String(k)] = voices[String(k)]
  return { turns: turns.map((t) => (to.has(t.speaker) ? { ...t, speaker: to.get(t.speaker)! } : t)), voices: outVoices }
}

/** The transcriber's speaker numbers as the meeting's ids, in order of first speaking: the first voice heard is `S1`. */
export function speakerIds(turns: readonly RawTurn[]): Map<number, string> {
  const ids = new Map<number, string>()
  for (const t of [...turns].sort((a, b) => a.start - b.start || a.end - b.end)) if (!ids.has(t.speaker)) ids.set(t.speaker, `S${ids.size + 1}`)
  return ids
}

/** Assigns words to turns as they arrive, and builds the segments so far. Earlier segments never change once a later one exists. */
export class Merger {
  private readonly turns: RawTurn[]
  private readonly ids: Map<number, string>
  private readonly words: { word: RawWord; speaker: string | null }[] = []
  /** The longest turn: how far back a turn that overlaps a word may start. */
  private readonly longest: number

  constructor(turns: readonly RawTurn[]) {
    this.turns = [...turns].sort((a, b) => a.start - b.start || a.end - b.end)
    this.ids = speakerIds(this.turns)
    this.longest = this.turns.reduce((n, t) => Math.max(n, t.end - t.start), 0)
  }

  get speakers(): string[] {
    return [...this.ids.values()]
  }

  /** The meeting's id for one of the transcriber's speaker numbers. */
  idOf(speaker: number): string | undefined {
    return this.ids.get(speaker)
  }

  /** The turn a stretch overlaps most; with none, the nearest in time. */
  private speakerAt(start: number, end: number): string | null {
    const turns = this.turns
    if (turns.length === 0) return null
    // The first turn that starts after the stretch ends: nothing from there on overlaps it.
    let lo = 0
    let hi = turns.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (turns[mid].start < end) lo = mid + 1
      else hi = mid
    }
    let best: RawTurn | null = null
    let most = 0
    for (let i = lo - 1; i >= 0 && turns[i].start >= start - this.longest; i--) {
      const o = Math.min(end, turns[i].end) - Math.max(start, turns[i].start)
      if (o > most) [most, best] = [o, turns[i]]
    }
    if (!best) {
      const mid = (start + end) / 2
      let gap = Infinity
      for (const i of [lo - 1, lo]) {
        const t = turns[i]
        if (!t) continue
        const g = Math.min(Math.abs(t.start - mid), Math.abs(t.end - mid))
        if (g < gap) [gap, best] = [g, t]
      }
      // The turn before may not be the one that ended last: look back as far as a turn can reach.
      for (let i = lo - 2; i >= 0 && turns[i].start >= start - this.longest - gap; i--) {
        const g = Math.abs(turns[i].end - mid)
        if (g < gap) [gap, best] = [g, turns[i]]
      }
    }
    return best ? (this.ids.get(best.speaker) ?? null) : null
  }

  add(words: readonly RawWord[]): void {
    for (const word of words) {
      const w = word.w.trim()
      if (w) this.words.push({ word: { w, s: word.s, e: Math.max(word.e, word.s) }, speaker: this.speakerAt(word.s, Math.max(word.e, word.s + 0.01)) })
    }
  }

  /** The segments so far, `s1` on. */
  segments(): DocSegment[] {
    const out: DocSegment[] = []
    let cur: DocSegment | null = null
    for (const { word, speaker } of this.words) {
      const last = cur?.words?.at(-1)
      const ended = !!last && /[.?!]["')\]]?$/.test(last.w)
      const fresh = !cur || cur.speaker !== speaker || word.s - (cur.end ?? cur.start) >= SEGMENT_GAP_SEC || (ended && (cur.end ?? cur.start) - cur.start >= SEGMENT_LONG_SEC)
      if (fresh) {
        cur = { id: `s${out.length + 1}`, speaker, start: round(word.s), end: round(word.e), text: word.w, words: [word] }
        out.push(cur)
      } else {
        cur!.end = round(word.e)
        cur!.text += ` ${word.w}`
        cur!.words!.push(word)
      }
    }
    return out
  }
}

const round = (n: number): number => Number(n.toFixed(2))

/** Words and turns to segments in one go. */
export function segmentsOf(words: readonly RawWord[], turns: readonly RawTurn[]): { segments: DocSegment[]; speakers: string[] } {
  const merger = new Merger(turns)
  merger.add(words)
  return { segments: merger.segments(), speakers: merger.speakers }
}
