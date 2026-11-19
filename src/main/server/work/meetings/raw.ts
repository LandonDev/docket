/**
 * What the transcriber hands back (docs/agents/work-meetings.md, "The
 * pipeline"): words with times, speaker turns, one voice per speaker and the
 * recording's outline. pipeline.ts produces it; merge.ts turns it into the
 * meeting's segments. Nothing here names a person: a speaker is a number
 * until the owner names it.
 */

/** One recognised word, in seconds from the start of the recording. */
export interface RawWord {
  w: string
  s: number
  e: number
}

/** One stretch one speaker held, as the diarizer found it. Turns may overlap. */
export interface RawTurn {
  speaker: number
  start: number
  end: number
}

/** A speaker's voice: a unit-length embedding, by the speaker's number as a string. Never leaves the host. */
export type RawVoices = Record<string, number[]>

/** What the transcriber says while it runs, in this order: start, peaks, speakers × n, turns, words × n. */
export type PipelineEvent =
  | { event: 'start'; durationSec: number; media: 'audio' | 'video' }
  /** The outline for the waveform: `PEAKS` values from 0 to 1 across the whole recording. */
  | { event: 'peaks'; peaks: number[] }
  /** Finding who speaks: `done` of `total` steps. */
  | { event: 'speakers'; done: number; total: number }
  /** Who spoke when, once: every turn, and each speaker's voice. */
  | { event: 'turns'; turns: RawTurn[]; voices: RawVoices }
  /** The words of one more stretch; everything before `uptoSec` is now transcribed. */
  | { event: 'words'; uptoSec: number; words: RawWord[] }

/** How many values the outline has. */
export const PEAKS = 400

/** The transcriber's whole answer: what a `<media> → tcmeeting` job writes as JSON. */
export interface RawTranscript {
  durationSec: number
  media: 'audio' | 'video'
  peaks: number[]
  turns: RawTurn[]
  voices: RawVoices
  words: RawWord[]
  /** "parakeet-tdt-0.6b-v2+sherpa-onnx 2.0.1+pyannote-seg-3.0+wespeaker-resnet34-lm" */
  engine: string
  /** Seconds each part took, and the threads it ran on. */
  timings: { decodeSec: number; speakersSec: number; wordsSec: number; threads: number }
}

/** The format name of a meeting job's output, as `ctx.convert` spells formats. */
export const MEETING_FORMAT = 'tcmeeting'

/** The recordings a meeting can be made from, by extension: what ffmpeg decodes. */
export const MEDIA_EXTS = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'amr', 'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi'] as const
/** The transcript files a meeting can be made from. */
export const TRANSCRIPT_EXTS = ['vtt', 'srt', 'txt', 'docx'] as const
