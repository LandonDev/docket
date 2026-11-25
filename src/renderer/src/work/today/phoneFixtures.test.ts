import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * The phone's Today (ios/TempCodeClient/Sources/TempCodeClient/Work/Today) is a Swift port of this folder's rules,
 * not a host method. This test runs the window's own model and sources over a set of cases and holds
 * ios/TempCodeClient/Tests/TempCodeClientTests/Fixtures/today/<case>.json to what they give: each file is a case's
 * inputs and the page the window makes of them. A change here that is not carried to the phone fails this test, and
 * TodayParityTests.swift fails a phone that differs from the files. UPDATE_FIXTURES=1 writes them
 * (docs/agents/work-today.md "The phone").
 *
 * The sources are hooks; each is driven through the pure function it is built on (`heldRows`, `meetingRows`,
 * `dueRows`, `waitingRows`, Messages' `waitingRows`, `owedRows`, `responseRows`, `clashMarks`, `prepMarks`,
 * `readyRow`, `alsoRows`, `answerOf` for the LifeOS reads), with the hook's own few lines of answer-making copied
 * beside each (marked "as the hook does"), since no hook runs without React and a live store.
 */

// The words are said in one zone, fixed before any module makes its formats.
vi.hoisted(() => {
  process.env.TZ = "America/Chicago";
});
const ZONE = "America/Chicago";

const opened = vi.hoisted(() => ({ last: null as string | null }));
/** The threads' titles a case's requests name, as the window's session store would answer them. */
const titles = vi.hoisted(() => new Map<string, string>());
vi.mock("../../lib/threadMentions", async (load) => ({ ...(await load<typeof import("../../lib/threadMentions")>()), storeTitleOf: (id: string) => titles.get(id) }));
vi.mock("../outbox/store", async (load) => ({ ...(await load<typeof import("../outbox/store")>()), wantOutboxItem: () => void (opened.last = "outbox") }));
vi.mock("./store", async (load) => ({ ...(await load<typeof import("./store")>()), openHeld: () => void (opened.last = "held") }));
vi.mock("./open", async (load) => ({ ...(await load<typeof import("./open")>()), goTo: (_w: unknown, target: { view: string }) => void (opened.last = target.view) }));
vi.mock("../files/openFrom", () => ({ openInFiles: async () => void (opened.last = "msform") }));
vi.mock("../review/open", () => ({ openReview: () => void (opened.last = "review") }));
vi.mock("../clashes/open", () => ({ openClash: () => void (opened.last = "clash"), clashAsk: { get: () => null, set: () => {} } }));

import type { HostItem } from "../outbox/store";
import type { HostRequest } from "../outbox/requests";
import { clashMarks } from "../clashes/today";
import { alsoRows } from "../digest/today";
import { waitingRows as chatRows } from "../messages/today";
import { owedRows } from "../money/today";
import { responseRows } from "../msforms/today";
import { prepMarks } from "../prep/today";
import { readyRow } from "../review/today";
import { dueRows, namesNote, projectOfTask, type DueProject, type DueTask } from "./due";
import { heldRows, placeOf } from "./held";
import { answerOf, type Lost } from "./lifeos";
import { meetingRows, type MeetingEvent } from "./meetings";
import { dayBounds, page, workspaceFor, type Fed, type LifeosReach, type TodayPage } from "./model";
import { keepRows } from "./stable";
import type { TodayAnswer, TodayFailure, TodayMark, TodayRow, TodaySection, TodayWorkspace } from "./types";
import { waitingRows, type Wait } from "./waiting";
import { goTo } from "./open";

const ROOT = resolve(__dirname, "../../../../..");
const DIR = join(ROOT, "ios/TempCodeClient/Tests/TempCodeClientTests/Fixtures/today");

// ── the inputs, as plain JSON (the Swift structs decode these) ──────────────────────────────────────

type JobRef = { environmentId: string; workspaceId: string };
type Each<V> = { answers: (JobRef & { value: V })[]; loading?: boolean; stale?: boolean; away?: boolean; failed?: { environmentId: string; error: string }[] };
type LifeosRead = { error?: string; pending?: boolean; lost?: Lost[]; built: boolean };
type Chat = { chatId: string; chat: string; who: string; text: string; at: number };
type Owed = { rows: { row: number; who: string; what: string; amount: number; since: string | null; way: "toHim" | "byHim"; reimburse: boolean }[]; problems?: string[] };
type Form = { formId: string; tenant: string; title: string; unseen: number; lastAnswerAt: number | null };
type Tell = { id: string; host: string; kind: string; group: string; workspaceId?: string; sector?: string; title: string; detail?: string; key?: string; at: number; by?: number; how: string; day: string | null; open?: Record<string, unknown> };

