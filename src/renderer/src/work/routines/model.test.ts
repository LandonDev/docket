import { describe, expect, it } from "vitest";
import type { RoutineRow } from "@shared/contract-work-routines";
import { blankForm, endsOf, formOf, rowLine, rowMark, runWords, saveParamsOf, triggerOf } from "./model";

const NOW = new Date(2026, 10, 16, 9, 0).getTime(); // Monday

const row = (over: Partial<RoutineRow> = {}): RoutineRow => ({
  id: "r1",
  workspaceId: "ws",
  projectId: null,
  kind: "routine",
  name: "Morning sweep",
  prompt: "Read Purdue mail.",
  model: null,
  reasoning: null,
  trigger: { on: "schedule", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=0", tz: "America/New_York" },
  words: "Weekdays at 7:00 AM",
  ends: { kind: "never" },
  enabled: true,
  proposed: false,
  resumeSessionId: null,
  madeIn: null,
  nextAt: new Date(2026, 10, 17, 7, 0).getTime(),
  lastAt: null,
  lastState: null,
  lastWords: null,
  checkedAt: null,
  waiting: null,
  running: false,
  ended: false,
  createdBy: "owner",
  createdAt: NOW,
  host: "env_box",
  ...over,
});

describe("a routine's row", () => {
  it("says its trigger in words, then when, and shows a mark only for a state", () => {
    expect(rowLine(row(), NOW)).toBe("Weekdays at 7:00 AM, next tomorrow");
    expect(rowLine(row({ enabled: false }), NOW)).toBe("Weekdays at 7:00 AM, paused");
    expect(rowLine(row({ proposed: true, enabled: false }), NOW)).toBe("Weekdays at 7:00 AM, proposed");
    expect(rowLine(row({ waiting: "Waiting on LifeOS" }), NOW)).toBe("Weekdays at 7:00 AM, waiting on LifeOS");
    expect(rowLine(row({ words: "Every 10 minutes", ends: { kind: "once" } }), NOW)).toBe("Every 10 minutes, once");
    expect(rowMark(row())).toBeNull();
    expect(rowMark(row({ running: true }))).toBe("working");
    expect(rowMark(row({ enabled: false }))).toBe("paused");
    expect(rowMark(row({ lastState: "failed" }))).toBe("failed");
    expect(rowMark(row({ ends: { kind: "once" } }))).toBe("watching");
    expect(rowMark(row({ proposed: true, enabled: false }))).toBeNull();
  });

  it("a run's words say how many firings it covers", () => {
    expect(runWords({ id: "x", routineId: "r1", sessionId: "t", firedAt: NOW, cause: "", folded: 2, state: "quiet", summary: "Nothing held" })).toBe("Nothing held, covers 3");
    expect(runWords({ id: "x", routineId: "r1", sessionId: "t", firedAt: NOW, cause: "", folded: 0, state: "running", summary: "" })).toBe("Running");
  });
});

describe("the form", () => {
  it("round-trips a weekday schedule and makes a watch from an end", () => {
    const f = formOf(row(), NOW);
    expect(f).toMatchObject({ starts: "sched", days: "weekdays", at: "07:00", ends: "never" });
    expect(triggerOf(f, "env_box", "America/New_York")).toEqual(row().trigger);
    expect(endsOf({ ...f, ends: "once" })).toEqual({ kind: "once" });
    expect(endsOf({ ...f, ends: "day", until: "2026-11-24" })).toEqual({ kind: "day", at: new Date(2026, 10, 24, 23, 59, 59).getTime() });
  });

  it("builds each trigger, and names what is missing", () => {
    const f = blankForm(NOW);
    expect(triggerOf({ ...f, days: "m15" }, "h", "UTC")).toEqual({ on: "schedule", rrule: "FREQ=MINUTELY;INTERVAL=15", tz: "UTC" });
    expect(triggerOf({ ...f, starts: "event", event: "task.created" }, "h", "UTC")).toEqual({ on: "lifeos", kinds: ["task.created"] });
    expect(triggerOf({ ...f, starts: "read" }, "h", "UTC")).toBe("Pick a tool to read");
    expect(triggerOf({ ...f, starts: "read", tool: "a1\nsearch_mail", args: '{"from":"events"}', every: "10" }, "h", "UTC")).toEqual({
      on: "read",
      addon: "a1",
      tool: "search_mail",
      args: { from: "events" },
      fire: "changed",
      everySec: 600,
    });
    expect(triggerOf({ ...f, starts: "read", tool: "a1\nx", args: "{bad" }, "h", "UTC")).toBe("With is not JSON");
    expect(triggerOf({ ...f, starts: "file", path: " /w/budget.xlsx " }, "env_box", "UTC")).toEqual({ on: "file", source: { at: "file", host: "env_box", path: "/w/budget.xlsx" }, by: "someone-else" });
  });
});

describe("a routine that runs a host job", () => {
  const FRIDAYS = { on: "schedule", rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0", tz: "America/New_York" } as const;
  const job = row({ name: "Week review", prompt: "", job: "review.make", jobName: "Makes the week's review", model: "opus", trigger: FRIDAYS, words: "Fridays at 4:00 PM", nextAt: new Date(2026, 10, 20, 16, 0).getTime() });
  const o = { workspaceId: "ws", host: "env_box", tz: "America/New_York", touched: false };

  it("is listed like any routine", () => {
    expect(rowLine(job, NOW)).toBe("Fridays at 4:00 PM, next Fri");
    expect(rowMark(job)).toBeNull();
  });

  it("saves with no words, and an edit keeps its job", () => {
    const f = { ...formOf(job, NOW), name: "The week" };
    expect(saveParamsOf(f, job, o)).toMatchObject({ id: "r1", name: "The week", prompt: "", job: "review.make", trigger: FRIDAYS, ends: { kind: "never" } });
    expect(saveParamsOf({ ...f, days: "1" }, job, { ...o, touched: true })).toMatchObject({ job: "review.make", trigger: { rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=16;BYMINUTE=0" } });
  });

  it("a routine without one still needs its words, and sends no job", () => {
    const plain = row();
    expect(saveParamsOf({ ...formOf(plain, NOW), prompt: " " }, plain, o)).toBe("Say what it does");
    expect(saveParamsOf(formOf(plain, NOW), plain, o)).not.toHaveProperty("job");
    expect(saveParamsOf({ ...blankForm(NOW), prompt: "x" }, null, o)).toBe("Give it a name");
  });
});
