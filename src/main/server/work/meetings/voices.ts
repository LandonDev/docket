import type { DatabaseSync } from 'node:sqlite'
import type { MeetingVoice } from '@shared/contract-work-meetings'

/**
 * Voices (docs/agents/work-meetings.md, "Voices"). The transcriber leaves
 * one embedding per speaker of a meeting. When the owner names a speaker,
 * that voice is kept under the name, and in a later meeting a speaker whose
 * voice is close is offered the name. It is only ever offered: nothing here
 * names anyone.
 *
 * A voice is biometric data. Both tables stay on this host: neither has a
 * `session_id` column, so a thread's move and a history import carry
 * neither, no method answers an embedding, and no tool reads one.
 */

/** How close a voice must be to a kept one to offer its name. The research measured 0.84 to 0.91 for the same person across two meetings and 0.29 at most for another. */
export const VOICE_MATCH = 0.6

export function ensureVoiceTables(db: DatabaseSync): void {
  // A meeting's speakers, as the transcriber heard them.
  db.exec(`CREATE TABLE IF NOT EXISTS work_meetings_speaker_voices (
    item_id TEXT NOT NULL, speaker_id TEXT NOT NULL, embedding BLOB NOT NULL,
    PRIMARY KEY (item_id, speaker_id))`)
  // The voices kept under a name: the mean of every speaker given that name.
  db.exec(`CREATE TABLE IF NOT EXISTS work_meetings_voices (
    name TEXT PRIMARY KEY, embedding BLOB NOT NULL, meetings INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)`)
  // Which meetings' speakers went into a name's voice, so naming one twice counts once.
  db.exec(`CREATE TABLE IF NOT EXISTS work_meetings_voice_sources (
    name TEXT NOT NULL, item_id TEXT NOT NULL, speaker_id TEXT NOT NULL,
    PRIMARY KEY (name, item_id, speaker_id))`)
}

const toBlob = (v: readonly number[]): Uint8Array => new Uint8Array(new Float32Array(v).buffer)
const fromBlob = (b: Uint8Array): number[] => [...new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))]

export function unit(v: readonly number[]): number[] {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0))
  return n ? v.map((x) => x / n) : [...v]
}
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

export class Voices {
  constructor(private readonly db: DatabaseSync) {}

  /** Keep a meeting's speakers' voices, replacing what was kept for it. */
  setMeeting(itemId: string, voices: ReadonlyMap<string, readonly number[]>): void {
    this.db.prepare(`DELETE FROM work_meetings_speaker_voices WHERE item_id = ?`).run(itemId)
    const put = this.db.prepare(`INSERT INTO work_meetings_speaker_voices (item_id, speaker_id, embedding) VALUES (?, ?, ?)`)
    for (const [speakerId, voice] of voices) if (voice.length) put.run(itemId, speakerId, toBlob(unit(voice)))
  }

  private speakerVoice(itemId: string, speakerId: string): number[] | null {
    const row = this.db.prepare(`SELECT embedding FROM work_meetings_speaker_voices WHERE item_id = ? AND speaker_id = ?`).get(itemId, speakerId) as { embedding: Uint8Array } | undefined
    return row ? fromBlob(row.embedding) : null
  }

  /**
   * The owner named a speaker: their voice joins the one kept under that
   * name (the mean, as a unit vector). A speaker the transcriber left no
   * voice for (a transcript file, too little speech) changes nothing.
   */
  remember(name: string, itemId: string, speakerId: string, now = Date.now()): void {
    const voice = this.speakerVoice(itemId, speakerId)
    if (!voice) return
    const seen = this.db.prepare(`SELECT 1 FROM work_meetings_voice_sources WHERE name = ? AND item_id = ? AND speaker_id = ?`).get(name, itemId, speakerId)
    if (seen) return
    const kept = this.db.prepare(`SELECT embedding, meetings FROM work_meetings_voices WHERE name = ?`).get(name) as { embedding: Uint8Array; meetings: number } | undefined
    const prior = kept ? fromBlob(kept.embedding) : null
    const n = kept && prior && prior.length === voice.length ? kept.meetings : 0
    const mean = n && prior ? unit(prior.map((x, i) => x * n + voice[i])) : voice
    this.db
      .prepare(`INSERT INTO work_meetings_voices (name, embedding, meetings, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET embedding = excluded.embedding, meetings = excluded.meetings, updated_at = excluded.updated_at`)
      .run(name, toBlob(mean), n + 1, now)
    this.db.prepare(`INSERT OR IGNORE INTO work_meetings_voice_sources (name, item_id, speaker_id) VALUES (?, ?, ?)`).run(name, itemId, speakerId)
  }

  /**
   * A name to offer each unnamed speaker of a meeting: the kept voice
   * nearest theirs, at `VOICE_MATCH` or closer. A name is offered to one
   * speaker at most, the nearest, and never one already used in the meeting.
   */
  suggest(itemId: string, speakers: readonly { id: string; name: string | null }[]): Map<string, string> {
    const kept = (this.db.prepare(`SELECT name, embedding FROM work_meetings_voices`).all() as unknown as { name: string; embedding: Uint8Array }[]).map((r) => ({ name: r.name, voice: fromBlob(r.embedding) }))
    const out = new Map<string, string>()
    if (kept.length === 0) return out
    const used = new Set(speakers.flatMap((s) => (s.name ? [s.name] : [])))
    const pairs: { id: string; name: string; score: number }[] = []
    for (const speaker of speakers) {
      if (speaker.name) continue
      const voice = this.speakerVoice(itemId, speaker.id)
      if (!voice) continue
      for (const k of kept) {
        if (used.has(k.name)) continue
        const score = cosine(voice, k.voice)
        if (score >= VOICE_MATCH) pairs.push({ id: speaker.id, name: k.name, score })
      }
    }
    const taken = new Set<string>()
    for (const p of pairs.sort((a, b) => b.score - a.score)) {
      if (out.has(p.id) || taken.has(p.name)) continue
      out.set(p.id, p.name)
      taken.add(p.name)
    }
    return out
  }

  list(): MeetingVoice[] {
    return (this.db.prepare(`SELECT name, meetings, updated_at FROM work_meetings_voices ORDER BY name COLLATE NOCASE`).all() as unknown as { name: string; meetings: number; updated_at: number }[]).map((r) => ({
      name: r.name,
      meetings: r.meetings,
      updatedAt: r.updated_at
    }))
  }

  /** Forget the voice kept under a name. The names on meetings stay: they are his words, not the voice. */
  forget(name: string): void {
    this.db.prepare(`DELETE FROM work_meetings_voices WHERE name = ?`).run(name)
    this.db.prepare(`DELETE FROM work_meetings_voice_sources WHERE name = ?`).run(name)
  }

  /** Deleted meetings: their speakers' voices go. What they added to a named voice stays until that name is forgotten. */
  removeMeetings(itemIds: readonly string[]): void {
    const gone = this.db.prepare(`DELETE FROM work_meetings_speaker_voices WHERE item_id = ?`)
    for (const id of itemIds) gone.run(id)
  }
}
