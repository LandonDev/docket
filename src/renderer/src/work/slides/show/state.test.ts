import { describe, expect, it } from "vitest";
import { autoAfter, keyAct, motionBetween, nextPress, NOTES_DEFAULT, NOTES_SIZES, placeText, showReducer, startShowState, stepNotes, type ShowAct, type ShowState, type Slide } from "./state";
import { clockOf, elapsedOf, overTarget, pauseTimer, restartTimer, resumeTimer, startTimer } from "./timer";

const slide = (n: number, over: Partial<Slide> = {}): Slide => ({ id: 255 + n, number: n, page: n, title: `Slide ${n}`, notes: "", hidden: false, ...over });
const deck = (count: number, over: Record<number, Partial<Slide>> = {}): Slide[] => Array.from({ length: count }, (_, i) => slide(i + 1, over[i + 1]));
const run = (state: ShowState, ...acts: ShowAct[]): ShowState => acts.reduce(showReducer, state);
const at = (state: ShowState): number => state.slides[state.at].number;
const k = (key: string, over: Partial<Parameters<typeof keyAct>[0]> = {}): Parameters<typeof keyAct>[0] => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...over });
const press = (state: ShowState, ...keys: string[]): ShowState =>
  keys.reduce((s, key) => {
    const act = keyAct(k(key), s);
    return act && act.t !== "notes" && act.t !== "swallow" ? showReducer(s, act) : s;
  }, state);

