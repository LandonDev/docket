import { describe, expect, it } from "vitest";
import { emptyPrepDoc, type PrepEvent, type PrepPage } from "@shared/contract-work-prep";
import { addedKey, addTasksLabel, briefIsComing, dayWords, draftLine, fileWhere, headVerb, isOver, lastLabel, meetingMark, moreWords, nobodyOn, notesLines, outcomeIsComing, pageThread, personLine, personTrail, pickable, problemWords, shownTasks, suggestionLine, taskLine, failedWords, returnPicks, samePeople, threadStopped, timeWords, uploadPercent, whenLine } from "./model";

/** A meeting's page in words (docs/agents/work-prep.md "The page"): the comma line, each row's second line and what trails it. */

const at = (hour: number, minute = 0, day = 23): number => new Date(2026, 10, day, hour, minute).getTime();
const NOW = at(9, 30);
const event = (over: Partial<PrepEvent> = {}): PrepEvent => ({ id: "ev1", title: "Staff sync", startsAt: at(14), endsAt: at(14, 45), allDay: false, ...over });

describe("the line under the title", () => {
  it("says the day, the time, the place and when to leave, as one comma sentence", () => {
    expect(whenLine(event({ location: "RecWell 204", leaveAt: at(13, 40) }), NOW)).toBe("Today, 2:00 to 2:45 PM, RecWell 204, leave 1:40");
  });

  it("keeps both halves of the day when a meeting crosses noon, and says a time alone when it has no end", () => {
    expect(timeWords(event({ startsAt: at(11, 30), endsAt: at(12, 15) }))).toBe("11:30 AM to 12:15 PM");
    expect(timeWords(event({ endsAt: undefined }))).toBe("2:00 PM");
    expect(timeWords(event({ allDay: true }))).toBe("all day");
  });

  it("names the day by how far it is", () => {
    expect(dayWords(at(14, 0, 24), NOW)).toBe("Tomorrow");
    expect(dayWords(at(14, 0, 22), NOW)).toBe("Yesterday");
    expect(dayWords(at(14, 0, 16), NOW)).toBe("Mon, Nov 16");
  });

  it("drops the leave time once the meeting has begun, and a place that is only spaces", () => {
    expect(whenLine(event({ location: "  ", leaveAt: at(13, 40) }), at(14, 10))).toBe("Today, 2:00 to 2:45 PM");
  });
});

describe("when a meeting is over", () => {
  it("is at its end; with none, an hour after its start, or a day after it for one that lasts the day", () => {
    expect(isOver(event(), at(14, 44))).toBe(false);
    expect(isOver(event(), at(14, 45))).toBe(true);
    expect(isOver(event({ endsAt: undefined }), at(14, 59))).toBe(false);
    expect(isOver(event({ endsAt: undefined }), at(15))).toBe(true);
    // one that lasts the day with no end is over at the next midnight, as Agenda ends it
    expect(isOver(event({ endsAt: undefined, allDay: true, startsAt: at(0) }), at(23))).toBe(false);
    expect(isOver(event({ endsAt: undefined, allDay: true, startsAt: at(0) }), at(0, 0, 24))).toBe(true);
  });
});

describe("a row's words", () => {
  it("gives a person their newest mail's subject, and its day or Declined at the end", () => {
    const mail = { id: "m1", subject: "Bracket for Friday", at: at(7, 30), unread: true };
    expect(personLine({ name: "Maya Chen", mail })).toBe("Bracket for Friday");
    expect(personTrail({ name: "Maya Chen", mail }, NOW)).toBe("7:30 AM");
    expect(personLine({ name: "Maya Chen", mail: { ...mail, subject: " " } })).toBe("(no subject)");
    expect(personTrail({ name: "Tom Beck", declined: true, mail }, NOW)).toBe("Declined");
    expect(personLine({ name: "Dana Reyes" })).toBeUndefined();
    expect(personTrail({ name: "Dana Reyes" }, NOW)).toBeUndefined();
  });

  it("says why a task is here, and nothing for one that only names the subject", () => {
    expect(taskLine({ id: "t1", title: "x", why: "asked", who: "Maya Chen" })).toBe("Asked by Maya Chen");
    expect(taskLine({ id: "t2", title: "x", why: "waiting", who: "Tom Beck" })).toBe("Waiting on Tom Beck");
    expect(taskLine({ id: "t3", title: "x" })).toBeUndefined();
  });

  it("says where a link lives, and counts the people past the ones drawn", () => {
    expect(fileWhere({ title: "Run of show", url: "https://www.docs.example.com/d/1" })).toBe("docs.example.com");
    expect(fileWhere({ title: "Notes" })).toBeUndefined();
    expect(moreWords(3)).toBe("and 3 more");
    expect(moreWords(0)).toBeUndefined();
    expect(lastLabel({ eventId: "e0", title: "Staff sync", startsAt: at(14, 0, 16), decided: [], open: [], tasks: [] })).toBe("Last time, Nov 16");
  });
});