type Sources = {
  /** `requests`: each thread's open request, with its thread's title beside it (`thread`, the window's session store's). */
  held?: { items: HostItem[]; requests?: (HostRequest & { thread?: string })[]; names: (JobRef & { name: string })[]; loaded: boolean; errors: { environmentId: string; error: string }[] };
  meetings?: { events: MeetingEvent[]; people: Record<string, { _id: string; name: string; emails: string[] }[]>; read: LifeosRead };
  /** `projects`: the names read beside the tasks (`rows` null while out), the sectors whose names came whole, and
   * whether a names read failed (the hook's `projectRead`). */
  due?: { tasks: DueTask[]; read: LifeosRead; projects?: { rows: DueProject[] | null; known?: string[]; failed?: boolean } };
  waiting?: { waits: Wait[]; read: LifeosRead; beyond?: boolean };
  messages?: Each<Chat[]>;
  clashes?: { range?: { clashes: unknown[]; leaves: unknown[] }; loading?: boolean; error?: string };
  money?: Each<Owed>;
  review?: { asked: string[]; answered: Record<string, { from: number; madeAt: number } | null> };
  prep?: { answers: (JobRef & { value: { meetings: { workspaceId: string; eventId: string; state: string }[] } })[] };
  msforms?: Each<{ forms: Form[] }>;
  digest?: { rows: Tell[]; loaded: boolean; errors: { environmentId: string; error: string }[] };
  /** Rows of a source of the fixture's own, fed after every real one: a second source that gives a key a first already gave. */
  extra?: { rows: { key: string; section: string; title: string; sector?: string | null }[] };
};

type Case = {
  name: string;
  now: number;
  jobs: TodayWorkspace[];
  home: string | null;
  lifeos: LifeosReach;
  /** The host the one LifeOS session reads through. */
  lifeosHost: string;
  sessionDown?: boolean;
  open?: string[];
  folds?: { more: string[]; earlier: string[] };
  gone?: string[];
  sources: Sources;
  /** A fresh answer laid over the first (the stable rule): the Due rows at `before` and again at `after`. */
  stable?: { before: { tasks: DueTask[]; now: number }; after: { tasks: DueTask[]; now: number } };
};

// ── the cases ────────────────────────────────────────────────────────────────────────────────────

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const NOW = at(24, 13, 35);
const job = (environmentId: string, sector: string, name: string, open = true): TodayWorkspace => ({ environmentId, workspaceId: `${environmentId}-${sector}`, sector: sector as TodayWorkspace["sector"], name, path: `/w/${environmentId}/${sector}`, open });
const PURDUE = job("mac", "purdue", "Purdue Esports");
const REF = job("mac", "ref", "Refereeing");
const HYPIXEL = job("box", "hypixel", "Hypixel");
const ref = (w: TodayWorkspace): JobRef => ({ environmentId: w.environmentId, workspaceId: w.workspaceId });

const item = (environmentId: string, id: string, more: Partial<HostItem> & Pick<HostItem, "kind" | "summary" | "verb">): HostItem =>
  ({
    environmentId,
    ref: { at: "host", id },
    workspaceId: null,
    sessionId: null,
    sector: null,
    account: null,
    state: "held",
    createdAt: at(24, 9),
    decidedBy: null,
    decidedAt: null,
    n: null,
    why: "rule",
    grantId: null,
    error: null,
    result: null,
    routineRunId: null,
    updatedAt: at(24, 9),
    ...more,
  }) as HostItem;
const event = (id: string, sector: string, title: string, startsAt: number, more: Partial<MeetingEvent> = {}): MeetingEvent => ({ _id: id, title, sector: sector as MeetingEvent["sector"], startsAt, endsAt: startsAt + 3_600_000, allDay: false, ...more });
const task = (id: string, sector: string, title: string, more: Partial<DueTask> = {}): DueTask => ({ _id: id, title, sector: sector as DueTask["sector"], status: "open", ...more });
const wait = (id: string, sector: string, subject: string, since: number, to: { name?: string; address: string }[]): Wait => ({ _id: id, subject, sector: sector as Wait["sector"], waiting: { since, dueAt: since + 3 * 86_400_000, asked: false, to } });
const OK: LifeosRead = { built: true };
const side = (eventId: string, sector: string, title: string, startsAt: number, endsAt: number) => ({ eventId, sector, title, startsAt, endsAt, can: ["decline"] });

const emptySources = (): Sources => ({
  held: { items: [], names: [], loaded: true, errors: [] },
  meetings: { events: [], people: {}, read: OK },
  due: { tasks: [], read: OK },
  waiting: { waits: [], read: OK },
  messages: { answers: [] },
  clashes: { range: { clashes: [], leaves: [] } },
  money: { answers: [] },
  review: { asked: [], answered: {} },
  prep: { answers: [] },
  msforms: { answers: [] },
  digest: { rows: [], loaded: true, errors: [] },
});

const base = { now: NOW, home: "mac", lifeos: "ok" as LifeosReach, lifeosHost: "mac", open: ["mac", "box"] };

