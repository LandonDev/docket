import type { OutboxItem } from "@shared/contract-work-outbox";
import type { RecordWork, ThreadRecord } from "@shared/work/threadRecord";
import { WorkHeadView } from "./WorkHead";

/**
 * A Work thread's head over its first message, for
 * `bun scripts/ui-preview.ts src/renderer/src/surfaces/transcript/WorkHead.preview.tsx#WorkHeadPreview`:
 * each state the record has (held, a question, a failure, working, made), on the transcript's 768px column with
 * the thread's first message under it. Rendered by nothing in the app.
 */

const NOW = new Date(2026, 10, 25, 11, 0).getTime();
const AT = new Date(2026, 10, 25, 10, 2).getTime();

const mail: OutboxItem = {
  ref: { at: "lifeos", table: "outbox", id: "m1" },
  kind: "mail.send",
  workspaceId: "ws1",
  sessionId: "t1",
  sector: "purdue",
  summary: "Send to Sam Ortiz: Two switches for the spring LAN",
  verb: "Send",
  account: "landon@purdue.edu",
  state: "held",
  payload: { message: { to: [{ name: "Sam Ortiz", address: "sortiz@purdue.edu" }], subject: "Two switches for the spring LAN", text: "Hi Sam" } },
  createdAt: AT,
  decidedBy: null,
  decidedAt: null,
  n: null,
  why: "lifeos",
  grantId: null,
  error: null,
  result: null,
  routineRunId: null,
  updatedAt: AT,
};

const task: RecordWork = {
  table: "tasks",
  id: "task1",
  title: "Borrow two switches from ITaP",
  state: "open",
  at: AT - 60_000,
  task: { status: "waiting", due: null, projectId: "p1", waitingOn: { name: "Sam Ortiz", since: NOW - 6 * 86_400_000 } },
};

const record = (over: Partial<ThreadRecord>): ThreadRecord => ({ sessionId: "t1", workspaceId: "ws1", waits: [], works: [task], made: [], outcome: null, ...over });

const STATES: { name: string; record: ThreadRecord }[] = [
  { name: "Held", record: record({ waits: [{ kind: "held", item: mail }], outcome: { words: "1 mail to send", tone: "held" } }) },
  { name: "Asks you", record: record({ waits: [{ kind: "asks", sessionId: "t1" }] }) },
  { name: "Failed", record: record({ waits: [{ kind: "failed", sessionId: "t1", words: "Couldn't sign in", cause: "The Purdue Outlook sign-in ran out" }, { kind: "held", item: { ...mail, state: "failed", error: "Outlook refused it" } }] }) },
  { name: "Working", record: record({ outcome: { words: "Writing the mail", tone: "working" } }) },
  {
    name: "Made",
    record: record({
      made: [
        { id: "r2", sessionId: "t1", kind: "file.rename", verb: "Renamed", name: "Budget FY27.xlsx", summary: "", at: AT + 120_000, undone: false, open: { at: "files", workspaceId: "ws1", ref: { at: "file", host: "box", path: "/w/Budget FY27.xlsx" }, name: "Budget FY27.xlsx" } },
        { id: "r1", sessionId: "t1", kind: "file.make", verb: "Made", name: "Seat map.xlsx", summary: "", at: AT, undone: false, open: { at: "files", workspaceId: "ws1", ref: { at: "file", host: "box", path: "/w/Seat map.xlsx" }, name: "Seat map.xlsx" } },
      ],
      outcome: { words: "Renamed Budget FY27.xlsx", tone: "made" },
    }),
  },
  { name: "Done, from a task", record: record({ works: [{ ...task, state: "done" }], outcome: { words: "Mail sent", tone: "done" } }) },
];

export function WorkHeadPreview() {
  return (
    <div className="flex flex-col gap-12 px-4 py-6 font-sans text-[13px] leading-5">
      {STATES.map((state) => (
        <div key={state.name} className="mx-auto flex w-full max-w-[768px] min-w-0 flex-col">
          <div className="pb-3 text-xs text-muted-foreground">{state.name}</div>
          <WorkHeadView record={state.record} environmentId="box" now={NOW} />
          <div className="flex justify-end">
            <div className="w-fit max-w-[85%] rounded-xl bg-card px-3 py-2 text-sm leading-[22px] text-foreground">Ask ITaP if we can borrow two 48-port switches for the LAN. We need them Feb 13 to 15.</div>
          </div>
        </div>
      ))}
    </div>
  );
}