describe("a show's state", () => {
  it("starts on the first slide a press would reach, or on the slide he is on, hidden or not", () => {
    expect(at(startShowState(deck(4), "start"))).toBe(1);
    expect(at(startShowState(deck(4, { 1: { hidden: true } }), "start"))).toBe(2);
    expect(at(startShowState(deck(4, { 3: { hidden: true } }), 258))).toBe(3);
    // a slide that is not in the file (an agent's waiting add): the start
    expect(at(startShowState(deck(4), 9999))).toBe(1);
  });

  it("Next and Previous pass hidden slides; after the last comes the end, and one more press closes", () => {
    let s = startShowState(deck(4, { 2: { hidden: true } }), "start");
    s = run(s, { t: "next" });
    expect(at(s)).toBe(3);
    s = run(s, { t: "prev" });
    expect(at(s)).toBe(1);
    // Previous on the first slide stays there
    expect(at(run(s, { t: "prev" }))).toBe(1);
    s = run(s, { t: "next" }, { t: "next" });
    expect(at(s)).toBe(4);
    s = run(s, { t: "next" });
    expect(s).toMatchObject({ ended: true, closed: false });
    expect(nextPress(s)).toEqual({ kind: "close" });
    // back from the end is the last slide again
    expect(run(s, { t: "prev" })).toMatchObject({ ended: false, at: 3 });
    expect(run(s, { t: "next" }).closed).toBe(true);
  });

  it("a slide's builds come first, one a press, and Previous undoes them before it leaves the slide", () => {
    let s = startShowState(deck(3, { 2: { builds: 2 } }), "start");
    s = run(s, { t: "next" });
    expect([at(s), s.step]).toEqual([2, 0]);
    expect(nextPress(s)).toEqual({ kind: "build", at: 1, step: 1, of: 2 });
    s = run(s, { t: "next" }, { t: "next" });
    expect([at(s), s.step]).toEqual([2, 2]);
    expect(nextPress(s)).toEqual({ kind: "slide", at: 2 });
    s = run(s, { t: "next" });
    expect([at(s), s.step]).toEqual([3, 0]);
    // back onto a slide with builds shows it whole, then undoes one build a press
    s = run(s, { t: "prev" });
    expect([at(s), s.step]).toEqual([2, 2]);
    s = run(s, { t: "prev" });
    expect([at(s), s.step]).toEqual([2, 1]);
    expect(nextPress(run(s, { t: "last" }))).toEqual({ kind: "end" });
  });

  it("a number then Return jumps to that slide, a hidden one too; a number past the deck is the last slide", () => {
    let s = startShowState(deck(12, { 7: { hidden: true } }), "start");
    s = press(s, "7", "Enter");
    expect(at(s)).toBe(7);
    s = press(s, "1", "2", "Enter");
    expect(at(s)).toBe(12);
    expect(at(press(s, "9", "9", "Enter"))).toBe(12);
    expect(at(press(s, "0", "Enter"))).toBe(1);
    // Return with no number is a next press, and any other key drops the number typed
    s = press(startShowState(deck(12), "start"), "5", "ArrowRight", "Enter");
    expect(at(s)).toBe(3);
  });

  it("blank hides the slide; B or a full stop brings it back, and so does a next or a previous press, which then does nothing more", () => {
    let s = run(startShowState(deck(3), "start"), { t: "next" });
    s = press(s, "b");
    expect(s.blank).toBe(true);
    expect(press(s, ".").blank).toBe(false);
    for (const key of ["ArrowRight", "ArrowLeft", " ", "PageUp"]) expect(press(s, key)).toMatchObject({ blank: false, at: 1 });
    // a jump shows the slide it lands on
    expect(press(s, "3", "Enter")).toMatchObject({ blank: false, at: 2 });
  });

  it("Home and End go to the first and the last slide a press would reach", () => {
    const s = run(startShowState(deck(5, { 1: { hidden: true }, 5: { hidden: true } }), 258));
    expect(at(press(s, "Home"))).toBe(2);
    expect(at(press(s, "End"))).toBe(4);
  });

  it("Escape closes the picker first, then the show; End show closes at once", () => {
    let s = press(startShowState(deck(3), "start"), "g");
    expect(s.picker).toBe(true);
    s = press(s, "Escape");
    expect(s).toMatchObject({ picker: false, closed: false });
    expect(press(s, "Escape").closed).toBe(true);
    expect(run(s, { t: "end" }).closed).toBe(true);
    // a closed show takes no more
    expect(run(s, { t: "end" }, { t: "prev" }, { t: "goto", number: 2 })).toMatchObject({ closed: true, at: 0 });
  });

  it("keeps the place by the slide's id when the file changes under the show", () => {
    let s = run(startShowState(deck(4), "start"), { t: "goto", number: 3 });
    // a slide was added before it: the same slide is still shown
    const added = [slide(1), slide(9, { id: 999, number: 2 }), slide(2, { number: 3 }), slide(3, { number: 4 }), slide(4, { number: 5 })];
    s = run(s, { t: "deck", slides: added });
    expect([s.slides[s.at].id, s.slides[s.at].number]).toEqual([258, 4]);
    // its slide was removed: the slide now in its place
    s = run(s, { t: "deck", slides: deck(2) });
    expect(at(s)).toBe(2);
    expect(placeText(s)).toBe("2 / 2");
    // the slide in its place is hidden: the next the room would reach, else the one before
    s = run(run(startShowState(deck(4), "start"), { t: "goto", number: 2 }), { t: "deck", slides: [slide(1), slide(3, { number: 2, hidden: true }), slide(4, { number: 3 })] });
    expect(s.slides[s.at].id).toBe(259);
    s = run(run(startShowState(deck(3), "start"), { t: "goto", number: 3 }), { t: "deck", slides: [slide(1), slide(2, { hidden: true })] });
    expect(s.slides[s.at].id).toBe(256);
  });

  it("a deck whose every slide is hidden starts on its first slide, and a press ends it", () => {
    const s = startShowState(deck(2, { 1: { hidden: true }, 2: { hidden: true } }), "start");
    expect(at(s)).toBe(1);
    expect(run(s, { t: "next" }).ended).toBe(true);
  });

  it("an empty deck ends at the first press", () => {
    const s = startShowState([], "start");
    expect(s.ended).toBe(false);
    expect(run(s, { t: "next" }).ended).toBe(true);
    expect(placeText(s)).toBe("");
  });
});