const CASES: Case[] = [
  { ...base, name: "empty-day", jobs: [PURDUE, HYPIXEL], sources: emptySources() },
  { ...base, name: "no-jobs", jobs: [], sources: emptySources() },
  {
    ...base,
    name: "due-projects",
    jobs: [PURDUE, REF],
    sources: {
      ...emptySources(),
      due: {
        tasks: [
          task("p1", "purdue", "Print the brackets", { dueAt: at(24, 15), projectId: "proj-spring" }),
          task("p2", "purdue", "Order shirts", { dueAt: at(24, 16), projectId: "proj-gone" }),
          task("p3", "ref", "File the game report", { dueAt: at(24, 17), projectId: "proj-ref" }),
          task("p4", "purdue", "Call Dana", { dueAt: at(24, 18) }),
        ],
        read: OK,
        // Purdue's names came whole (Order shirts' project is gone); Refereeing's failed, so its task opens its project by id.
        projects: { rows: [{ _id: "proj-spring", name: "Spring tour" }], known: ["purdue"], failed: true },
      },
    },
  },
  {
    ...base,
    name: "full-day",
    jobs: [PURDUE, REF, HYPIXEL],
    sources: {
      held: {
        items: [
          item("mac", "h1", { kind: "mail.send", summary: "Send to Dana Lee: Travel budget for nationals", verb: "Send", workspaceId: PURDUE.workspaceId, sector: "purdue", createdAt: at(24, 8, 12) }),
          item("mac", "h2", { kind: "teams.post", summary: "Post in Teams: Roster is final", verb: "Post", workspaceId: PURDUE.workspaceId, sector: "purdue", state: "failed", error: "Teams refused the post", createdAt: at(21, 16, 40) }),
          item("box", "h3", { kind: "office.edit", summary: "Change Brief.docx in Brief.docx: 3 boxes, the title and 2 more", verb: "Change", workspaceId: "~work", payload: { name: "Brief.docx", edits: [{}, {}] }, createdAt: at(10, 11) }),
          item("box", "h4", { kind: "calendar.op", summary: "Decline Staff sync", verb: "Decline", state: "sending", createdAt: at(24, 7) }),
        ],
        names: [{ ...ref(PURDUE), name: "Purdue Esports" }],
        loaded: true,
        errors: [],
      },
      meetings: {
        events: [
          event("e1", "purdue", "Budget sync", at(24, 14), { location: "Zoom", attendees: [{ address: "maya@purdue.edu" }] }),
          event("e2", "ref", "Varsity, Central at Northside", at(24, 18, 30), { location: "Northside gym", leaveAt: at(24, 17, 10) }),
          event("e3", "purdue", "Standup", at(24, 9), { endsAt: at(24, 9, 15) }),
          event("e4", "hypixel", "Render review", at(24, 16)),
        ],
        people: { purdue: [{ _id: "p1", name: "Maya Chen", emails: ["Maya@purdue.edu"] }] },
        read: OK,
      },
      due: {
        tasks: [
          task("t1", "purdue", "Confirm bus for nationals", { dueAt: at(22, 17) }),
          task("t2", "hypixel", "Send Jess the trailer notes", { dueAt: at(24, 17) }),
          task("t3", "ref", "Read the new rule book", { pinned: true }),
          task("t4", "ref", "Later thing", { dueAt: at(27, 9) }),
        ],
        read: OK,
      },
      waiting: { waits: [wait("m1", "purdue", "Travel budget for nationals", at(18, 21, 30), [{ name: "Dana Lee", address: "dana@purdue.edu" }])], read: OK },
      messages: {
        answers: [{ ...ref(HYPIXEL), value: [{ chatId: "c1", chat: "Builders", who: "Jess", text: "Is the trailer cut ready?", at: at(24, 12, 2) }, { chatId: "c2", chat: "Sam", who: "Sam", text: "", at: at(23, 20) }] }],
      },
      clashes: { range: { clashes: [{ id: "e4-e2", kind: "drive", a: side("e4", "hypixel", "Render review", at(24, 16), at(24, 17)), b: side("e2", "ref", "Varsity, Central at Northside", at(24, 18, 30), at(24, 20, 30)), minutes: 38, measured: true, shortBy: 12 }], leaves: [] } },
      money: { answers: [{ ...ref(PURDUE), value: { rows: [{ row: 4, who: "Purdue", what: "Bus deposit", amount: 125000, since: "2026-11-02", way: "toHim", reimburse: true }], problems: [] } }] },
      review: { asked: ["mac", "box"], answered: { mac: { from: at(16, 0), madeAt: at(20, 16) }, box: null } },
      prep: { answers: [{ ...ref(PURDUE), value: { meetings: [{ workspaceId: PURDUE.workspaceId, eventId: "e1", state: "briefed" }, { workspaceId: "other", eventId: "e2", state: "briefed" }] } }] },
      msforms: { answers: [{ ...ref(PURDUE), value: { forms: [{ formId: "f1", tenant: "purdue", title: "Tryout signups", unseen: 3, lastAnswerAt: at(24, 10) }, { formId: "f2", tenant: "purdue", title: "Old form", unseen: 0, lastAnswerAt: null }] } }] },
      digest: {
        rows: [
          { id: "d1", host: "box", kind: "routines.result", group: "results", title: "Weekly export finished", detail: "12 rows", at: at(24, 6, 30), how: "digest", day: "2026-11-24", open: { view: "routines", workspaceId: HYPIXEL.workspaceId } },
          { id: "d2", host: "box", kind: "mail.waiting", group: "people", title: "Dana has not answered", at: at(24, 6), how: "digest", day: "2026-11-24" },
          { id: "d3", host: "mac", kind: "ending.signin", group: "ending", title: "Teams sign-in ends", key: "teams-end", at: at(24, 7), by: at(25, 9), how: "waiting", day: null },
        ],
        loaded: true,
        errors: [],
      },
    },
  },
  {
    ...base,
    name: "meetings-times",
    jobs: [PURDUE, REF],
    sources: {
      meetings: {
        events: [
          event("past", "purdue", "Standup", at(24, 9), { endsAt: at(24, 9, 30) }),
          event("now", "purdue", "Planning", at(24, 13), { endsAt: at(24, 14) }),
          event("soon", "purdue", "Budget sync", at(24, 14)),
          event("later", "ref", "Varsity game", at(24, 18, 30), { location: "Northside gym", leaveAt: at(24, 17, 10) }),
          event("gone", "ref", "Left early", at(24, 19), { leaveAt: at(24, 18), travel: { departedAt: at(24, 13) } }),
          event("allday", "ref", "Tournament week", at(24, 0), { allDay: true, endsAt: at(25, 0) }),
          event("hidden", "purdue", "Hidden", at(24, 15), { hidden: true }),
          event("nojob", "cosmic", "No job's", at(24, 15)),
        ],
        people: {},
        read: OK,
      },
    },
  },
  {
    ...base,
    name: "meetings-all-over",
    now: at(24, 20),
    jobs: [PURDUE],
    sources: {
      ...emptySources(),
      meetings: { events: [event("a", "purdue", "Standup", at(24, 9)), event("b", "purdue", "Staff sync", at(25, 9, 30)), event("c", "purdue", "Holiday", at(25, 0), { allDay: true })], people: {}, read: OK },
    },
  },
  {
    ...base,
    name: "clash-marks",
    jobs: [PURDUE, REF],
    sources: {
      meetings: { events: [event("x", "purdue", "Staff meeting", at(24, 17)), event("y", "ref", "Varsity Basketball", at(24, 17, 30)), event("z", "ref", "JV game", at(24, 20)), event("w", "purdue", "Late call", at(25, 23))], people: {}, read: OK },
      clashes: {
        range: {
          clashes: [
            { id: "x-y", kind: "overlap", a: side("x", "purdue", "Staff meeting", at(24, 17), at(24, 18)), b: side("y", "ref", "Varsity Basketball", at(24, 17, 30), at(24, 19)) },
            { id: "y-z", kind: "drive", a: side("y", "ref", "Varsity Basketball", at(24, 17, 30), at(24, 19)), b: side("z", "ref", "JV game", at(24, 20), at(24, 21)), minutes: 70, measured: false, shortBy: 13 },
            { id: "z-w", kind: "overlap", a: side("z", "ref", "JV game", at(24, 20), at(24, 21)), b: side("w", "purdue", "Late call", at(25, 23), at(26, 0)) },
          ],
          leaves: [
            { eventId: "z", leaveAt: at(24, 19, 5), minutes: 40, measured: true, from: "event" },
            { eventId: "x", leaveAt: at(24, 12), minutes: 30, measured: true, from: "start" },
          ],
        },
      },
    },
  },
  {
    ...base,
    name: "due-fold",
    jobs: [PURDUE, HYPIXEL],
    sources: {
      due: {
        tasks: [
          task("a", "purdue", "Overdue a week", { dueAt: at(17, 9) }),
          task("b", "purdue", "Overdue yesterday", { dueAt: at(23, 16) }),
          task("c", "hypixel", "Due this morning", { dueAt: at(24, 10) }),
          task("d", "hypixel", "Due at two", { dueAt: at(24, 14) }),
          task("e", "purdue", "Due at three", { dueAt: at(24, 15) }),
          task("f", "purdue", "Due at four", { dueAt: at(24, 16) }),
          task("g", "hypixel", "Due at five", { dueAt: at(24, 17) }),
          task("h", "hypixel", "Due late tonight", { dueAt: at(24, 23, 30) }),
          task("i", "purdue", "Pinned, no date", { pinned: true }),
          task("j", "purdue", "Tomorrow's", { dueAt: at(25, 9) }),
          task("k", "cosmic", "No job's", { dueAt: at(24, 9) }),
        ],
        read: OK,
      },
    },
  },
  {
    ...base,
    name: "due-unfolded",
    jobs: [PURDUE],
    folds: { more: ["due"], earlier: [] },
    sources: { due: { tasks: "abcdefghi".split("").map((id, i) => task(id, "purdue", `Task ${id}`, { dueAt: at(24, 14, i * 15) })), read: OK } },
  },
  {
    ...base,
    name: "mail-six-days",
    jobs: [PURDUE, REF],
    sources: {
      waiting: {
        waits: [
          wait("w1", "purdue", "Travel budget for nationals", at(18, 23, 50), [{ name: "Dana Lee", address: "dana@purdue.edu" }]),
          wait("w2", "ref", "", at(5, 9), [{ address: "assign@ihsaa.org" }, { name: " ", address: "crew@ihsaa.org" }, { name: "Pat", address: "pat@x.org" }]),
          wait("w3", "ref", "Two", at(23, 9), [{ name: "Ann", address: "a@x.org" }, { name: "Bo", address: "b@x.org" }]),
          { ...wait("w4", "purdue", "Own sector", at(22, 9), []), sector: undefined, ownSector: "purdue" },
          wait("w5", "cosmic", "No job's", at(20, 9), [{ address: "x@y.z" }]),
        ],
        read: OK,
      },
    },
  },
  {
    ...base,
    name: "source-failed",
    jobs: [PURDUE, REF, HYPIXEL],
    sources: {
      held: { items: [], names: [], loaded: true, errors: [{ environmentId: "box", error: "It did not answer in time" }] },
      meetings: { events: [event("e1", "purdue", "Budget sync", at(24, 14))], people: {}, read: { built: true, pending: true, lost: [{ environmentId: "box", sector: "hypixel", error: "signed out", down: "signed-out" }] } },
      due: { tasks: [], read: { built: false, error: "Server error: tasks:list" } },
      waiting: { waits: [], read: { built: true, lost: [{ environmentId: "box", sector: "hypixel", error: "signed out", down: "signed-out" }, { environmentId: "mac", sector: "ref", error: "No signed-in host can read this job" }] } },
      clashes: { error: "Server error: clashes:range" },
      money: { answers: [], failed: [{ environmentId: "box", error: "It did not answer in time" }] },
    },
  },
  {
    ...base,
    name: "session-down",
    jobs: [PURDUE],
    lifeos: "signed-out",
    sessionDown: true,
    sources: {
      held: { items: [], names: [], loaded: true, errors: [] },
      meetings: { events: [], people: {}, read: { built: false, error: "Not signed in" } },
      due: { tasks: [], read: { built: false, error: "Not signed in" } },
      clashes: { error: "Not signed in" },
    },
  },
  {
    ...base,
    name: "host-away",
    jobs: [PURDUE, { ...HYPIXEL, open: false }],
    open: ["mac"],
    sources: {
      ...emptySources(),
      held: { items: [], names: [], loaded: true, errors: [{ environmentId: "box", error: "Not connected" }] },
      messages: { answers: [], away: true },
      digest: { rows: [], loaded: true, errors: [{ environmentId: "box", error: "Not connected" }] },
    },
  },
  {
    ...base,
    name: "lifeos-offline",
    jobs: [{ ...PURDUE, open: false }],
    lifeos: "offline",
    open: [],
    sources: { ...emptySources(), meetings: { events: [], people: {}, read: { built: false } } },
  },
  {
    ...base,
    name: "lifeos-waiting",
    jobs: [PURDUE],
    lifeos: "waiting",
    sources: { ...emptySources(), meetings: { events: [], people: {}, read: { built: false } }, due: { tasks: [], read: { built: false } } },
  },
  {
    ...base,
    name: "same-key",
    jobs: [PURDUE, HYPIXEL],
    sources: {
      held: {
        items: [
          item("mac", "h1", { kind: "mail.send", summary: "Send to Dana: First", verb: "Send", createdAt: at(24, 8) }),
          item("mac", "h1", { kind: "mail.send", summary: "Send to Dana: Second copy", verb: "Send", createdAt: at(24, 9) }),
        ],
        names: [],
        loaded: true,
        errors: [],
      },
      money: { answers: [{ ...ref(PURDUE), value: { rows: [], problems: ["a", "b"] } }] },
      extra: { rows: [{ key: "held:mac:host:h1", section: "held", title: "A later source's copy", sector: "purdue" }, { key: "extra:1", section: "nowhere", title: "No section" }] },
    },
  },
  {
    ...base,
    name: "two-hosts-one-sector",
    jobs: [job("mac", "purdue", "Purdue (Mac)"), job("box", "purdue", "Purdue Esports")],
    home: "box",
    sources: {
      held: {
        items: [item("mac", "a", { kind: "mail.send", summary: "Send: A", verb: "Send", workspaceId: "mac-purdue", sector: "purdue" }), item("box", "a", { kind: "mail.send", summary: "Send: B", verb: "Send", workspaceId: "box-purdue", sector: "purdue" })],
        names: [
          { environmentId: "mac", workspaceId: "mac-purdue", name: "Purdue (Mac)" },
          { environmentId: "box", workspaceId: "box-purdue", name: "Purdue Esports" },
        ],
        loaded: true,
        errors: [],
      },
      due: { tasks: [task("t", "purdue", "Book the bus", { dueAt: at(24, 15) })], read: OK },
      messages: {
        answers: [
          { environmentId: "mac", workspaceId: "mac-purdue", value: [{ chatId: "c", chat: "Staff", who: "Dana", text: "older", at: at(24, 11) }] },
          { environmentId: "box", workspaceId: "box-purdue", value: [{ chatId: "c", chat: "Staff", who: "Dana", text: "newer", at: at(24, 12) }] },
        ],
      },
    },
  },
  {
    ...base,
    name: "requests",
    jobs: [PURDUE, HYPIXEL],
    sources: {
      ...emptySources(),
      held: {
        items: [
          item("mac", "r-a", { kind: "mail.send", summary: "Send to Dana Lee: Travel budget", verb: "Send", workspaceId: PURDUE.workspaceId, sector: "purdue", createdAt: at(24, 8) }),
          item("mac", "r-b", { kind: "mail.send", summary: "Send to Maya Chen: Roster", verb: "Send", workspaceId: PURDUE.workspaceId, sector: "purdue", createdAt: at(24, 8, 5) }),
          item("mac", "lone", { kind: "teams.post", summary: "Post in Teams: Practice moved", verb: "Post", workspaceId: PURDUE.workspaceId, sector: "purdue", createdAt: at(24, 9) }),
        ],
        requests: [
          {
            environmentId: "mac",
            id: "q1",
            n: 1,
            sessionId: "s1",
            workspaceId: PURDUE.workspaceId,
            sector: "purdue",
            quote: "send both",
            head: "Send 2 mails to 2 people",
            state: "open",
            why: null,
            createdAt: at(24, 8, 10),
            expiresAt: at(24, 20),
            answeredBy: null,
            answeredAt: null,
            thread: "Nationals travel",
            rows: [
              { ref: { at: "host", id: "r-a" }, do: "send", at: null, item: item("mac", "r-a", { kind: "mail.send", summary: "Send to Dana Lee: Travel budget", verb: "Send", workspaceId: PURDUE.workspaceId, sector: "purdue", createdAt: at(24, 8) }), changed: false, open: true, receipt: null, result: null },
              { ref: { at: "host", id: "r-b" }, do: "send", at: null, item: item("mac", "r-b", { kind: "mail.send", summary: "Send to Maya Chen: Roster", verb: "Send", workspaceId: PURDUE.workspaceId, sector: "purdue", createdAt: at(24, 8, 5) }), changed: false, open: true, receipt: null, result: null },
            ],
          } as unknown as HostRequest & { thread?: string },
        ],
        names: [{ ...ref(PURDUE), name: "Purdue Esports" }],
        loaded: true,
        errors: [],
      },
    },
  },
  {
    ...base,
    name: "guest-kinds",
    jobs: [PURDUE, HYPIXEL],
    sources: {
      ...emptySources(),
      digest: {
        rows: [
          { id: "g1", host: "box", kind: "guests.edited", group: "people", title: "Jess edited Trailer notes", detail: "3 changes", at: at(24, 10), how: "digest", day: "2026-11-24" },
          { id: "g2", host: "box", kind: "guests.opened", group: "people", title: "Jess opened Trailer notes", at: at(24, 9), how: "digest", day: "2026-11-24" },
          { id: "g3", host: "mac", kind: "docs.guest", group: "people", title: "A guest edited Brief.docx", at: at(24, 8), how: "digest", day: "2026-11-24" },
          { id: "g4", host: "mac", kind: "messages.new", group: "people", title: "Not Also's", at: at(24, 8), how: "digest", day: "2026-11-24" },
        ],
        loaded: true,
        errors: [],
      },
    },
  },
  {
    ...base,
    name: "lifeos-connecting",
    jobs: [PURDUE],
    lifeos: "connecting",
    sources: { ...emptySources(), meetings: { events: [], people: {}, read: { built: false } }, due: { tasks: [], read: { built: false } }, waiting: { waits: [], read: { built: false } } },
  },
  {
    ...base,
    name: "lost-waits",
    jobs: [PURDUE, REF],
    sources: {
      ...emptySources(),
      meetings: { events: [], people: {}, read: { built: true, lost: [{ environmentId: "mac", sector: "ref", error: "", waits: true }] } },
      due: { tasks: [], read: { built: true, lost: [{ environmentId: "mac", sector: "ref", error: "", waits: true }] } },
    },
  },
  {
    ...base,
    name: "stable-reorder",
    jobs: [PURDUE],
    sources: {},
    stable: {
      before: { now: at(24, 13), tasks: [task("a", "purdue", "First", { dueAt: at(24, 15) }), task("b", "purdue", "Second", { dueAt: at(24, 16) }), task("c", "purdue", "Third", { dueAt: at(24, 13, 30) })] },
      after: { now: at(24, 14), tasks: [task("c", "purdue", "Third", { dueAt: at(24, 13, 30) }), task("b", "purdue", "Second, renamed", { dueAt: at(24, 16) }), task("a", "purdue", "First", { dueAt: at(24, 15) })] },
    },
  },
];

