import type { ReactNode } from "react";
import { emptyPrepDoc, type PrepPage } from "@shared/contract-work-prep";
import { Calendar } from "../icons";
import { headVerb } from "./model";
import { BackTitle, PageVerbs, PrepPageBody, PrepSkeleton } from "./PrepView";

/**
 * A meeting's page over fixed data, for `bun run ui:preview
 * src/renderer/src/work/prep/PrepView.preview.tsx#PrepPreview --props '{"state":"facts"}' --shot`:
 * `facts` (the page with no brief: people, tasks, files, last time), `nobody`
 * (a calendar that lists no attendees), `preparing` (a brief thread at work),
 * `briefed` (the brief, with the one-time offer under it), `after` (his notes
 * and what came of them, the tasks waiting for his ticks, the mail that
 * waits), `filed` (two of them in LifeOS), `failed` (a filing LifeOS did not
 * take), and `loading` and `partial` (the bones; a part that did not load).
 * Dummy people. Rendered by nothing in the app.
 */

const NOW = new Date(2026, 10, 23, 9, 30).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (hour: number, minute = 0, day = 0): number => new Date(2026, 10, 23 + day, hour, minute).getTime();

const FACTS: PrepPage = {
  workspaceId: "preview-prep",
  sector: "purdue",
  event: { id: "ev1", title: "Staff sync", startsAt: at(14), endsAt: at(14, 45), allDay: false, location: "RecWell 204", leaveAt: at(13, 40) },
  people: [
    { name: "Maya Chen", address: "mchen@school.edu", personId: "p1", mail: { id: "m1", subject: "Bracket for Friday", at: NOW - 2 * HOUR, unread: true } },
    { name: "Tom Beck", address: "tbeck@school.edu", personId: "p2", declined: true, mail: { id: "m2", subject: "Re: parking passes", at: NOW - 3 * DAY, unread: false } },
    { name: "Dana Reyes", address: "dreyes@school.edu", personId: "p3" },
    { name: "sam.whitaker@arena.com", address: "sam.whitaker@arena.com" },
  ],
  morePeople: 0,
  tasks: [
    { id: "t1", title: "Send the final seat list", dueAt: NOW + 2 * DAY, why: "asked", who: "Maya Chen" },
    { id: "t2", title: "Signed venue form", why: "waiting", who: "Tom Beck" },
    { id: "t3", title: "Staff handbook update", dueAt: NOW + 9 * DAY },
  ],
  files: [
    { title: "Join", url: "https://school.zoom.us/j/99887766" },
    { title: "Spring LAN run of show", url: "https://docs.google.com/document/d/1AbCdEf/edit" },
  ],
  last: {
    eventId: "ev0",
    title: "Staff sync",
    startsAt: at(14, 0, -7),
    decided: [{ text: "Scrims move to Thursdays from December" }],
    open: [{ text: "Who drives the van to Illinois" }],
    tasks: [{ id: "t9", title: "Order the new jerseys", dueAt: NOW + 4 * DAY }],
  },
  doc: emptyPrepDoc(),
  rev: 0,
  state: "none",
  briefSessionId: null,
  followSessionId: null,
  drafts: [],
  aheadOn: false,
  aheadOffered: false,
  problems: [],
};

/** Most Purdue events: the calendar lists no one, and nothing else is known yet. */
const NOBODY: PrepPage = { ...FACTS, event: { id: "ev2", title: "Budget review", startsAt: at(10, 0, 1), endsAt: at(11, 0, 1), allDay: false, location: "Krach 230" }, people: [], tasks: [], files: [], last: null };

const BRIEF: NonNullable<PrepPage["doc"]["brief"]> = {
  matters: [
    { text: "Maya needs the final seat list by Wednesday, and her bracket still has seeds 5 to 8 unchecked.", ref: { table: "mailThreads", id: "m1" } },
    { text: "Tom declined and still owes the signed venue form; someone else has to carry it today." },
    { text: "Last week left the Illinois van open. Decide who drives before Friday’s scrim." },
  ],
  agreed: [],
  files: [],
  at: NOW - HOUR,
  by: "t-brief",
};
const BRIEFED: PrepPage = { ...FACTS, doc: { ...emptyPrepDoc(), brief: BRIEF }, rev: 2, state: "briefed", briefSessionId: "t-brief", aheadOffered: true };
const PREPARING: PrepPage = { ...FACTS, rev: 1, state: "working", briefSessionId: "t-brief" };

