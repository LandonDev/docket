/**
 * Transcript files as meetings: Teams .vtt and .docx, Zoom .vtt and .txt,
 * and .srt (docs/agents/work-meetings.md, "Transcript files"). A file's
 * turns come out as the file wrote them: its speaker names, its times. No
 * dependency: the .docx is read with a small zip reader.
 */

/** One turn as a file gives it. */
export interface ParsedTurn {
  /** as written in the file; null when the file names none */
  speaker: string | null
  /** seconds from the start of the recording */
  start: number
  /** null when the format gives only a start (Zoom .txt, Teams .docx) */
  end: number | null
  text: string
}

export type TranscriptFormat = 'vtt' | 'srt' | 'zoom-txt' | 'teams-docx'
export interface ParsedTranscript {
  format: TranscriptFormat
  turns: ParsedTurn[]
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')

/** `00:01:02.345`, `01:02.345`, `00:01:02,345` (srt), `1:02:09` or `0:03` (docx, txt), in seconds. */
export function parseTime(t: string): number {
  const parts = t.trim().replace(',', '.').split(':').map(Number)
  if (parts.length === 0 || parts.length > 3 || parts.some(Number.isNaN)) throw new Error(`bad time ${t}`)
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

/**
 * `Name: text` at the start of a cue. Only a short, name-like prefix counts,
 * so "we need two things: money" in running speech is not taken for a
 * speaker: a name starts with a capital and holds no sentence.
 */
const SPEAKER_PREFIX = /^\s*(\[?[A-Z][\w.'’\- ,]{0,40}?\]?|\[?SPEAKER_\d+\]?|Speaker \d+):\s+/

function splitSpeaker(text: string): { speaker: string | null; text: string } {
  const m = text.match(SPEAKER_PREFIX)
  if (!m) return { speaker: null, text }
  return { speaker: m[1].replace(/^\[|\]$/g, '').trim(), text: text.slice(m[0].length) }
}

const TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/m

/** WebVTT and SRT share a cue: an optional id line, a timing line, then the text. */
function parseCues(src: string): ParsedTurn[] {
  const out: ParsedTurn[] = []
  const blocks = src
    .replace(/\r\n?/g, '\n')
    .replace(/^﻿/, '')
    .split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n')
    const ti = lines.findIndex((l) => TIMING.test(l))
    if (ti < 0) continue // WEBVTT header, NOTE, STYLE
    const [, a, b] = lines[ti].match(TIMING)!
    let raw = lines
      .slice(ti + 1)
      .join('\n')
      .trim()
    if (!raw) continue
    let speaker: string | null = null
    // Teams: <v Speaker Name>text</v>. A cue may hold several voices; the first names it.
    const voice = raw.match(/<v(?:\.[\w.-]+)?\s+([^>]+)>/)
    if (voice) speaker = decodeEntities(voice[1]).trim()
    raw = decodeEntities(raw.replace(/<[^>]+>/g, '')) // <v>, <c>, <i>, inline timestamps
    let text = raw.replace(/\s*\n\s*/g, ' ').trim()
    if (!speaker) ({ speaker, text } = splitSpeaker(text))
    if (!text) continue
    out.push({ speaker, start: parseTime(a), end: parseTime(b), text })
  }
  return mergeRuns(out)
}

/**
 * Zoom's saved transcript: `[Name] 14:02:13`, then the text. Its times are
 * the wall clock, so they are made relative to the first entry. The older
 * one-line shape `00:00:05 Name: text` is taken too.
 */
function parseZoomTxt(src: string): ParsedTurn[] {
  const out: ParsedTurn[] = []
  let cur: ParsedTurn | null = null
  for (const line of src.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split('\n')) {
    const head = line.match(/^\[(.+?)\]\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/)
    const one = line.match(/^(\d{1,2}:\d{2}:\d{2})\s+(.+?):\s+(.*)$/)
    if (head) {
      cur = { speaker: head[1].trim(), start: parseTime(head[2]), end: null, text: '' }
      out.push(cur)
    } else if (one) {
      cur = { speaker: one[2].trim(), start: parseTime(one[1]), end: null, text: one[3].trim() }
      out.push(cur)
    } else if (cur && line.trim()) {
      cur.text = (cur.text ? `${cur.text} ` : '') + line.trim()
    }
  }
  const t0 = out[0]?.start ?? 0
  // A meeting that runs past midnight wraps the wall clock: a time before the one above it is the next day's.
  let day = 0
  let last = t0
  for (const turn of out) {
    if (turn.start + day < last - 12 * 3600) day += 24 * 3600
    last = turn.start + day
    turn.start = last - t0
  }
  return fillEnds(out.filter((turn) => turn.text))
}

/**
 * Teams' downloaded .docx: a paragraph `Surname, Given   1:02:09`, then the
 * text. The "started transcription" and "stopped transcription" lines are
 * dropped.
 */
async function parseTeamsDocx(bytes: Uint8Array): Promise<ParsedTurn[]> {
  const xml = new TextDecoder().decode(await unzipEntry(bytes, 'word/document.xml'))
  const paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) =>
    decodeEntities(
      [...m[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((t) => (t[1] === undefined ? '\t' : t[1])).join('')
    ).trim()
  )
  const out: ParsedTurn[] = []
  let cur: ParsedTurn | null = null
  for (const p of paras) {
    const head = p.match(/^(.+?)[\s\t]{2,}(\d{1,2}(?::\d{2}){1,2})$/)
    if (head) {
      cur = { speaker: head[1].trim(), start: parseTime(head[2]), end: null, text: '' }
      out.push(cur)
    } else if (cur && p && !/ (started|stopped) transcription$/.test(p)) {
      cur.text = (cur.text ? `${cur.text} ` : '') + p
    }
  }
  return fillEnds(out.filter((turn) => turn.text))
}

/** Cues one speaker said less than `gap` seconds apart are one turn: Teams cuts a turn into cues of 2 to 5 seconds. */
function mergeRuns(turns: ParsedTurn[], gap = 1.0): ParsedTurn[] {
  const out: ParsedTurn[] = []
  for (const turn of turns) {
    const prev = out.at(-1)
    if (prev && turn.speaker && prev.speaker === turn.speaker && prev.end !== null && turn.start - prev.end <= gap) {
      prev.text += ` ${turn.text}`
      prev.end = turn.end
    } else out.push({ ...turn })
  }
  return out
}

/** A turn with no end runs to the next turn's start. */
function fillEnds(turns: ParsedTurn[]): ParsedTurn[] {
  return turns.map((turn, i) => ({ ...turn, end: turn.end ?? turns[i + 1]?.start ?? null }))
}

/** One file out of a zip: the central directory is read for its entry, which is inflated. */
async function unzipEntry(buf: Uint8Array, name: string): Promise<Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = buf.length - 22
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('not a .docx file')
  let p = dv.getUint32(eocd + 16, true)
  const count = dv.getUint16(eocd + 10, true)
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nlen = dv.getUint16(p + 28, true)
    const xlen = dv.getUint16(p + 30, true)
    const clen = dv.getUint16(p + 32, true)
    const local = dv.getUint32(p + 42, true)
    if (new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen)) === name) {
      const lnlen = dv.getUint16(local + 26, true)
      const lxlen = dv.getUint16(local + 28, true)
      const data = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize)
      if (method === 0) return data
      if (method !== 8) throw new Error('not a .docx file')
      const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      return new Uint8Array(await new Response(stream).arrayBuffer())
    }
    p += 46 + nlen + xlen + clen
  }
  throw new Error('not a Word transcript')
}

/** A transcript file's turns, by the file's extension and what it holds. Throws a sentence a person can read when it finds none. */
export async function parseTranscript(fileName: string, bytes: Uint8Array): Promise<ParsedTranscript> {
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  let format: TranscriptFormat
  let turns: ParsedTurn[]
  if (ext === 'docx') {
    format = 'teams-docx'
    turns = await parseTeamsDocx(bytes)
  } else {
    const text = new TextDecoder().decode(bytes)
    if (ext === 'vtt' || ext === 'srt' || TIMING.test(text)) {
      format = ext === 'srt' ? 'srt' : 'vtt'
      turns = parseCues(text)
    } else {
      format = 'zoom-txt'
      turns = parseZoomTxt(text)
    }
  }
  if (turns.length === 0) throw new Error(`No turns were found in ${fileName}. A transcript is a Teams or Zoom export, or an .srt file.`)
  return { format, turns }
}

/** `Hale, Landon` as Teams writes a name becomes `Landon Hale`; anything else stays as written. */
export function displayName(name: string): string {
  const m = name.match(/^([^,()]+),\s*([^,()]+)$/)
  return m ? `${m[2].trim()} ${m[1].trim()}` : name.trim()
}