// ── the window's rules over a case ───────────────────────────────────────────────────────────────

const SECTIONS: Record<string, TodaySection> = {};
const session = (c: Case) => ({ environmentId: c.lifeosHost, sector: null, client: c.sessionDown ? null : ({} as never), state: c.sessionDown ? "signed-out" : "connected" }) as never;
const withRetry = (failed: { environmentId: string; error: string }[] = []): TodayFailure[] => failed.map((f) => ({ ...f, retry: () => {} }));
const asRead = (r: LifeosRead) => ({ error: r.error ?? null, pending: !!r.pending, lost: r.lost ?? [], retry: async () => {}, retryLost: async () => {} });
const each = <V>(e: Each<V>, jobs: TodayWorkspace[]) => ({
  answers: e.answers.map((a) => ({ workspace: jobs.find((w) => w.environmentId === a.environmentId && w.workspaceId === a.workspaceId)!, value: a.value })),
  state: { loading: !!e.loading, failed: withRetry(e.failed), ...(e.stale ? { stale: true } : {}), ...(e.away ? { away: true } : {}) },
});
const ways = <T>(jobs: TodayWorkspace[], home: string | null, view: string) => ({
  workspaceOf: (sector: string) => workspaceFor(sector as TodayWorkspace["sector"], jobs, home),
  open: (w: TodayWorkspace) => goTo(w, { view } as never),
  // presses are only labelled in the fixtures
  prepare: () => {},
  done: async () => {},
  tomorrow: async () => {},
  nudge: async () => {},
  dismiss: async () => {},
}) as unknown as T;