describe("what did not load", () => {
  it("names the one part that failed by its own words, and says more than one as one plain line", () => {
    expect(problemWords([])).toBeNull();
    expect(problemWords(["tasks"])).toBe("Tasks did not load");
    // the people are drawn whatever failed: what is missing is what LifeOS says of each
    expect(problemWords(["people", "people"])).toBe("People’s mail and tasks did not load");
    expect(problemWords(["drafts"])).toBe("The follow-up mail did not load");
    // never "…mail and tasks and tasks": Retry reads every part again anyway
    expect(problemWords(["people", "tasks"])).toBe("Parts of this page did not load");
    expect(problemWords(["people", "tasks", "last", "drafts"])).toBe("Parts of this page did not load");
  });
});

describe("who Add people can tick", () => {
  const page = (over: Partial<PrepPage>): Pick<PrepPage, "people" | "doc" | "morePeople"> => ({ people: [], morePeople: 0, doc: emptyPrepDoc(), ...over });

  it("is those already added, then the sector's people who are not on the event itself, each once", () => {
    const directory = [
      { _id: "p1", name: "Maya Chen", emails: ["MChen@school.edu", "maya@home.test"] },
      { _id: "p2", name: "Tom Beck", emails: ["tbeck@school.edu"] },
      { _id: "p3", name: "Dana Reyes", emails: [] },
      { _id: "p4", name: "Sam Whitaker", emails: ["sam@arena.com"] },
    ];
    const got = pickable(
      page({
        // Tom is on the event already; Maya was added by her second address; Dana by name
        people: [{ name: "Tom Beck", address: "tbeck@school.edu" }, { name: "Maya Chen", address: "maya@home.test", added: true }],
        doc: { ...emptyPrepDoc(), people: [{ name: "Maya Chen", address: "maya@home.test" }, { name: "Dana Reyes" }] },
      }),
      directory,
    );
    expect(got).toEqual([{ name: "Maya Chen", address: "maya@home.test" }, { name: "Dana Reyes" }, { name: "Sam Whitaker", address: "sam@arena.com", personId: "p4" }]);
  });

  it("keeps a name he typed in this sitting in the list, once, with what the page already keeps", () => {
    const got = pickable(page({ doc: { ...emptyPrepDoc(), people: [{ name: "Dana Reyes" }] } }), [], [{ name: "Jordan Ellis" }, { name: "dana  reyes" }]);
    expect(got).toEqual([{ name: "Dana Reyes" }, { name: "Jordan Ellis" }]);
  });

  it("keeps two names of another script as two people", () => {
    expect(addedKey({ name: "李雷" })).not.toBe(addedKey({ name: "王芳" }));
    expect(addedKey({ name: "Ольга  Петрова" })).toBe("~ольга петрова");
    expect(pickable(page({}), [], [{ name: "李雷" }, { name: "王芳" }])).toHaveLength(2);
  });

  it("has Return in the search add a name only when the list shows no one, tick the one it shows, and never act on several", () => {
    expect(returnPicks("", 3, false)).toBeNull();
    expect(returnPicks("Jordan Ellis", 0, true)).toBe("name");
    expect(returnPicks("sam", 1, true)).toBe("tick");
    expect(returnPicks("a", 4, true)).toBeNull();
    // a name already in the list, filtered away by nothing: no second add
    expect(returnPicks("Dana Reyes", 0, false)).toBeNull();
  });

  it("knows a person by address, else by folded name, as the host does", () => {
    expect(addedKey({ name: "Dana", address: " Dana@X.test " })).toBe("dana@x.test");
    expect(addedKey({ name: "Dána  Reyes" })).toBe("~dana reyes");
    expect(nobodyOn(page({}))).toBe(true);
    expect(nobodyOn(page({ morePeople: 2 }))).toBe(false);
  });
});

