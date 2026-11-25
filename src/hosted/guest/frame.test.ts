/**
 * The phone's frame around the owner's page (docs/agents/work-guests.md "The phone's frame"): who may ask for no
 * chrome, the closed set of messages the page takes, and what it says back, at most once a frame.
 */
import { describe, expect, it } from "vitest";
import { Frame, frameFor, frameOf, keptHash, listKindOf, nativeHandler, nearestFrom, parseIn, stepTo, type FrameState } from "./frame";

const T = "t".repeat(43);

describe("frameOf", () => {
  it("is none only for the owner's page whose address asks for it", () => {
    expect(frameOf("/w/open", `#t=${T}&chrome=none`)).toBe("none");
    expect(frameOf("/w/open/", `#chrome=none`)).toBe("none");
    expect(frameOf("/w/open", `#t=${T}`)).toBe("full");
    expect(frameOf("/w/open", `#t=${T}&chrome=full`)).toBe("full");
  });

  it("is full for a guest's link, whatever its address says", () => {
    expect(frameOf("/g/L1", `#k=${"k".repeat(43)}&chrome=none`)).toBe("full");
    expect(frameOf("/elsewhere", "#chrome=none")).toBe("full");
  });

  it("keeps the word in the address once the ticket has gone from it, and nothing for a full page", () => {
    expect(keptHash("none")).toBe("#chrome=none");
    expect(keptHash("full")).toBe("");
    expect(frameOf("/w/open", keptHash("none"))).toBe("none");
  });
});

describe("parseIn", () => {
  it("reads each message of the set", () => {
    expect(parseIn({ kind: "format", what: "bold" })).toEqual({ kind: "format", what: "bold" });
    expect(parseIn({ kind: "format", what: "italic" })).toEqual({ kind: "format", what: "italic" });
    expect(parseIn({ kind: "format", what: "style", style: "Heading 1" })).toEqual({ kind: "format", what: "style", style: "Heading 1" });
    for (const list of ["bullet", "number", "check"]) expect(parseIn({ kind: "format", what: "list", list })).toEqual({ kind: "format", what: "list", list });
    expect(parseIn({ kind: "find", what: "search", query: "budget" })).toEqual({ kind: "find", what: "search", query: "budget" });
    expect(parseIn({ kind: "find", what: "search", query: "" })).toEqual({ kind: "find", what: "search", query: "" });
    for (const what of ["next", "previous", "clear"]) expect(parseIn({ kind: "find", what })).toEqual({ kind: "find", what });
    expect(parseIn({ kind: "undo" })).toEqual({ kind: "undo" });
    expect(parseIn({ kind: "redo" })).toEqual({ kind: "redo" });
  });

  it("drops everything else unread, keeping none of a message's extra words", () => {
    const junk: unknown[] = [
      null,
      "undo",
      42,
      [],
      { kind: "eval", code: "alert(1)" },
      { kind: "format" },
      { kind: "format", what: "underline" },
      { kind: "format", what: "style" },
      { kind: "format", what: "style", style: 7 },
      { kind: "format", what: "style", style: "" },
      { kind: "format", what: "style", style: "x".repeat(81) },
      { kind: "format", what: "list", list: "roman" },
      { kind: "find", what: "search" },
      { kind: "find", what: "search", query: "q".repeat(501) },
      { kind: "find", what: "replace", query: "a" },
    ];
    for (const raw of junk) expect(parseIn(raw)).toBeNull();
    expect(parseIn({ kind: "undo", steps: 99 })).toEqual({ kind: "undo" });
  });
});

const state = (over: Partial<FrameState> = {}): FrameState => ({ editing: false, style: "Normal", styles: ["Normal", "Heading 1"], bold: false, italic: false, list: null, undo: false, redo: false, ...over });

/** A frame whose animation frames run when the test says. */
function harness() {
  const posted: unknown[] = [];
  let queued: (() => void)[] = [];
  const frame = new Frame(
    { postMessage: (m) => posted.push(m) },
    (run) => queued.push(run),
    () => (queued = []),
  );
  const tick = () => {
    const now = queued;
    queued = [];
    for (const run of now) run();
  };
  return { frame, posted, tick, queued: () => queued.length };
}