function fedOf(c: Case): Fed[] {
  const s = c.sources;
  const day = dayBounds(c.now);
  const jobs = c.jobs;
  const jobName = (sector: string) => workspaceFor(sector as TodayWorkspace["sector"], jobs, c.home)?.name;
  const fed: Fed[] = [];
  const add = (id: string, section: TodaySection | undefined, answer: TodayAnswer) => {
    if (section) SECTIONS[id] = section;
    fed.push({ source: { id, ...(section ? { section } : {}) }, answer });
  };
  const lifeosSection = (id: string, title: string, order: number, empty: string, fold: number | undefined, bones: TodaySection["bones"]): TodaySection => ({ id, title, order, empty, ...(fold ? { fold } : {}), lifeos: true, ...(bones ? { bones } : {}) });
  if (s.held) {
    const names = (environmentId: string, workspaceId: string) => s.held!.names.find((n) => n.environmentId === environmentId && n.workspaceId === workspaceId)?.name;
    // as the hook does
    titles.clear();
    for (const request of s.held.requests ?? []) if (request.thread) titles.set(request.sessionId, request.thread);
    add("held", { id: "held", title: "Waiting on you", order: 10, empty: "Nothing waits on your press", fold: 5, bones: "lines" }, {
      rows: heldRows(s.held.items, c.now, (i) => placeOf(i, names), s.held.requests ?? []),
      loading: !s.held.loaded,
      failed: withRetry(s.held.errors),
    });
  }
  if (s.meetings) {
    const m = s.meetings;
    const built = m.read.built ? meetingRows(m.events, day, c.now, { ...ways(jobs, c.home, "agenda"), peopleOf: (sector: string) => m.people[sector] ?? [] }) : null;
    add("meetings", lifeosSection("meetings", "Meetings", 20, "No meetings today", undefined, "lines"), answerOf(asRead(m.read), built?.rows ?? null, session(c), "meetings", built?.note, jobName));
  }
  if (s.due) {
    // as the hook does: a task's project by name, else by its id alone while its job's names are out
    const names = s.due.projects;
    const projects = names?.rows ? new Map(names.rows.map((p) => [p._id, p])) : null;
    const dueWays = names
      ? { ...ways<Parameters<typeof dueRows>[2]>(jobs, c.home, "tasks"), projectOf: (t: DueTask) => projectOfTask(t, projects, (sector) => !names.known || names.known.includes(sector)), openProject: () => {} }
      : ways<Parameters<typeof dueRows>[2]>(jobs, c.home, "tasks");
    const rows = s.due.read.built ? dueRows(s.due.tasks, c.now, dueWays) : null;
    const note = names ? namesNote(!!names.failed, rows) : undefined;
    add("due", lifeosSection("due", "Due", 30, "Nothing due today", 7, "tick"), answerOf(asRead(s.due.read), rows, session(c), "tasks", note, jobName));
  }
  if (s.waiting) {
    const rows = s.waiting.read.built ? waitingRows(s.waiting.waits, day.from, ways(jobs, c.home, "mail")) : null;
    const answer = answerOf(asRead(s.waiting.read), rows, session(c), "mail", undefined, jobName);
    // as the hook does: past the fifth page the section never says it is empty
    add("waiting", lifeosSection("waiting", "Waiting on others", 40, "No one owes you a reply", 5, "lines"), s.waiting.beyond && answer.rows ? { ...answer, away: true } : answer);
  }
  if (s.messages) {
    const e = each(s.messages, jobs);
    add("messages", { id: "messages", title: "Messages", order: 45, empty: "No one is waiting on a reply", fold: 5, lifeos: true }, { rows: chatRows(e.answers.map((a) => ({ workspace: a.workspace, value: { rows: a.value } })) as never, c.now, () => {}), ...e.state });
  }
  if (s.clashes) {
    const k = s.clashes;
    // as the hook does
    const answer: TodayAnswer = k.loading
      ? { loading: true }
      : k.error !== undefined
        ? c.sessionDown
          ? {}
          : { failed: [{ environmentId: c.lifeosHost, error: k.error, said: "LifeOS could not read clashes" }] }
        : { marks: clashMarks(k.range as never, { day, workspaces: jobs, lifeos: session(c) }, c.now) };
    add("clashes", undefined, answer);
  }
  if (s.money) {
    const e = each(s.money, jobs);
    const d = new Date(day.from);
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    add("money", { id: "money", title: "Owed", order: 60, empty: "", fold: 5 }, { rows: owedRows(e.answers as never, today), ...e.state });
  }
  if (s.review) {
    const r = s.review;
    // as the hook does: the newest week wins; a host still to answer keeps the page from clear
    const newest = Object.values(r.answered).reduce<{ from: number; madeAt: number } | null>((best, x) => (x && (!best || x.from > best.from) ? x : best), null);
    const out = r.asked.some((id) => !(id in r.answered));
    add("review", undefined, { rows: newest ? [readyRow(newest, day.from, ZONE)] : [], ...(out ? { loading: true } : {}) });
  }
  if (s.prep) {
    const answers = s.prep.answers.map((a) => ({ workspace: jobs.find((w) => w.environmentId === a.environmentId && w.workspaceId === a.workspaceId)!, value: a.value }));
    add("prep", undefined, { marks: prepMarks(answers) });
  }
  if (s.msforms) {
    const e = each(s.msforms, jobs);
    add("msforms", { id: "msforms", title: "Responses", order: 70, empty: "", fold: 5 }, { rows: responseRows(e.answers), ...e.state });
  }
  if (s.digest) {
    add("digest", undefined, { rows: alsoRows({ rows: s.digest.rows as never }, day, () => void (opened.last = "tell")), loading: !s.digest.loaded, failed: withRetry(s.digest.errors) });
  }
  if (s.extra) add("extra", undefined, { rows: s.extra.rows.map((r) => ({ ...r, sector: (r.sector ?? null) as TodayRow["sector"], open: () => {} })) });
  return fed;
}