describe("a show's keys", () => {
  const idle = { picker: false };
  it("takes every key a clicker sends", () => {
    expect(keyAct(k("PageDown"), idle)).toEqual({ t: "next" });
    expect(keyAct(k("PageUp"), idle)).toEqual({ t: "prev" });
    expect(keyAct(k("b"), idle)).toEqual({ t: "blank" });
    expect(keyAct(k("."), idle)).toEqual({ t: "blank" });
    expect(keyAct(k("Escape"), idle)).toEqual({ t: "escape" });
    // F5 is taken and does nothing: a browser would reload on it
    expect(keyAct(k("F5"), idle)).toEqual({ t: "swallow" });
  });

  it("maps the table's keys, capitals too", () => {
    for (const key of ["ArrowRight", "ArrowDown", " ", "PageDown", "n", "N"]) expect(keyAct(k(key), idle), key).toEqual({ t: "next" });
    for (const key of ["ArrowLeft", "ArrowUp", "PageUp", "p", "P", "Backspace"]) expect(keyAct(k(key), idle), key).toEqual({ t: "prev" });
    expect(keyAct(k("Enter"), idle)).toEqual({ t: "enter" });
    expect(keyAct(k("Home"), idle)).toEqual({ t: "first" });
    expect(keyAct(k("End"), idle)).toEqual({ t: "last" });
    expect(keyAct(k("G"), idle)).toEqual({ t: "picker" });
    expect(keyAct(k("B"), idle)).toEqual({ t: "blank" });
    expect(keyAct(k("4"), idle)).toEqual({ t: "digit", digit: "4" });
    expect(keyAct(k("+"), idle)).toEqual({ t: "notes", by: 1 });
    expect(keyAct(k("="), idle)).toEqual({ t: "notes", by: 1 });
    expect(keyAct(k("-"), idle)).toEqual({ t: "notes", by: -1 });
    expect(keyAct(k("x"), idle)).toBeNull();
  });

  it("leaves a key held with ⌘, Ctrl or Alt to the window", () => {
    expect(keyAct(k("ArrowRight", { metaKey: true }), idle)).toBeNull();
    expect(keyAct(k("w", { ctrlKey: true }), idle)).toBeNull();
    expect(keyAct(k("Enter", { altKey: true }), idle)).toBeNull();
  });

  it("while the picker is open the arrows and Return are the picker's; Escape and G still close it", () => {
    const picking = { picker: true };
    for (const key of ["ArrowRight", "ArrowLeft", "Enter", " ", "Home", "5", "b"]) expect(keyAct(k(key), picking), key).toBeNull();
    expect(keyAct(k("Escape"), picking)).toEqual({ t: "escape" });
    expect(keyAct(k("g"), picking)).toEqual({ t: "picker" });
  });

  it("steps the notes' size from 14 to 28px and stops at each end", () => {
    expect(NOTES_SIZES.map(([size]) => size)).toEqual([14, 16, 18, 20, 24, 28]);
    expect(NOTES_SIZES[NOTES_DEFAULT][0]).toBe(20);
    expect(stepNotes(0, -1)).toBe(0);
    expect(stepNotes(5, 1)).toBe(5);
    expect(stepNotes(3, 1)).toBe(4);
  });
});

describe("a show's timer", () => {
  it("counts from the start, less the time it stood paused", () => {
    let t = startTimer(1000);
    expect(elapsedOf(t, 61_000)).toBe(60_000);
    t = pauseTimer(t, 61_000);
    expect(elapsedOf(t, 100_000)).toBe(60_000);
    // a second pause while paused changes nothing
    expect(pauseTimer(t, 90_000)).toBe(t);
    t = resumeTimer(t, 121_000);
    expect(elapsedOf(t, 131_000)).toBe(70_000);
    expect(resumeTimer(t, 140_000)).toBe(t);
  });

  it("restarts from zero and keeps whether it was paused", () => {
    expect(elapsedOf(restartTimer(startTimer(0), 5000), 8000)).toBe(3000);
    const paused = restartTimer(pauseTimer(startTimer(0), 4000), 5000);
    expect(paused.pausedAt).toBe(5000);
    expect(elapsedOf(paused, 9000)).toBe(0);
  });

  it("reads as minutes and seconds, with hours once there is one", () => {
    expect(clockOf(0)).toBe("0:00");
    expect(clockOf(247_000)).toBe("4:07");
    expect(clockOf(3_723_000)).toBe("1:02:03");
  });

  it("says when he is past the target he set, and never with none", () => {
    expect(overTarget(20 * 60_000, 20)).toBe(false);
    expect(overTarget(20 * 60_000 + 1, 20)).toBe(true);
    expect(overTarget(99 * 60_000, null)).toBe(false);
  });
});

