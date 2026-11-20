import { describe, expect, it } from "vitest";
import type { PlayRow } from "@shared/contract-work-routines";
import type { ContextChip } from "@shared/work";
import { formOf } from "../model";
import { playFormProblem, playsFor, startersLeft, startInputs, takesLeft, takesLine, today } from "./model";

const play = (over: Partial<PlayRow> = {}): PlayRow => ({ id: "p", workspaceId: "w", name: "Game assignment", instructions: "x", takes: ["mail"], proposed: false, madeIn: null, starter: null, createdBy: "owner", createdAt: 1, updatedAt: 1, host: "box", ...over });
const mail: ContextChip = { kind: "mail", label: "Assignment", ref: { at: "lifeos", table: "mailThreads", id: "m1" } };

describe("the plays' words", () => {
  it("say what a play takes in a line", () => {
    expect(takesLine([])).toBe("Takes nothing");
    expect(takesLine(["mail"])).toBe("Takes a mail");
    expect(takesLine(["mail", "date"])).toBe("Takes a mail and a date");
    expect(takesLine(["event", "file", "text"])).toBe("Takes an event, a file and a line of text");
  });

  it("offer only the starters of the sector he has not added", () => {
    expect(startersLeft("ref", []).map((s) => s.key)).toEqual(["ref.assignment", "ref.month"]);
    expect(startersLeft("ref", [play({ starter: "ref.assignment" })]).map((s) => s.key)).toEqual(["ref.month"]);
    expect(startersLeft("ref", [play({ name: "month’s pay" })]).map((s) => s.key)).toEqual(["ref.assignment"]);
    expect(startersLeft(null, [])).toEqual([]);
  });

  it("offer a thing only the plays of his that take it", () => {
    const plays = [play({ id: "a" }), play({ id: "b", takes: ["task"] }), play({ id: "c", proposed: true })];
    expect(playsFor(plays, "mail").map((p) => p.id)).toEqual(["a"]);
    expect(playsFor(plays, "person")).toEqual([]);
  });

  it("ask a start only for what the thing it came from does not fill", () => {
    expect(takesLeft(play({ takes: ["mail", "date"] }), [mail])).toEqual(["date"]);
    expect(takesLeft(play(), [mail])).toEqual([]);
    expect(startInputs(play({ takes: ["mail", "text"] }), { chips: [mail], text: "  " })).toEqual({ problem: "Give it a line of text" });
    expect(startInputs(play({ takes: ["mail", "date"] }), { chips: [mail], date: "2026-11-20", text: "ignored" })).toEqual({ inputs: { chips: [mail], date: "2026-11-20" } });
    expect(startInputs(play(), { chips: [] })).toEqual({ problem: "Pick a mail" });
  });

  it("read today on the wall clock and refuse a form with no name or steps", () => {
    expect(today(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
    expect(playFormProblem({ name: " ", instructions: "x", takes: [] })).toBe("Give it a name");
    expect(playFormProblem({ name: "x", instructions: "", takes: [] })).toBe("Say what it does");
  });

  it("keep the play a routine runs on its form", () => {
    expect(formOf({ name: "Mondays", prompt: "", playId: "p1", trigger: { on: "lifeos", kinds: ["mail.received"] }, ends: { kind: "never" } } as never).play).toBe("p1");
  });
});
