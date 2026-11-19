import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { displayName, parseTime, parseTranscript } from './parse'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

const TEAMS_VTT = `WEBVTT

0b5c6a4e-1d1f-4a6e-9e3a-6c1f2b7d9a01/12-0
00:00:03.120 --> 00:00:05.480
<v Landon Hale>Okay, let's get started.</v>

0b5c6a4e-1d1f-4a6e-9e3a-6c1f2b7d9a01/18-0
00:00:05.900 --> 00:00:07.400
<v Smith, Jordan>Sounds good. I'll share the budget sheet</v>

0b5c6a4e-1d1f-4a6e-9e3a-6c1f2b7d9a01/18-1
00:00:07.450 --> 00:00:09.310
<v Smith, Jordan>first &amp; then the schedule.</v>

0b5c6a4e-1d1f-4a6e-9e3a-6c1f2b7d9a01/25-0
00:00:09.500 --> 00:00:12.000
<v Landon Hale>We decided the finals move to Friday.</v>
`

const ZOOM_VTT = `WEBVTT

1
00:00:01.500 --> 00:00:04.000
Landon Hale: Okay, let's get started.

2
00:00:04.200 --> 00:00:07.950
Jordan Smith: Sounds good. I'll send the
schedule by Monday.

3
00:00:08.100 --> 00:00:09.000
we need two things: money and a room.
`

const ZOOM_TXT = `[Landon Hale] 14:02:13
Okay, let's get started.

[Jordan Smith] 14:02:16
Sounds good. I'll send the schedule by Monday.

[Landon Hale] 14:02:21
Great, thanks.
`

const SRT = `1
00:00:01,000 --> 00:00:03,500
Landon Hale: Okay, let's get started.

2
00:00:03,700 --> 00:00:06,200
- Sounds good.
- I'll send it Monday.

3
01:00:06,400 --> 01:00:08,000
[SPEAKER_01]: Great, thanks.
`

describe('parseTime', () => {
  it('reads every shape a transcript writes a time in', () => {
    expect(parseTime('00:01:02.345')).toBeCloseTo(62.345)
    expect(parseTime('00:00:03,500')).toBeCloseTo(3.5)
    expect(parseTime('1:02:09')).toBe(3729)
    expect(parseTime('0:03')).toBe(3)
    expect(() => parseTime('soon')).toThrow(/bad time/)
  })
})

describe('parseTranscript', () => {
  it('Teams .vtt: the voice tag names the speaker, entities are decoded, one speaker\'s cues become one turn', async () => {
    const { format, turns } = await parseTranscript('Staff sync.vtt', bytes(TEAMS_VTT))
    expect(format).toBe('vtt')
    expect(turns.map((t) => t.speaker)).toEqual(['Landon Hale', 'Smith, Jordan', 'Landon Hale'])
    expect(turns[1].text).toBe("Sounds good. I'll share the budget sheet first & then the schedule.")
    expect(turns[1].start).toBeCloseTo(5.9)
    expect(turns[1].end).toBeCloseTo(9.31)
  })

  it('Zoom .vtt: a name before a colon is the speaker, a colon in running speech is not', async () => {
    const { turns } = await parseTranscript('zoom.vtt', bytes(ZOOM_VTT))
    expect(turns.map((t) => t.speaker)).toEqual(['Landon Hale', 'Jordan Smith', null])
    expect(turns[1].text).toBe("Sounds good. I'll send the schedule by Monday.")
    expect(turns[2].text).toBe('we need two things: money and a room.')
  })

  it('Zoom .txt: the wall clock is made relative and each turn ends where the next starts', async () => {
    const { format, turns } = await parseTranscript('meeting_saved_closed_caption.txt', bytes(ZOOM_TXT))
    expect(format).toBe('zoom-txt')
    expect(turns.map((t) => [t.speaker, t.start, t.end])).toEqual([
      ['Landon Hale', 0, 3],
      ['Jordan Smith', 3, 8],
      ['Landon Hale', 8, null]
    ])
  })

  it('Zoom .txt: a meeting that runs past midnight keeps counting up', async () => {
    const { turns } = await parseTranscript('late.txt', bytes('[A B] 23:59:50\nOne.\n\n[C D] 00:00:10\nTwo.\n'))
    expect(turns.map((t) => t.start)).toEqual([0, 20])
  })

  it('.srt: comma times, a cue with no name stays unnamed, a bracketed label is taken', async () => {
    const { format, turns } = await parseTranscript('captions.srt', bytes(SRT))
    expect(format).toBe('srt')
    expect(turns[0].speaker).toBe('Landon Hale')
    expect(turns[1].speaker).toBeNull()
    expect(turns[1].text).toBe("- Sounds good. - I'll send it Monday.")
    expect(turns[2].speaker).toBe('SPEAKER_01')
    expect(turns[2].start).toBeCloseTo(3606.4)
  })

  it('Teams .docx: heading lines with a time, the transcription notices dropped', async () => {
    const { format, turns } = await parseTranscript('Staff sync.docx', new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'teams.docx'))))
    expect(format).toBe('teams-docx')
    expect(turns.map((t) => [t.speaker, t.start])).toEqual([
      ['Hale, Landon', 3],
      ['Smith, Jordan', 5],
      ['Hale, Landon', 3729]
    ])
    expect(turns[1].text).toContain('budget sheet first & then')
    expect(turns[2].text).toBe('We decided the finals move to Friday.')
    expect(turns[0].end).toBe(5)
  })

  it('says so in a sentence when a file holds no turns, or is not what its name says', async () => {
    await expect(parseTranscript('notes.txt', bytes('Buy milk.\nCall Sam.\n'))).rejects.toThrow('No turns were found in notes.txt')
    await expect(parseTranscript('broken.docx', bytes('not a zip'))).rejects.toThrow(/not a \.docx file/)
  })
})

describe('displayName', () => {
  it('turns the directory form around and leaves any other name alone', () => {
    expect(displayName('Hale, Landon')).toBe('Landon Hale')
    expect(displayName('Landon Hale')).toBe('Landon Hale')
    expect(displayName('SPEAKER_01')).toBe('SPEAKER_01')
    expect(displayName('Reyes, Coach (Guest)')).toBe('Reyes, Coach (Guest)')
  })
})
