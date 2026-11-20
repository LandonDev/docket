# Work: guest links

One named person outside lets themselves into one LifeOS document or sheet
on a web page, with no sign-in, to view, comment or edit, until the link
ends or the owner revokes it; or into one LifeOS project, to view ("A
project's link" below). Milestone 31 built it; the approved page is
`.temp-code/prototypes/work-workspaces-2/guest.html`, and docs/DESIGN.md
("History and Share", "The guest's page") holds the look. This is the one
place people outside reach the owner's data: every rule below is a check
with a test.

## A link

- **A row on the host that serves LifeOS's documents** (the box):
  `work_guest_links` (guests/store.ts) holds the id, the SHA-256 of the
  secret, the guest's name, the item (`{at: 'lifeos', table: 'docs' | 'sheets' | 'projects', id}`),
  its title, the role, when it was made, when it ends, when it was revoked,
  and the thread whose request his press granted (none for his own). The
  secret is 32 random bytes, shown once, in the address's fragment:
  `https://tempcode.landonhale.com/g/<id>#k=<secret>`. No request, log or
  row holds it. A Mac-hosted workspace's LifeOS items are shared from the box
  as well (§19); any other host answers `served elsewhere: <env>` and the
  client asks that one (renderer/work/guests/api.ts).
- **Roles.** `view` reads. `comment` reads, comments on words it selects and
  replies; the service makes the comment and marks the words. `edit` writes
  the document or the sheet's cells live. A sheet's link is `view` or `edit`
  (sheets keep no comments); a project's is `view`. Files are not shared:
  Share on a `.tcdoc` or an opened file says "Move it to LifeOS to share it."
- **Ends** thirty days out unless he picks (1, 7, 30 or 90 days in the
  dialog; an hour to a year on the wire). An ended or revoked link stays in
  the lists a week, muted.
- **Shared.** While any live link names an item, its LifeOS row's `shared`
  is on (`docs:setShared`, `sheets:setShared`); revoking the last link, or
  its end passing, turns it off within 30 s. A link goes live only once
  LifeOS has taken its item's `shared`: if it does not, the link is not made
  (the held act fails as not sent), and a live link whose item LifeOS has not
  marked since a start stays out of what the service is told until a tick
  marks it. Agents' writes to a shared item
  become suggestions, as for any shared item.

## The methods and the tools

`src/shared/contract-work-guests.ts`:

| Method | Cap | What |
|---|---|---|
| `work.guests.list {}` | read | every listed link, live first, with when the service last saw each opened and how many sockets it holds |
| `work.guests.forItem {source}` | read | one item's links, for its Share popover |
| `work.guests.create {source, title, name, role, expiresAt}` | approve | his own link; answers `{link, url}`, the only time the address exists |
| `work.guests.rekey {linkId}` | approve | a new address for a live link, shown once; the one before opens nothing from then on |
| `work.guests.revoke {linkId}` | operate | at once |
| `work.guests.ticket {source, title}` | operate | the owner's hosted editor (below) |

A thread's call to any but the two reads is refused: an agent asks with
`guest_link {docId | sheetId | projectId, name, role, days}`, which checks the item is in
the thread's sector and holds a `share.guestLink` act (no matcher, so no
grant fits and Away releases none). His Create link in the Outbox makes the
link and resumes the thread with the link's id, never its address: he sends
the address himself, copied from Settings → Work → Guest links. The act's Result's way back is Revoke link:
`guest_link_revoke {linkId}`, which revokes only a link the same thread
tree asked for. The preamble tells Work threads that sending one of his
documents means sending such a link.

## A project's link

A link's item may be a LifeOS project (`table: 'projects'`): one named
guest views the project until the link ends. It is made from Share on the
project's bar or in its settings, or asked for by an agent with
`guest_link {projectId, name, days}`, held as any other.

- **What the guest gets** is LifeOS's `projects:guestView`, the one place
  the cut is made: the project's name, state and description, its figures,
  its tasks that are not dropped (title, state, priority, due date, notes,
  place in the tree) and its LifeOS documents and sheets by title. Main
  reads the answer back key by key (`src/shared/work/guestProjection.ts`,
  `guestProjectionOf`, with `GUEST_PROJECTION_KEYS` naming every key that
  may pass) and sends nothing else on.
- **What the guest never gets**: a comment, a history line, whom a task
  waits on, where a task came from, a thread, an agent, another project, a
  markdown note, a link, a file or a linked item; and no route that writes.
- **A document is its text, never its room.** A document's own link joins
  the document's live room, whose state keeps the words that were deleted
  and the marks of his comments, and carries every reader's caret. A guest
  of a whole project is shown none of that: the service reads the
  document as it stands (`collab.read`) and hands its markdown; main signs
  no token for a document of a project's link and the link has no document
  socket. A sheet keeps its socket (a sheet's state holds no history), on
  a view token.
- **Main** (`guests/links.ts`) keeps one live `projects:guestView` for
  each project a live link shows (`watch`), and tells the service each
  link's projection in a message of its own (`supervisor.setProject`,
  `{t: 'project', linkId, project}`; never inside `setLinks`), with a view
  token for each sheet the projection lists, signed for that link and that
  sheet (`principal: guest:<id>`, `link`, ten minutes, signed again with
  five left). The supervisor keeps the last one for each link, so a
  service started again is told them again. While LifeOS has been out of
  reach a minute (`STALE_VIEW_MS`) the read may be old, so the projection
  is taken away until LifeOS answers: the page is told to try again and
  the link's sheets close. A project LifeOS no longer has ends its links
  (`endIfGone`).