describe("the header's verb", () => {
  type Page = Parameters<typeof headVerb>[0];
  const page = (over: Partial<Page> = {}): Page => ({ event: event(), doc: emptyPrepDoc(), briefSessionId: null, followSessionId: null, briefUntil: null, followUntil: null, ...over });
  const brief = { matters: [{ text: "x" }], agreed: [], files: [], at: 1, by: "t" };
  const notes = { text: "n", at: 2 };
  const after = { summary: [], decisions: [], questions: [], tasks: [], at: 3 };
  const idle = { brief: undefined, follow: undefined };

  it("before the end is Brief me, then Preparing while its thread works, then nothing once a brief stands", () => {
    expect(headVerb(page(), NOW, idle)).toBe("brief");
    expect(headVerb(page({ briefSessionId: "t" }), NOW, { ...idle, brief: "running" })).toBe("preparing");
    expect(headVerb(page({ briefSessionId: "t" }), NOW, { ...idle, brief: "queued" })).toBe("preparing");
    expect(headVerb(page({ briefSessionId: "t", doc: { ...emptyPrepDoc(), brief } }), NOW, { ...idle, brief: "idle" })).toBeNull();
    // Prepare again: a brief stands and its thread is at work once more
    expect(headVerb(page({ briefSessionId: "t", doc: { ...emptyPrepDoc(), brief } }), NOW, { ...idle, brief: "running" })).toBe("preparing");
  });

  it("offers Brief me again when the thread stopped without writing", () => {
    for (const status of ["idle", "error", "stopped", "done", "paused"]) expect(headVerb(page({ briefSessionId: "t", briefUntil: NOW + 60_000 }), NOW, { ...idle, brief: status }), status).toBe("brief");
  });

  it("takes the host's bound on time for a thread this window does not hold, read against the window's own clock", () => {
    // at work until the bound: the spinner cannot outlast it, whether or not a push ever comes
    expect(headVerb(page({ briefSessionId: "t", briefUntil: NOW + 60_000 }), NOW, idle)).toBe("preparing");
    expect(headVerb(page({ briefSessionId: "t", briefUntil: NOW + 60_000 }), NOW + 61_000, idle)).toBe("brief");
    expect(headVerb(page({ briefSessionId: "t", briefUntil: null }), NOW, idle)).toBe("brief");
    expect(briefIsComing(page({ briefSessionId: "t", briefUntil: NOW + 1 }), "preparing")).toBe(true);
    expect(briefIsComing(page({ doc: { ...emptyPrepDoc(), brief } }), "preparing")).toBe(false);
    // the same for a follow-up thread on a host whose threads this window does not hold
    const followed = page({ followSessionId: "f", followUntil: NOW + 60_000, doc: { ...emptyPrepDoc(), notes } });
    expect(headVerb(followed, NOW, idle)).toBe("following");
    expect(headVerb(followed, NOW + 61_000, idle)).toBe("followUp");
    // a thread the window does hold says for itself, whatever the bound
    expect(headVerb(page({ briefSessionId: "t", briefUntil: NOW + 60_000 }), NOW, { ...idle, brief: "error" })).toBe("brief");
  });

  it("after the end is Add notes, then Follow up once notes stand, then Following up, then nothing once an outcome stands", () => {
    const over = at(15);
    expect(headVerb(page(), over, idle)).toBe("addNotes");
    expect(headVerb(page({ doc: { ...emptyPrepDoc(), brief } }), over, idle)).toBe("addNotes");
    expect(headVerb(page({ doc: { ...emptyPrepDoc(), notes } }), over, idle)).toBe("followUp");
    expect(headVerb(page({ followSessionId: "f", doc: { ...emptyPrepDoc(), notes } }), over, { ...idle, follow: "running" })).toBe("following");
    expect(headVerb(page({ followSessionId: "f", doc: { ...emptyPrepDoc(), notes, after } }), over, { ...idle, follow: "idle" })).toBeNull();
    // notes typed before the end lead to Follow up too
    expect(headVerb(page({ doc: { ...emptyPrepDoc(), notes } }), NOW, idle)).toBe("followUp");
  });

  it("opens the follow-up's thread once there is one, else the brief's", () => {
    expect(pageThread({ briefSessionId: "b", followSessionId: null })).toBe("b");
    expect(pageThread({ briefSessionId: "b", followSessionId: "f" })).toBe("f");
    expect(pageThread({ briefSessionId: null, followSessionId: null })).toBeNull();
  });
});

