import { describe, expect, it } from "vitest";
import { dueOf, findHits, markRuns, progressLine, proposedTasks, segmentAt, speakerName, stretchLabel, stretchOf, tasksByTurn, timeOf, turnOfAction, waveBars, WAVE_BARS } from "./model";
import { SAMPLE_NOTES, SAMPLE_SEGMENTS, sampleMeeting } from "./sample";

describe("the meeting canvas's model", () => {
  it("draws 100 bars from 400 peaks, each the loudest of its four; no peaks is a flat wave", () => {
    const peaks = Array.from({ length: 400 }, (_, i) => (i % 4 === 3 ? 0.9 : 0.1));
    const bars = waveBars(peaks);
    expect(bars).toHaveLength(WAVE_BARS);
    expect(new Set(bars)).toEqual(new Set([0.9]));
    expect(waveBars([])).toEqual(Array.from({ length: 100 }, () => 0));
    expect(waveBars([2, -1], 2)).toEqual([1, 0]);
  });

  it("finds the turn playing at a moment", () => {
    expect(segmentAt(SAMPLE_SEGMENTS, 0)).toBeNull();
    expect(segmentAt(SAMPLE_SEGMENTS, 15 * 60 + 2)?.id).toBe("s7");
    expect(segmentAt(SAMPLE_SEGMENTS, 15 * 60 + 10)?.id).toBe("s7");
    expect(segmentAt(SAMPLE_SEGMENTS, 99_999)?.id).toBe("s14");
  });

  it("reads times as m:ss, and h:mm:ss through a recording past an hour", () => {
    expect(timeOf(902, { durationSec: 2530 })).toBe("15:02");
    expect(timeOf(902, { durationSec: 11_058 })).toBe("0:15:02");
  });

  it("names a speaker by his name, else the label; a turn with none is Unknown", () => {
    const m = sampleMeeting();
    expect(speakerName(m.speakers, "S1")).toBe("Dana Lee");
    expect(speakerName(m.speakers, "S4")).toBe("Speaker 4");
    expect(speakerName(m.speakers, null)).toBe("Unknown");
  });

  it("puts each task under the turn it was said in, drops rejected ones, and steps through those waiting in the transcript's order", () => {
    const m = sampleMeeting({ notes: { ...SAMPLE_NOTES, actions: [...SAMPLE_NOTES.actions, { id: "a5", text: "Gone", refs: [], at: 600, state: "rejected" }] } });
    const byTurn = tasksByTurn(m);
    expect([...byTurn.keys()]).toEqual(["s2", "s11", "s14"]);
    expect(byTurn.get("s14")!.map((a) => a.id)).toEqual(["a3", "a4"]);
    expect(proposedTasks(m).map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    // A task citing no turn sits where its moment falls.
    expect(turnOfAction({ id: "x", text: "x", refs: ["nope"], at: 16 * 60 + 41, state: "proposed" }, SAMPLE_SEGMENTS)).toBe("s11");
  });

  it("finds every hit, case aside, and cuts a turn's words around them", () => {
    const hits = findHits(SAMPLE_SEGMENTS, "friday");
    expect(hits.map((h) => h.segment)).toEqual(["s1", "s2", "s5"]);
    expect(findHits(SAMPLE_SEGMENTS, "  ")).toEqual([]);
    const s2 = SAMPLE_SEGMENTS[1];
    const runs = markRuns(s2.text, hits.filter((h) => h.segment === "s2"), hits[1]);
    expect(runs.map((r) => r.hit)).toEqual(["none", "current", "none"]);
    expect(runs.map((r) => r.text).join("")).toBe(s2.text);
  });

  it("labels a stretch from its first turn's start to its last turn's end", () => {
    const span = stretchOf(SAMPLE_SEGMENTS, ["s7", "s8", "s9"])!;
    expect(span.start).toBe(902);
    expect(stretchLabel({ durationSec: 2530, title: "Staff sync, Nov 16" }, span)).toBe("15:02 to 16:02, Staff sync, Nov 16");
    expect(stretchOf(SAMPLE_SEGMENTS, [])).toBeNull();
  });

  it("says how far a transcription has come", () => {
    expect(progressLine({ durationSec: 2530, progress: { phase: "speakers", done: 3, total: 9 } })).toBe("Finding who speaks");
    expect(progressLine({ durationSec: 2530, progress: { phase: "words", done: 840, total: 2530 } })).toBe("Transcribing, 14 of 42 minutes");
    expect(progressLine({ durationSec: 42, progress: { phase: "words", done: 14, total: 42 } })).toBe("Transcribing, 0:14 of 0:42");
  });

  it("writes a due date as a weekday this week, else a short date", () => {
    const now = new Date(2026, 10, 17, 12).getTime();
    expect(dueOf("2026-11-20", now, "en-US")).toBe("Fri");
    expect(dueOf("2026-12-05", now, "en-US")).toBe("Dec 5");
    expect(dueOf(undefined, now)).toBe("");
  });
});
