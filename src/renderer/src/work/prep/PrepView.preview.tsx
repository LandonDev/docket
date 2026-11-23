import type { ReactNode } from "react";
import { emptyPrepDoc, type PrepPage } from "@shared/contract-work-prep";
import { Calendar } from "../icons";
import { BackTitle, PageVerbs, PrepPageBody, PrepSkeleton } from "./PrepView";

/**
 * A meeting's page over fixed data, for `bun run ui:preview
 * src/renderer/src/work/prep/PrepView.preview.tsx#PrepPreview --props '{"state":"facts"}' --shot`:
 * `facts` (the page with no brief: people, tasks, files, last time), `nobody`
 * (a calendar that lists no attendees), `loading` (the bones) and `failed`
 * (a part that did not load). Dummy people. Rendered by nothing in the app.
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

const none = () => {};

function Frame({ title, children }: { title: string | undefined; children: ReactNode }) {
  return (
    <div className="flex w-full max-w-[864px] flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-[13px]">
        <Calendar className="size-3.5 text-muted-foreground" />
        <BackTitle name={title} onBack={none} />
        <span className="flex-1" />
        {title ? <PageVerbs onAddPeople={none} onThread={none} /> : null}
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
  const page = state === "nobody" ? NOBODY : state === "failed" ? { ...FACTS, tasks: [], problems: ["tasks" as const] } : FACTS;
  return (
    <Frame title={page.event.title}>
      <PrepPageBody page={page} faces={new Map()} now={NOW} onRetry={none} onAddPeople={none} />
    </Frame>
  );
}
