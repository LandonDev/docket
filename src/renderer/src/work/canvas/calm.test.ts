import { describe, expect, it } from "vitest";
import { PAUSE_MS, savingNow, SEND_SHOWN_MS, stageNow } from "./calm";
import { wordLine } from "../files/wordSave";

/** The save line's one rule (calm.ts): Saving… past a send's 600 ms or past the editor's pause, else the last Saved line. */

const T = 1_800_000_000_000;

describe("when the save line says Saving…", () => {
  it("never while nothing waits or is on its way", () => {
    expect(savingNow({ edited: null, pause: PAUSE_MS.text, sent: null }, T)).toEqual({ saving: false, again: null });
  });

  it("not while his edits wait inside the editor's own pause, and once they have waited past it with nothing sent", () => {
    for (const pause of Object.values(PAUSE_MS)) {
      expect(savingNow({ edited: T, pause, sent: null }, T + pause - 1)).toEqual({ saving: false, again: 1 });
      expect(savingNow({ edited: T, pause, sent: null }, T + pause).saving).toBe(true);
    }
    expect(PAUSE_MS).toEqual({ text: 700, deck: 2000, document: 2000, word: 3000 });
  });

  it("not while a send has been out under 600 ms, and once it has been out that long", () => {
    expect(savingNow({ edited: null, pause: PAUSE_MS.text, sent: T }, T + SEND_SHOWN_MS - 1)).toEqual({ saving: false, again: 1 });
    expect(savingNow({ edited: null, pause: PAUSE_MS.text, sent: T }, T + SEND_SHOWN_MS)).toEqual({ saving: true, again: null });
    expect(SEND_SHOWN_MS).toBe(600);
  });

  it("judges edits waiting behind a send by that send: they go when it answers", () => {
    // Typed 2 s ago behind a send out 100 ms: the send decides.
    expect(savingNow({ edited: T - 2000, pause: PAUSE_MS.text, sent: T - 100 }, T)).toEqual({ saving: false, again: 500 });
  });

  it("shows a stage the frame says itself (OneDrive uploading, a copy's send) only once it has lasted 600 ms", () => {
    expect(stageNow(null, T)).toEqual({ shown: false, again: null });
    expect(stageNow(T, T + 599)).toEqual({ shown: false, again: 1 });
    expect(stageNow(T, T + 600)).toEqual({ shown: true, again: null });
  });
});

describe("a Word file's line", () => {
  const at = new Date(2026, 10, 25, 21, 12).getTime();
  it("states its file on first open, never Saving with nothing typed", () => {
    expect(wordLine({ since: true, auto: true }, "Teams", "the Windows VM", at, false)).toEqual({ state: "copy", words: "The Word file in Teams has not changed" });
  });
  it("keeps its last save inside Word's pause, says Saving… past it, and keeps the computer's name", () => {
    expect(wordLine({ since: true, auto: true, at }, "Teams", "the Windows VM", at, false)).toEqual({ state: "saved", words: "Saved to the Windows VM 9:12 PM" });
    expect(wordLine({ since: true, auto: true, at }, "Teams", "the Windows VM", at, true)).toEqual({ state: "saving", words: "Saving to the Windows VM…" });
    expect(wordLine({ since: false, auto: true, at }, "Teams", "the Windows VM", at, true)).toEqual({ state: "saved", words: "Saved to the Windows VM 9:12 PM" });
  });
  it("says a refusal or a stop at once, whatever the pause", () => {
    expect(wordLine({ since: true, auto: true, at, refused: "the share is read only" }, "Teams", "the Windows VM", at, false).state).toBe("conflict");
    expect(wordLine({ since: true, auto: true, at, stopped: at }, "Teams", "the Windows VM", at, false).state).toBe("conflict");
  });
});