/** The same meeting, an hour after it ended: his notes, what came of them, and the mail that waits. */
const LATER = at(16);
const AFTER: PrepPage = {
  ...FACTS,
  rev: 5,
  state: "after",
  briefSessionId: "t-brief",
  followSessionId: "t-follow",
  doc: {
    ...emptyPrepDoc(),
    brief: BRIEF,
    notes: { text: "Seat list goes to Maya Wed.\nDana drives the van to Illinois, leaves 3:30 Fri.\nJerseys: Tom to confirm sizes with the vendor.\nVenue form still not signed, Tom says Monday.\nNo scrim next week (finals).", at: LATER - HOUR },
    after: {
      summary: [{ text: "The van and the seat list are settled; the venue form is the one thing still open." }],
      decisions: [{ text: "Dana drives the van to Illinois on Friday, leaving at 3:30" }, { text: "No scrim next week, for finals" }],
      questions: [{ text: "When the venue form is signed" }],
      tasks: [
        { id: "s1", title: "Send Maya the final seat list", due: at(9, 0, 2), state: "proposed" },
        { id: "s2", title: "Confirm jersey sizes with the vendor", who: "Tom Beck", state: "proposed" },
        { id: "s3", title: "Get the venue form signed", who: "Tom Beck", due: at(9, 0, 7), state: "proposed" },
      ],
      at: LATER - 600_000,
    },
  },
  drafts: [{ outboxId: "ob1", subject: "Staff sync follow-up", to: ["Maya Chen", "Tom Beck"] }],
};
const FILED: PrepPage = {
  ...AFTER,
  rev: 6,
  doc: { ...AFTER.doc, after: { ...AFTER.doc.after!, tasks: AFTER.doc.after!.tasks.map((t, i) => (i < 2 ? { ...t, state: "filed" as const, lifeosTaskId: `task${i}` } : t)) } },
};

const none = () => {};
const verbs = { thread: false, again: false, notes: false, rest: 0, ahead: null, onBrief: none, onFollowUp: none, onOpenThread: none, onNotes: none, onAddPeople: none, onThread: none, onDismissRest: none, onAhead: none } as const;

function Frame({ title, head, children }: { title: string | undefined; head?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex w-[864px] max-w-full flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-[13px]">
        <Calendar className="size-3.5 text-muted-foreground" />
        <BackTitle name={title} onBack={none} />
        <span className="flex-1" />
        {head}
      </div>
      {children}
    </div>
  );
}

export function PrepPreview({ state = "facts" }: { state?: string }) {
  if (state === "loading")
    return (
      <Frame title={undefined}>
        <PrepSkeleton />
      </Frame>
    );
  const after = state === "after" || state === "filed" || state === "failed";
  const page =
    state === "nobody" ? NOBODY : state === "partial" ? { ...FACTS, tasks: [], problems: ["tasks" as const] } : state === "preparing" ? PREPARING : state === "briefed" ? BRIEFED : state === "filed" ? FILED : after ? AFTER : FACTS;
  const now = after ? LATER : NOW;
  const verb = headVerb(page, now, { brief: state === "preparing" ? "running" : "idle", follow: "idle" });
  return (
    <Frame
      title={page.event.title}
      head={<PageVerbs {...verbs} verb={verb} thread={!!page.briefSessionId} again={state === "briefed"} notes={after} rest={after ? 3 : 0} ahead={page.aheadOffered ? page.aheadOn : null} />}
    >
      <PrepPageBody
        page={page}
        faces={new Map()}
        now={now}
        verb={verb}
        offer={state === "briefed"}
        onRetry={none}
        onAddPeople={none}
        {...(state === "failed" ? { failedAtFirst: [{ id: "s3", error: "LifeOS did not answer" }] } : {})}
      />
    </Frame>
  );
}