describe("Frame", () => {
  it("says drawn once, with what the page offers", () => {
    const { frame, posted } = harness();
    frame.drawn({ format: true, find: true, undo: true });
    frame.drawn({ format: false, find: false, undo: false });
    expect(posted).toEqual([{ kind: "drawn", v: 1, offers: { format: true, find: true, undo: true } }]);
  });

  it("says a state at most once a frame, the last of that frame, and only when it changed", () => {
    const { frame, posted, tick } = harness();
    frame.state(state());
    frame.state(state({ bold: true }));
    expect(posted).toEqual([]);
    tick();
    expect(posted).toEqual([{ kind: "state", ...state({ bold: true }) }]);
    frame.state(state({ bold: true }));
    tick();
    expect(posted).toHaveLength(1);
    frame.state(state({ bold: true, styles: ["Normal"] }));
    tick();
    expect(posted).toHaveLength(2);
  });

  it("answers a find with its count and the match in hand from 1", () => {
    const { frame, posted } = harness();
    frame.found("budget", 7, 2);
    expect(posted).toEqual([{ kind: "found", query: "budget", count: 7, at: 2 }]);
  });

  it("takes the app's messages through window.tcFrame.receive until its cleanup, and drops the junk", () => {
    const { frame, tick, queued } = harness();
    const win: { tcFrame?: { receive(raw: unknown): void } } = {};
    const heard: unknown[] = [];
    const stop = frame.listen(win, (m) => heard.push(m));
    win.tcFrame!.receive({ kind: "undo" });
    win.tcFrame!.receive({ kind: "eval", code: "x" });
    win.tcFrame!.receive({ kind: "find", what: "next" });
    expect(heard).toEqual([{ kind: "undo" }, { kind: "find", what: "next" }]);
    frame.state(state());
    expect(queued()).toBe(1);
    stop();
    expect(win.tcFrame).toBeUndefined();
    expect(queued()).toBe(0);
    tick();
  });

  it("keeps quiet when the app's view has gone", () => {
    const frame = new Frame({ postMessage: () => { throw new Error("gone"); } }, (run) => (run(), 0), () => {});
    expect(() => frame.drawn({ format: false, find: false, undo: false })).not.toThrow();
  });
});

describe("frameFor", () => {
  const handler = { postMessage: () => {} };
  const app = { webkit: { messageHandlers: { tcFrame: handler } } };

  it("is a bridge only with no chrome and the app's ear in the window", () => {
    expect(nativeHandler(app)).toBe(handler);
    expect(frameFor("none", app)).toBeInstanceOf(Frame);
    expect(frameFor("full", app)).toBeNull();
    expect(frameFor("none", {})).toBeNull();
    expect(frameFor("none", { webkit: { messageHandlers: {} } })).toBeNull();
  });
});

describe("find's steps", () => {
  it("comes round at either end", () => {
    expect(stepTo(3, 2, 1)).toBe(0);
    expect(stepTo(3, 0, -1)).toBe(2);
    expect(stepTo(3, -1, 1)).toBe(0);
    expect(stepTo(3, -1, -1)).toBe(2);
    expect(stepTo(0, -1, 1)).toBe(-1);
  });

  it("lands on the first match at or after the caret, else the first", () => {
    expect(nearestFrom([4, 10, 20], 11)).toBe(2);
    expect(nearestFrom([4, 10, 20], 10)).toBe(1);
    expect(nearestFrom([4, 10, 20], 30)).toBe(0);
    expect(nearestFrom([], 3)).toBe(-1);
  });

  it("names a list by the editor's line type", () => {
    expect(listKindOf("bulletListItem")).toBe("bullet");
    expect(listKindOf("numberedListItem")).toBe("number");
    expect(listKindOf("checkListItem")).toBe("check");
    expect(listKindOf("paragraph")).toBeNull();
    expect(listKindOf(null)).toBeNull();
  });
});