describe("a show's steps, its transitions and its own clock", () => {
  const step = (hides: number[] = []) => ({ hides });
  // Slide 2 has three steps from the host (two presses); slide 3 comes by a push and moves on by itself after 5 s.
  const slides = (): Slide[] =>
    deck(4, {
      2: { steps: [step([4, 5]), step([5]), step()] },
      3: { transition: { kind: "push", dir: "u", ms: 750, after: 5000 } },
      4: { transition: { kind: "wipe", ms: 500 } },
    });

  it("takes one press a step the host read, before the next slide", () => {
    let s = run(startShowState(slides(), "start"), { t: "next" });
    expect([at(s), s.step]).toEqual([2, 0]);
    expect(nextPress(s)).toEqual({ kind: "build", at: 1, step: 1, of: 2 });
    s = run(s, { t: "next" }, { t: "next" });
    expect([at(s), s.step]).toEqual([2, 2]);
    s = run(s, { t: "next" });
    expect([at(s), s.step]).toEqual([3, 0]);
    // back onto a slide with steps lands on its last
    s = run(s, { t: "prev" });
    expect([at(s), s.step]).toEqual([2, 2]);
    // a slide of one step from the host takes one press
    expect(nextPress(startShowState(deck(2, { 1: { steps: [step()] } }), "start"))).toEqual({ kind: "slide", at: 1 });
  });

  it("moves on by itself after the slide's time, at each place, unless the screen is black, the picker is open or the show moved", () => {
    const s = run(startShowState(slides(), "start"), { t: "goto", number: 3 });
    expect(autoAfter(s)).toBe(5000);
    expect(autoAfter(run(s, { t: "blank" }))).toBeNull();
    expect(autoAfter(run(s, { t: "picker" }))).toBeNull();
    expect(autoAfter(run(s, { t: "next" }))).toBeNull();
    expect(at(run(s, { t: "auto", at: 2, step: 0 }))).toBe(4);
    // the clock ran out for a place the show has left: nothing
    expect(at(run(s, { t: "prev" }, { t: "auto", at: 2, step: 0 }))).toBe(2);
    expect(run(s, { t: "blank" }, { t: "auto", at: 2, step: 0 }).blank).toBe(true);
  });

  it("fades a step either way, plays a slide's fade or push on a press on, and cuts everything else", () => {
    const start = startShowState(slides(), "start");
    const two = run(start, { t: "next" });
    expect(motionBetween(start, two, false)).toBeNull();
    const built = run(two, { t: "next" });
    expect(motionBetween(two, built, false)).toEqual({ kind: "step" });
    expect(motionBetween(built, run(built, { t: "prev" }), false)).toEqual({ kind: "step" });
    const last = run(built, { t: "next" });
    const three = run(last, { t: "next" });
    expect(motionBetween(last, three, false)).toEqual({ kind: "push", dir: "u" });
    // a push under reduced motion is a fade
    expect(motionBetween(last, three, true)).toEqual({ kind: "fade" });
    // pressed on before the builds are done is no move to the next slide; a jump and a step back cut
    expect(motionBetween(two, run(two, { t: "goto", number: 3 }), false)).toBeNull();
    expect(motionBetween(three, run(three, { t: "prev" }), false)).toBeNull();
    // a wipe is a cut; so is a fade into a black screen
    expect(motionBetween(three, run(three, { t: "next" }), false)).toBeNull();
    expect(motionBetween(three, run(three, { t: "blank" }), false)).toBeNull();
    const fading = startShowState(deck(2, { 2: { transition: { kind: "fade", ms: 700 } } }), "start");
    expect(motionBetween(fading, run(fading, { t: "next" }), false)).toEqual({ kind: "fade" });
  });
});