// ── the page as plain JSON ───────────────────────────────────────────────────────────────────────

const flag = (b: boolean | undefined) => (b ? true : undefined);
function opensOf(open: () => void): string | null {
  opened.last = null;
  open();
  return opened.last;
}
const rowJson = (r: TodayRow) => ({
  key: r.key,
  section: r.section,
  sector: r.sector ?? null,
  job: r.job,
  title: r.title,
  detail: r.detail,
  detailLate: flag(r.detailLate),
  at: r.at,
  when: r.when,
  whenLine: r.whenLine,
  late: flag(r.late),
  past: flag(r.past),
  lead: r.lead?.kind,
  workspace: r.workspace ? `${r.workspace.environmentId}/${r.workspace.workspaceId}` : undefined,
  opens: opensOf(r.open),
  acts: (r.acts ?? []).map((a) => a.label),
});
const failureJson = (f: TodayFailure) => ({ environmentId: f.environmentId, error: f.error, said: f.said, down: f.down, left: f.left, sector: f.sector ?? undefined, waits: flag(f.waits), retry: flag(!!f.retry) });
function pageJson(p: TodayPage) {
  if (p.kind !== "day") return p.kind === "clear" ? { kind: p.kind, line: p.line } : { kind: p.kind };
  return {
    kind: p.kind,
    offline: p.offline,
    keys: p.keys,
    blocks: p.blocks.map((b) =>
      b.kind === "lifeos"
        ? { kind: b.kind, reach: b.reach }
        : b.kind === "lost"
          ? { kind: b.kind, failure: failureJson(b.failure) }
          : {
              kind: b.kind,
              section: {
                id: b.section.id,
                title: b.section.title,
                state: b.section.state,
                pending: b.section.pending,
                partial: b.section.partial,
                bones: b.section.bones,
                empty: b.section.empty,
                earlier: b.section.earlier,
                more: b.section.more,
                away: b.section.away,
                left: flag(b.section.left),
                note: b.section.note,
                failed: b.section.failed.map(failureJson),
                rows: b.section.rows.map(rowJson),
              },
            },
    ),
  };
}
const marksJson = (fed: Fed[]) => fed.flatMap((f) => (f.answer.marks ?? []).map((m: TodayMark) => ({ source: f.source.id, key: m.key, note: m.note, whenLine: m.whenLine, late: flag(m.late), opens: m.open ? opensOf(m.open) : undefined, act: m.act?.label })));

