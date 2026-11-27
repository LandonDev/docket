import { BackTitle } from "../shell/BackTitle";
import type { ReactNode } from "react";
import type { GuestLinkRow } from "@shared/contract-work-guests";
import { Users } from "../../chrome/icons";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { boxSilent, JOB, standUpView, Unsettled, ViewAt } from "../kit.preview";
import { WORK_VIEWS } from "../views/registry";
import { PageVerbs, PeopleList, PersonPageBody, setPlace, View } from "./PeopleView";
import type { DirectoryPerson, PersonPage } from "./model";

/**
 * The People view over fixed data, for `bun run ui:preview
 * src/renderer/src/work/people/PeopleView.preview.tsx#PeoplePreview --props '{"state":"list"}'`:
 * `list` (the sector's people, newest contact first), `page` (one person with
 * something of every kind), `quiet` (a person with nothing live) and
 * `page-silent` (a person's page kept from a visit before, the box silent on its
 * LifeOS status: the frame's one line, nothing under it), and `loading` and
 * `page-loading` (the list and a page while LifeOS connects: their bones). Rendered by nothing in
 * the app.
 */

const NOW = new Date(2026, 10, 19, 15, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const PEOPLE: DirectoryPerson[] = [
  { _id: "p1", name: "Maya Chen", emails: ["mchen@school.edu"], lastAt: NOW - 2 * HOUR },
  { _id: "p2", name: "Dana Ortiz", emails: ["dortiz@school.edu"], lastAt: NOW - DAY },
  { _id: "p3", name: "Sam Whitaker", emails: ["sam.whitaker@arena.com"], lastAt: NOW - 3 * DAY },
  { _id: "p4", name: "Priya Raman", emails: ["praman@school.edu"], lastAt: NOW - 12 * DAY },
  { _id: "p5", name: "Front desk", emails: ["frontdesk@school.edu"], lastAt: NOW - 40 * DAY },
  { _id: "p6", name: "Tom Beck", emails: [] },
];

const PAGE: PersonPage = {
  person: { _id: "p1", name: "Maya Chen", notes: "Runs the front desk at the arena. Prefers mail to calls; out Fridays.", sectors: ["purdue"], emails: ["mchen@school.edu"], phones: ["(765) 555-0142"] },
  lastAt: NOW - 2 * HOUR,
  mail: [
    { _id: "m1", subject: "Bracket for Friday", snippet: "Here is the bracket with the late entries folded in. Can you check seeds 5 to 8?", lastMessageAt: NOW - 2 * HOUR, unread: true },
    { _id: "m2", subject: "Ballroom hold", snippet: "They can hold the ballroom until Tuesday noon, then it goes to the next booking.", lastMessageAt: NOW - 2 * DAY, unread: false },
    { _id: "m3", subject: "Re: parking passes", snippet: "Thanks, all twelve came through.", lastMessageAt: NOW - 9 * DAY, unread: false },
  ],
  coming: [{ _id: "e1", title: "Tryouts walkthrough", startsAt: NOW + DAY + 2 * HOUR, location: "Arena, room 204" }],
  recent: [{ _id: "e2", title: "Spring LAN planning", startsAt: NOW - 6 * DAY, location: "Union 118" }],
  tasks: [
    { _id: "t1", title: "Send the final seat list", status: "todo", dueAt: NOW + 2 * DAY, relation: "asked" },
    { _id: "t2", title: "Signed venue form", status: "waiting", relation: "waiting" },
  ],
  shared: [
    { table: "docs", id: "d1", title: "Spring LAN run of show" },
    { table: "sheets", id: "s1", title: "Seat plan" },
  ],
};
const LINKS: GuestLinkRow[] = [
  { id: "g1", name: "Maya Chen", source: { at: "lifeos", table: "docs", id: "d1" }, title: "Spring LAN run of show", role: "comment", createdAt: NOW - DAY, expiresAt: NOW + 14 * DAY, revokedAt: null, by: "owner", lastOpenedAt: null, open: 0 },
  { id: "g2", name: "Maya Chen", source: { at: "lifeos", table: "sheets", id: "s1" }, title: "Seat plan", role: "view", createdAt: NOW - DAY, expiresAt: NOW + 30 * DAY, revokedAt: null, by: "owner", lastOpenedAt: null, open: 0 },
];
const QUIET: PersonPage = { ...PAGE, person: { ...PAGE.person, name: "Tom Beck", notes: "", emails: [], phones: [] }, mail: [], coming: [], recent: [], tasks: [], shared: [] };

const NO_FACES = new Map<string, string>();
const workspace = { id: "preview-people", environmentId: "box" } as WorkspaceMeta;
const none = () => {};

function Frame({ title, head, children }: { title: ReactNode; head?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex w-full flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-[13px]">
        <Users className="size-3.5 text-muted-foreground" />
        {title}
        <span className="flex-1" />
        {head}
      </div>
      {children}
    </div>
  );
}

/**
 * `page-silent` stands its view up before the page draws, the chunk landed and the workspace listed: a static render
 * reads the page once, so its body is never the chunk's loading rows. The other states draw their parts alone, on
 * another workspace, and read none of it.
 */
async function standUpSilent(): Promise<void> {
  standUpView("people", { "people:directory": PEOPLE, "mail:faces": [], "people:page": PAGE }, (method) => (method === "work.guests.list" ? [] : undefined));
  setPlace(JOB.id, { person: "p1" });
  boxSilent();
  await WORK_VIEWS.people.chunk.load();
  await new Promise((done) => setTimeout(done, 50));
}
await standUpSilent();

export function PeoplePreview({ state = "list" }: { state?: string }) {
  if (state === "page-silent")
    return (
      <>
        <ViewAt view="people" height={360} />
        {/* The view's body lands after React's hold on a fallback: the page waits for it. */}
        <Unsettled ms={500} />
      </>
    );
  if (state === "page" || state === "quiet") {
    const page = state === "page" ? PAGE : QUIET;
    return (
      <Frame title={<BackTitle back="People" name={page.person.name} onBack={none} />} head={<PageVerbs canWrite={page.person.emails.length > 0} onWrite={none} onThread={none} />}>
        <PersonPageBody workspace={workspace} startThread={none} faces={NO_FACES} page={page} links={state === "page" ? LINKS : []} now={NOW} />
      </Frame>
    );
  }
  if (state === "loading" || state === "page-loading") {
    setPlace(workspace.id, { person: state === "page-loading" ? "p1" : null, query: "" });
    return (
      <Frame title={<span className="font-medium text-foreground">People</span>}>
        <View env="box" workspace={workspace} sector="purdue" lifeos={{ environmentId: "box", sector: "purdue", client: null, state: "connecting" }} startThread={none} />
      </Frame>
    );
  }
  setPlace(workspace.id, { person: null, query: "" });
  return (
    <Frame title={<span className="font-medium text-foreground">People</span>}>
      <PeopleList workspaceId={workspace.id} rows={PEOPLE} faces={NO_FACES} now={NOW} />
    </Frame>
  );
}