describe("the outcome's words", () => {
  it("says who a task falls to as its muted line; when it is due trails the row, as under Tasks", () => {
    expect(suggestionLine({ who: "Tom Beck" })).toBe("Tom Beck");
    expect(suggestionLine({ who: " " })).toBeUndefined();
    expect(suggestionLine({})).toBeUndefined();
  });

  it("counts the ticks, drops what he rejected, and names the mail by who it goes to", () => {
    expect(addTasksLabel(1)).toBe("Add 1 task");
    expect(addTasksLabel(3)).toBe("Add 3 tasks");
    expect(shownTasks([{ id: "a", title: "x", state: "proposed" }, { id: "b", title: "y", state: "rejected" }, { id: "c", title: "z", state: "filed" }]).map((t) => t.id)).toEqual(["a", "c"]);
    expect(draftLine({ to: ["Maya Chen", "Tom Beck"], subject: "s" })).toBe("Follow-up to Maya Chen and Tom Beck");
    expect(draftLine({ to: ["Maya Chen", "Tom Beck", "Dana Reyes", "Sam"], subject: "s" })).toBe("Follow-up to Maya Chen, Tom Beck and 2 more");
    expect(draftLine({ to: [], subject: " " })).toBe("Follow-up mail");
  });

  it("shows six lines of his notes while they lead the page, two once the outcome stands over them", () => {
    const after = { summary: [], decisions: [], questions: [], tasks: [], at: 1 };
    expect(notesLines({ doc: { ...emptyPrepDoc(), notes: { text: "n", at: 1 } } })).toBe(6);
    expect(notesLines({ doc: { ...emptyPrepDoc(), notes: { text: "n", at: 1 }, after } })).toBe(2);
  });

  it("says a failed filing in a short word that always fits, with the task and why beside it", () => {
    const tasks = [{ id: "s1", title: "Book the van" }, { id: "s2", title: "Order jerseys" }];
    const why = "LifeOS did not answer";
    expect(failedWords([{ id: "s2", error: why }], tasks)).toEqual({ word: "A task was not added", detail: "“Order jerseys”: LifeOS did not answer" });
    expect(failedWords([{ id: "gone", error: why }], tasks)).toEqual({ word: "A task was not added", detail: why });
    expect(failedWords([{ id: "s1", error: why }, { id: "s2", error: "x" }], tasks)).toEqual({ word: "2 tasks were not added", detail: why });
  });
});

describe("a thread the window holds", () => {
  it("is at work while it starts, runs, queues or waits on him; stopped otherwise; unknown when the window does not hold it", () => {
    for (const status of ["starting", "running", "queued", "waiting"]) expect(threadStopped("t", status), status).toBe(false);
    for (const status of ["idle", "error", "stopped", "done", "paused", "watching"]) expect(threadStopped("t", status), status).toBe(true);
    // a thread this window does not hold is not called stopped: the host's own bound on time stands
    expect(threadStopped("t", undefined)).toBe(false);
    expect(threadStopped(null, "idle")).toBe(false);
  });

  it("shows the outcome's bones only while the follow-up works and has written nothing", () => {
    const after = { summary: [], decisions: [], questions: [], tasks: [], at: 1 };
    expect(outcomeIsComing({ doc: emptyPrepDoc() }, "following")).toBe(true);
    expect(outcomeIsComing({ doc: { ...emptyPrepDoc(), after } }, "following")).toBe(false);
    expect(outcomeIsComing({ doc: emptyPrepDoc() }, "followUp")).toBe(false);
  });
});

describe("a notes file's upload", () => {
  it("is a whole per cent once the size is known, and nothing before", () => {
    expect(uploadPercent(null)).toBeNull();
    expect(uploadPercent({ sent: 0, total: 0 })).toBeNull();
    expect(uploadPercent({ sent: 21, total: 50 })).toBe(42);
    expect(uploadPercent({ sent: 60, total: 50 })).toBe(100);
  });
});

describe("what Save has to change", () => {
  it("is nothing when the same people are ticked, in any order", () => {
    const dana = { name: "Dana Reyes", address: "dana@x.test" };
    const tom = { name: "Tom Beck" };
    expect(samePeople([dana, tom], [tom, { ...dana, address: "DANA@x.test" }])).toBe(true);
    expect(samePeople([dana], [dana, tom])).toBe(false);
    expect(samePeople([], [])).toBe(true);
  });
});

describe("a meeting's mark on Today", () => {
  it("opens the page for every state and says Prep is ready only once a brief stands", () => {
    const mark = (state: "none" | "working" | "briefed" | "after") => meetingMark({ workspaceId: "ws", eventId: "ev1", state });
    for (const state of ["none", "working", "after"] as const) expect(mark(state)).toEqual({ key: "event:ev1", target: { workspaceId: "ws", view: "prep", event: "ev1" } });
    expect(mark("briefed")).toEqual({ key: "event:ev1", note: "Prep is ready", target: { workspaceId: "ws", view: "prep", event: "ev1" } });
  });
});
