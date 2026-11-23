import type { ReactNode } from "react";
import { emptyPrepDoc, type PrepPage } from "@shared/contract-work-prep";
import { Calendar } from "../icons";
import { headVerb } from "./model";
import { X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import type { DirectoryPerson } from "../people/model";
import { NotesForm, PeopleForm } from "./PrepDialogs";
import { BackTitle, PageVerbs, PrepPageBody, PrepSkeleton } from "./PrepView";

/**
 * A meeting's page over fixed data, for `bun run ui:preview
 * src/renderer/src/work/prep/PrepView.preview.tsx#PrepPreview --props '{"state":"facts"}' --shot`:
 * `facts` (the page with no brief: people, tasks, files, last time), `nobody`
 * (a calendar that lists no attendees), `preparing` (a brief thread at work),
 * `briefed` (the brief, with the one-time offer under it), `after` (his notes
 * and what came of them, the tasks waiting for his ticks, the mail that
 * waits), `after-ticked` (two ticked, the one button counting them), `filed`
 * (two of them in LifeOS), `failed` (a filing LifeOS did not
 * take), `recording` (the notes are a recording its thread is still reading),
 * and `loading` and `partial` (the bones; a part that did not load). The two
 * dialogs' insides stand still in a panel drawn as the app's: `notes`,
 * `notes-typed`, `notes-uploading`, `notes-failed`, `people`, `people-typed`,
 * `people-loading`.
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
  invited: ["mchen@school.edu", "tbeck@school.edu", "dreyes@school.edu", "sam.whitaker@arena.com"],
  tasks: [
    { id: "t1", title: "Send the final seat list", dueAt: NOW + 2 * DAY, why: "asked", who: "Maya Chen" },
    { id: "t2", title: "Signed venue form", why: "waiting", who: "Tom Beck" },
    { id: "t3", title: "Staff handbook update", dueAt: NOW + 9 * DAY },
  ],
  files: [
    { title: "Join the call", url: "https://school.zoom.us/j/99887766" },
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
  briefUntil: null,
  followUntil: null,
  briefStartedAt: null,
  followStartedAt: null,
  drafts: [],
  notesFile: null,
  aheadOn: false,
  aheadOffered: false,
  problems: [],
};

/** Most Purdue events: the calendar lists no one, and nothing else is known yet. */
const NOBODY: PrepPage = { ...FACTS, event: { id: "ev2", title: "Budget review", startsAt: at(10, 0, 1), endsAt: at(11, 0, 1), allDay: false, location: "Krach 230" }, people: [], invited: [], tasks: [], files: [], last: null };

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
const PREPARING: PrepPage = { ...FACTS, rev: 1, state: "working", briefSessionId: "t-brief", briefUntil: NOW + 600_000 };

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
    notes: { text: "Seat list goes to Maya Wed.\nDana drives the van to Illinois, leaves 3:30 Fri.\nJerseys: Tom to confirm sizes with the vendor.\nBallroom for the spring LAN: hold runs out Tuesday, nobody decided.\nNo scrim next week (finals).", at: LATER - HOUR },
    after: {
      summary: [{ text: "The van and the seat list are settled. The ballroom for the spring LAN is still to decide." }],
      decisions: [{ text: "Dana drives the van to Illinois on Friday, leaving at 3:30" }, { text: "No scrim next week, for finals" }],
      questions: [{ text: "Whether the spring LAN keeps the ballroom" }],
      tasks: [
        { id: "s1", title: "Book the van for Friday", due: at(9, 0, 2), state: "proposed" },
        { id: "s2", title: "Confirm jersey sizes with the vendor", who: "Tom Beck", state: "proposed" },
        { id: "s3", title: "Tell the team there is no scrim next week", who: "Dana Reyes", due: at(9, 0, 7), state: "proposed" },
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

/** The notes are a recording: it is named on the page and opens beside its thread, while the thread still reads it. */
const RECORDED: PrepPage = { ...FACTS, rev: 3, state: "after", followSessionId: "t-follow", doc: { ...emptyPrepDoc(), notes: { text: "", at: LATER - 300_000, meetingItemId: "it1" } }, notesFile: { kind: "meeting", itemId: "it1", title: "Staff sync 2026-11-23.m4a" } };

/** The same recording once this host could not read it: the row says why, and the header asks for notes again at once, though its thread is still saying so. */
const UNREAD: PrepPage = { ...RECORDED, notesFile: { ...RECORDED.notesFile!, error: "The transcriber is not installed on this host." } };

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

/**
 * A dialog's panel as `ModalPanel` draws it (chrome/Modal.tsx: the popover fill, 16px corners, the title on the 16px
 * recipe, the close), standing still on the page: a dialog is a portal, which a static render does not draw.
 */
function DialogFrame({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className="flex w-[864px] max-w-full justify-center bg-background p-8">
      <div role="dialog" aria-label={title} className={`flex w-full flex-col rounded-2xl bg-popover text-sm leading-[22px] text-popover-foreground shadow-overlay ring-1 ring-border ${wide ? "max-w-xl" : "max-w-md"}`}>
        <header className="flex shrink-0 items-start gap-2 px-5 pt-5">
          <h2 className="min-w-0 flex-1 text-base leading-6 font-semibold tracking-[-0.01em] text-balance">{title}</h2>
          <Button variant="ghost" size="icon-sm" aria-label="Close" className="-me-1 -mt-0.5 text-muted-foreground">
            <X />
          </Button>
        </header>
        {children}
      </div>
    </div>
  );
}

const DIRECTORY: DirectoryPerson[] = [
  { _id: "p1", name: "Maya Chen", emails: ["mchen@school.edu"] },
  { _id: "p3", name: "Dana Reyes", emails: ["dreyes@school.edu"] },
  { _id: "p4", name: "Sam Whitaker", emails: ["sam.whitaker@arena.com"] },
  { _id: "p5", name: "Priya Raman", emails: ["praman@school.edu"] },
  { _id: "p6", name: "Front desk", emails: ["frontdesk@school.edu"] },
];
const NOTES_TYPED = "Seat list goes to Maya Wed.\nDana drives the van to Illinois, leaves 3:30 Fri.\nJerseys: Tom to confirm sizes with the vendor.";

/** The two dialogs' insides, each in the states a picture can hold. */
function DialogPreview({ state }: { state: string }) {
  if (state.startsWith("people")) {
    // The meeting with no one on it, one person already added: she leads the list, ticked.
    const page: PrepPage = { ...NOBODY, doc: { ...emptyPrepDoc(), people: [{ name: "Dana Reyes", address: "dreyes@school.edu", personId: "p3" }] } };
    return (
      <DialogFrame title="Add people">
        <PeopleForm
          env="box"
          page={page}
          faces={new Map()}
          directory={state === "people-loading" ? { status: "loading" } : { status: "ready", value: DIRECTORY }}
          search={state === "people-typed" ? "Jordan Ellis" : ""}
          pending={false}
          setPending={none}
          onClose={none}
        />
      </DialogFrame>
    );
  }
  const upload = state === "notes-uploading" ? { name: "Staff sync 2026-11-23.m4a", progress: { sent: 21, total: 50 } } : null;
  return (
    <DialogFrame title="Notes" wide>
      <NotesForm
        text={state === "notes" ? "" : NOTES_TYPED}
        setText={none}
        pending={upload ? "follow" : null}
        upload={upload}
        error={state === "notes-failed" ? "The transcriber is not installed on this host." : null}
        onCancel={none}
        onClose={none}
        onFollowUp={none}
        onFile={none}
        onDocument={none}
      />
    </DialogFrame>
  );
}

export function PrepPreview({ state = "facts" }: { state?: string }) {
  if (state.startsWith("notes") || state.startsWith("people")) return <DialogPreview state={state} />;
  if (state === "loading")
    return (
      <Frame title={undefined}>
        <PrepSkeleton />
      </Frame>
    );
  const after = state === "after" || state === "after-ticked" || state === "filed" || state === "failed" || state.startsWith("recording");
  const page =
    state === "recording" ? RECORDED : state === "recording-failed" ? UNREAD : state === "nobody" ? NOBODY : state === "partial" ? { ...FACTS, tasks: [], problems: ["tasks" as const] } : state === "preparing" ? PREPARING : state === "briefed" ? BRIEFED : state === "filed" ? FILED : after ? AFTER : FACTS;
  const now = after ? LATER : NOW;
  const verb = headVerb(page, now, { brief: state === "preparing" ? "running" : "idle", follow: state.startsWith("recording") ? "running" : "idle" });
  return (
    <Frame
      title={page.event.title}
      head={<PageVerbs {...verbs} verb={verb} thread={!!page.briefSessionId} again={state === "briefed"} notes={after} rest={page.doc.after ? 3 : 0} ahead={page.aheadOffered ? page.aheadOn : null} />}
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
        {...(state === "after-ticked" ? { tickedAtFirst: ["s1", "s2"] } : {})}
      />
    </Frame>
  );
}
