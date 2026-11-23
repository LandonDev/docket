# Work: people

A page for each person in a linked Work workspace's sector: who they are, then what is live with them there. The store is LifeOS's people (with their addresses and pictures); the two queries that read it for Work are LifeOS's `people:directory` and `people:page` (LifeOS main cabe091, `packages/backend/convex/people.ts`). This file is TempCode's side. The landing note is `.temp-code/plans/landed/F-people.md`.

## The People view

`src/renderer/src/work/people/`, registered by `view.ts` (`WORK_VIEWS.people`, between Agenda and Docs, no trailing fact) as the lazy chunk `work-people-view`. It reads LifeOS on the workspace's own session (a JWT narrowed to the sector), so LifeOS's fence holds whatever the screen asks.

- **The list**: `people:directory {sector}`, the sector's people with their addresses, newest contact first (`lastAt`: the newest message from any of their addresses the session may read), then by name. One 32px row each: the face, the name, the first address muted, when they were last heard from. The header's search (`/` focuses it) keeps the people every typed word is in, by name or address, folded for case and accents (`findPeople`).
- **A person's page**: `people:page {id, sector, shared}`. The 40px header's title is the way back (`BackTitle`: the arrow, "People", their name muted), its controls Write and New thread (`PageVerbs`). The body, in a 720px column: the 40px face, the name as the page's title, their addresses and numbers as one comma line, their notes; then one section for each kind that has something, in this order: Mail, Coming up, Asked for by them, Waiting on them, Shared with them, Earlier. A section with nothing is not drawn; a page with nothing live says so in one line. Each fact is shown once: a task sits under the relation that names it, never with a word repeating it.
- **Where a row opens**: a mail in the Mail view's reader (`openWorkView {mail}`), an event in Agenda on its week (`{event}`), a task in the Tasks view's sheet (`{task}`, new for Tasks), a document in a Files tab of its own (`openDocInFiles`, work/files/openFrom.ts), a project in Projects (`{project}`), a sheet in a new thread about it.
- **Shared with them** is the guest links made for them (work-guests.md): the host's `work.guests.list`, the live links whose guest name is the person's name, folded (`linksFor`), are asked of LifeOS as `shared`, which answers those of this sector with their titles now. The page waits for the links before it draws, so it lands once. A row's second line is what the link lets them do and until when.
- **The face** is Mail's one face (`work/mail/face.tsx`, moved out of the mail kit so People need not load the mail client): the picture LifeOS holds for an address (`mail:faces`, the first of their addresses that has one), else initials; 24px in the list, 40px (`page`) on the page.
- **Write** opens the Mail view with a new mail to their first address (`work/mail/mailto.ts`: the mail kit's `onMailto`, heard by the newest mailbox; one asked for before a mailbox listens waits for the next). The composer is Mail's own and its send is held as always. Nothing in People sends.
- **New thread** starts a thread about them with the person chip the composer's `@` makes.

Where he stands (the list or a person, and the search) is kept a workspace for the window's life (`placeOf`, `setPlace`).

## The ways in

- **Mail**: work-kit v51's `MailKit.openPerson`: in the reader, an open message's sender (name and face) and each known person in its Details (From, To, Cc) is pressable when the address is one of the sector's people. TempCode's kit opens People on that address (`openWorkView {view: 'people', person: <address>}`), in the open view's workspace, else the active thread's. People reads the address against the list; an address no one there has is put in the search.
- **Agenda**: a List row names the event's attendees who are the sector's people ("With Maya Chen, Tom Beck, and 2 more", `knownAttendees`), each name a button to their page. Week and Month are work-kit's and draw no attendees.
- **A sent person chip** opens their page (`openerOf` in work/canvas/SentChips.tsx).

## For agents

- **`person_page {person, sector?}`** (`work/lifeos/people.ts`, a tool of the lifeos pillar, read-only): the same page as words, read as the owner and bounded to the thread's sector, which is its fence (work-scope.md). A person is named by id, address, whole name or the words of a name; several matches are listed by id. A Work Chat, which reads every sector, names one; a workspace's thread may name only its own. The guest links it asks about are this host's (`work_guest_links`): the box keeps them, so a thread on the Mac sees none. It prints no "last heard from": read as the owner, that time may be another sector's.
- **`@`** finds a person by name through LifeOS's kinds (`lifeos/mentions.ts`, already there): kept when any of their sectors is in reach.

## Purdue

The page and the tool read nothing a thread of that sector cannot already read with its own LifeOS key (`get_person`, `list_tasks`, `list_mail`), and copy nothing to the box: LifeOS already runs there.

## Tests

- Host: `work/lifeos/people.test.ts` (who it finds, the sector fence, the links it asks about, the words).
- Renderer: `work/people/people.test.ts` (search, faces, the links named for a person, attendees, Write's port), `work/people/PeopleView.dom.test.tsx` (the list, the page's sections and verbs, where each row opens, the ways in), `work/agenda/AgendaPeople.dom.test.tsx`, and the new target cases in `tasks/TasksView.dom.test.tsx`.
- LifeOS: `test/behaviour/people.test.ts`, `test/fence/public/people.ts`. work-kit: `src/mail/person.jsdom.tsx`.
- Look: `bun run ui:preview src/renderer/src/work/people/PeopleView.preview.tsx#PeoplePreview --props '{"state":"page"}' --shot` (`list`, `page`, `quiet`).
