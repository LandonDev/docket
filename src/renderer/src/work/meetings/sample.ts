import type { Meeting, MeetingAction, MeetingNote, MeetingSegment } from "@shared/contract-work-meetings";

/**
 * The approved prototype's meeting ("Staff sync, Nov 16", 42:10, four
 * speakers), as the host would answer it: what the preview pages draw and the
 * DOM test drives. Not shipped to anyone's screen.
 */

const T = (m: number, s: number): number => m * 60 + s;
const SAID: [number, string, string][] = [
  [T(10, 52), "S1", "On nationals: I need the final number by Friday, or it misses this quarter's request."],
  [T(11, 20), "S2", "I'll send it Friday. Flights and hotel are in; I'm waiting on the registration fee."],
  [T(11, 48), "S3", "Registration is $150 a player. I'll forward the email."],
  [T(12, 30), "S1", "Then keep contingency at 8% and we're fine."],
  [T(14, 30), "S2", "Next is the spring LAN. Events booking held the ballroom for April 10, and they want the form back by Friday."],
  [T(14, 52), "S3", "Do we know the power? Last year we tripped a breaker at noon."],
  [T(15, 2), "S2", "The contract lists a 200 amp drop at the stage wall. I'll ask if that carries 24 stations."],
  [T(15, 20), "S1", "If the room costs more than the venue line, tell me before the nationals budget goes in."],
  [T(15, 41), "S2", "It's $2,400 with the RecWell discount, so it's inside the line."],
  [T(16, 3), "S4", "Varsity can run the stage bracket if it starts after 1:00 PM."],
  [T(16, 40), "S2", "Then let's book it. I'll send the form today."],
  [T(17, 10), "S3", "For staff, I want everyone there at 7:00 for setup."],
  [T(17, 32), "S2", "Setup is 7:30 in the run of show. Doors can't open before 9."],
  [T(17, 55), "S3", "Then I'll send the staff call time once the bracket is set."],
];

export const SAMPLE_SEGMENTS: MeetingSegment[] = SAID.map(([start, speaker, text], i) => ({ id: `s${i + 1}`, speaker, start, end: (SAID[i + 1]?.[0] ?? start + 20) - 0.5, text }));

/** A wave with a meeting's shape: speech with pauses, louder in places. */
export const SAMPLE_PEAKS: number[] = Array.from({ length: 400 }, (_, i) => Math.min(1, Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.37) + Math.sin(i * 0.11) * 0.4) * 0.8 + 0.08));

const note = (id: string, text: string, at: number, ref: string): MeetingNote => ({ id, text, refs: [ref], at });
const action = (id: string, text: string, at: number, ref: string, over: Partial<MeetingAction> = {}): MeetingAction => ({ ...note(id, text, at, ref), state: "proposed", ...over });

export const SAMPLE_NOTES: NonNullable<Meeting["notes"]> = {
  summary: [],
  decisions: [
    note("d1", "Keep contingency on the nationals budget at 8%", T(12, 30), "s4"),
    note("d2", "The LAN is in the ballroom on April 10, $2,400 with the RecWell discount", T(15, 41), "s9"),
    note("d3", "Varsity runs the stage bracket from 1:00 PM", T(16, 3), "s10"),
    note("d4", "Staff arrive at 7:30 for setup", T(17, 32), "s13"),
  ],
  questions: [note("q1", "Can the 200 amp drop carry 24 stations?", T(15, 2), "s7")],
  actions: [
    action("a1", "Send Dana the nationals budget", T(11, 20), "s2", { due: "2026-11-20" }),
    action("a2", "Book the ballroom", T(16, 40), "s11"),
    action("a3", "Sam sends the staff call time", T(17, 55), "s14"),
    action("a4", "Order badge printer ribbon", T(17, 55), "s14", { state: "filed", lifeosTaskId: "k77" }),
  ],
  writtenAt: new Date(2026, 10, 16, 10, 52).getTime(),
  canUndo: true,
};

export function sampleMeeting(over: Partial<Meeting> = {}): Meeting {
  return {
    itemId: "m1",
    sessionId: "t1",
    title: "Staff sync, Nov 16",
    status: "ready",
    rev: 4,
    from: "recording",
    durationSec: T(42, 10),
    media: { kind: "audio", host: "local", audio: { path: "/data/attachments/t1/Staff-sync.m1.meeting.m4a", bytes: 3_600_000 } },
    peaks: SAMPLE_PEAKS,
    speakers: [
      { id: "S1", label: "Speaker 1", name: "Dana Lee" },
      { id: "S2", label: "Speaker 2", name: "Landon" },
      { id: "S3", label: "Speaker 3", name: "Sam Ortiz" },
      { id: "S4", label: "Speaker 4", name: null, suggested: "Coach Reyes" },
    ],
    segments: SAMPLE_SEGMENTS,
    notes: null,
    transcribedAt: new Date(2026, 10, 16, 10, 50).getTime(),
    ...over,
  };
}