- **Shared marks.** The Work service judges an agent's document write by
  the LifeOS row's own `shared`. So a project's link marks the project
  (`projects:setShared`, which LifeOS answers `guestView` only after) and
  every document and sheet its projection lists, the description's
  document among them (`docs:setShared`, `sheets:setShared`). `settle`
  keeps them in step, one run at a time: the service first, so what left
  is handed no more before its mark comes off; then the marks
  (`reconcile`); then the service again, so a document that joined is
  sent only once LifeOS reads it shared. `reconcile` tells projects first
  and then tells every document a live link shows again, because LifeOS
  marks a project's description with the project, both ways, and says
  nothing of it; and it never takes a mark off a row the service was last
  sent, so a read that changed while the list was being signed waits for
  the next pass. A new link's own mark takes its turn with the passes
  (`inTurn`). A revoke goes to the service at once, ahead of any pass that
  waits on LifeOS. A mark comes off when no live link shows the row, a
  document with a link of its own keeps it, and the rows this host marked
  are kept in `work_guest_marks`, so what an ended link showed is still
  unmarked after a restart. An agent's write through `/internal/doc/write`
  to such a document is a suggestion; an agent's task writes show at once
  (decision 7 of the projects plan).
- **The service** (`service/routes/guests.ts`, `serve.ts`):

  | Route | What |
  |---|---|
  | `POST /g/<id>/open {secret}` | the link's facts and the projection; no token. 503 until the projection has landed, and while it is taken away |
  | `POST /g/<id>/item {secret, table, id}` | one document or sheet the projection lists: a document's markdown as it stands, a sheet's view token. Anything else answers 403 `gone`, as an unknown link does |
  | `GET /g/ws/<id>/sheets/<sheet>` | that sheet's socket, read only, while the projection lists it; it takes only a token of the link its address names. The link's bare socket and any other path answer 404 |

  `claimLive` is the one check of a guest's token on every route: its link
  stands, and for a project's link the token is a sheet's and the
  projection still lists that sheet. It runs in the collab verifier (so a
  project link's token opens no document's room on any route), in the
  sheet route's hello and its every-second look, and when a projection or
  the list changes: a sheet that leaves the project, a revoke and an end
  all close the sheet's sockets within a second, and a document is handed
  no more from that moment. A project link's token opens neither
  `/threads` nor `/comment`.
- **The page** (`src/hosted/guest/ProjectPage.tsx`): the shared project
  screens (work-kit/projects) on work-kit's read-only client
  (`createGuestProjectsClient`), which says no to every right, so no
  control is drawn and Activity is left out. The page line holds the
  screens' List or Board switch; there is no way back to a list of
  projects. It asks `/open` again every 15 seconds and when the window
  comes forward, so a task an agent changed shows then, and so does a
  revoke ("This link no longer opens anything"). The description is its
  document's text (`Session.child`, read again with each of the project's
  reads), with the stored lead until it comes. A document or sheet opens
  in place (`ChildPage` in GuestApp.tsx) with the way back in the line: a
  document as text (`DocText`), read again every 15 seconds; one the
  project no longer lists is closed at the page's next read, and a link
  that ended shows the end.
- **The owner's hosted editor** has no project: `work.guests.ticket`
  refuses one.

## Main and the service

The Work service is the internet-facing process and holds no signing key.
Main tells it every live link and every open ticket through
`supervisor.setLinks` (guests/links.ts `sync`; the extra fields on
`ServiceLink` are typed in guests/wire.ts): the secret's hash, the guest's
and the owner's names, the title, and a collab token main signed for the
link's item (`principal: guest:<id>`, `link: <id>`, no file path, ten
minutes, signed again with five left on a 30 s tick). A revoked or ended
link is not sent, so the service no longer knows it: its document sockets
close at once (`collab.closeWhere`), its sheet sockets at the sheet route's
next second, and every route answers it as gone.

## The routes

On the public listener (service/routes/guests.ts, item.ts). Callers are
told apart by `CF-Connecting-IP`, else the peer address.