function fixtureOf(c: Case) {
  const { stable, ...input } = c;
  const day = dayBounds(c.now);
  if (stable) {
    const w = ways<Parameters<typeof dueRows>[2]>(c.jobs, c.home, "tasks");
    const before = dueRows(stable.before.tasks, stable.before.now, w);
    const after = dueRows(stable.after.tasks, stable.after.now, w);
    const kept = keepRows(before, after);
    return { ...input, timeZone: ZONE, day, stable, expect: { stable: { keys: kept.map((r) => r.key), kept: kept.filter((r) => before.includes(r)).map((r) => r.key), same: kept === before } } };
  }
  const fed = fedOf(c);
  const p = page(fed, { jobs: c.jobs, lifeos: c.lifeos, ...(c.folds ? { folds: { more: new Set(c.folds.more), earlier: new Set(c.folds.earlier) } } : {}), ...(c.gone ? { gone: new Set(c.gone) } : {}), ...(c.open ? { open: new Set(c.open) } : {}) });
  return { ...input, timeZone: ZONE, day, expect: { marks: marksJson(fed), page: pageJson(p) } };
}

// ── held to the files ────────────────────────────────────────────────────────────────────────────

const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

describe("the phone's Today fixtures", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("are written in one zone", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(ZONE);
  });

  for (const c of CASES) {
    it(`${c.name} is the window's answer`, () => {
      vi.setSystemTime(c.now);
      const file = join(DIR, `${c.name}.json`);
      const want = text(fixtureOf(c));
      if (process.env.UPDATE_FIXTURES === "1") {
        mkdirSync(DIR, { recursive: true });
        writeFileSync(file, want);
      }
      expect(readFileSync(file, "utf8"), `${c.name}.json is out of date: UPDATE_FIXTURES=1 writes it, then carry the change to Work/Today`).toBe(want);
    });
  }

  it("has no file without a case", () => {
    const names = new Set(CASES.map((c) => `${c.name}.json`));
    expect(readdirSync(DIR).filter((f) => !names.has(f))).toEqual([]);
  });
});