| Route | What |
|---|---|
| `GET /g/<id>` | the page, the same bytes for any well-formed id |
| `POST /g/<id>/open {secret}` | the link's facts and its current token; a wrong secret, an unknown, ended or revoked link all answer 403 `gone` |
| `GET /g/ws/<id>` | the item's socket, bound to the link's item whatever the client names; the token is still checked inside (Hocuspocus for a document, the sheet route's hello for a sheet) |
| `GET /g/<id>/threads` | a document's comments, `Authorization: Bearer <token>`; authors other than the owner and this guest are named, not identified |
| `POST /g/<id>/comment` | `{quote, text}` or `{threadId, text}`, bearer; plain words only, 4,000 at most, built into the comment by the service; a reply only on a thread of this document |
| internal `/internal/guests/seen` | for the audit list: when each link was last opened, and its open sockets |

Limits: 240 requests a minute per caller; ten failed secrets or tickets per
caller in ten minutes, then every open from there is refused for the rest
of the window, the right secret too; 20 comments a minute per link. A POST
whose `Origin` is another host is refused. The page and every hosted asset
carry `HOSTED_CSP` (scripts and connections to its own origin only, never
framed). A view link's document socket is read only (Hocuspocus drops its
updates); a comment link's too. A sheet guest is held to `GUEST_OPS`
(values, number formats, up to 1,000 rows or columns inserted or removed)
and `guestCells` keeps a cell's value, formula, style and type only.
Nothing on these routes links to `/w/full/` or mints a full-editor token.

An edit link's guest leaving a document cuts a `guest-end` version.
History and the document's comments name a guest by their link's name
(`guestNameOf`).

## The page

`src/hosted/guest/` (built into `out/hosted/guest`, served at `/g/<id>` and
`/w/open`): one 44px line (the item's glyph and name, whose it is, "Can
edit", "until Dec 18", the guest's initials), then the owner's own editor
(work-kit/editor) or grid (work-kit/sheet) on the app's own tokens, light or
dark by the browser's setting. What a link may not do is not drawn. A comment
link gets its own small bar over selected words, since the editor draws none
on a text it only reads. The page asks the service again with every token
the editor asks for, so a revoked link's page says "This link no longer opens
anything" within about a second and a half. The other states: too many
tries, cannot be reached (Try again), loading bones. The sheet sends one
batch of its own `sheet.mutation.*` ops at a time from the acknowledged
revision, typed text as plain values.

## The owner's hosted editor

For the phone (milestones 46, 47): `work.guests.ticket` answers
`https://tempcode.landonhale.com/w/open#t=<ticket>`. The ticket opens once,
within two minutes (`POST /w/open/redeem`); the service then makes a renewal
key it keeps in memory, the page keeps it in the tab's session storage, and
`POST /w/open/renew` hands a fresh owner token for that item while main keeps
the pass (eight hours, in memory: a restart of main or the service ends
it). The item opens on its own route (`/w/doc/<id>`, `/w/sheet/<id>`) with
the owner's token; the ticket leaves the address once used.

The phone (milestone 47) asks a ticket each time it shows a LifeOS document
or sheet in a thread's Item segment and loads the address in a WKWebView
with a store of its own that keeps nothing (`.nonPersistent()`), so each
open is a new pass. Make a Guest Link in the item's More calls
`work.guests.create` (approve) and shows the address once.

## The screens

- **Share** on a document's and a sheet's bar (`guests/Share.tsx`, mounted
  from each kind's `Bar`): a 320px popover of the item's live links (initials,
  name, role and end; Revoke on hover), "Only you can open this" with none,
  and New guest link…, one dialog: For, Can, Ends; Create link shows the
  address once with Copy. A project has the same on its page's bar
  (`ProjectShare`, the Projects view's `kit.share`) and under Sharing in
  its settings sheet (`ProjectSharing`); its dialog has no Can row.
- **The held request** in the Outbox (`ShareActView.tsx`): To, For, Can, Ends.
- **Guest links** in Settings → Work (`GuestLinksSection.tsx`): every link on
  every Work host, live first: who, the role and item (a project's as
  "Spring LAN project"), until when, and "in it now", "opened …" or "not
  opened yet"; Copy new address
  (`work.guests.rekey`) and Revoke. Ended ones muted.

## Proofs

- `guests/projectLinks.test.ts`: a project's link end to end in process:
  the cut's allowed keys, the marks and their order, the item route and
  the two sockets, a document leaving and joining, revoke and expiry inside
  a second, the marks after a restart, an agent's write as a suggestion,
  the held request. `service/ctx.test.ts`: a restarted service is told each
  projection again. `hosted/guest/ProjectPage.dom.test.tsx`: the page draws
  no control. `guests/projectLinks.live.proof.test.ts` (opt-in,
  `P7_PROOF=1 P7_HOSTED=<out/hosted>`): the built page in headless Chromium.
- `guests/guests.test.ts`: the rows, the refusals, every secret case, the
  rate limit by CF-Connecting-IP, expiry, revoke within a second, the view
  and comment roles, every other route with a guest's token, a sheet link's
  token, the held request, the tickets.
- `guests/live.proof.test.ts` (opt-in, `M31_PROOF=1 M31_HOSTED=<out/hosted>`):
  the real service on its own listener, the built page in a headless
  Chromium over CDP.
- `renderer/work/guests/guests.dom.test.tsx`: Share and its dialog, the
  held view, the list, and a guest's `javascript:` link and hostile paste in
  the owner's editor (the link's `href` is emptied, the paste keeps words
  only, nothing runs, a press opens nothing).
- The tunnel rule (`scripts/box/ingress.yml`, `^/(g|w|f)/`) is the owner's
  step; until he applies it nothing outside reaches these routes.
