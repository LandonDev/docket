# Work: guest links

One named person outside lets themselves into one LifeOS document or sheet,
or one TempCode document or sheet kept as a file (`.tcdoc`, `.tcsheet`), on
a web page, with no sign-in, to view, comment or edit, until the link ends
or the owner revokes it; or into one LifeOS project, to view ("A project's
link" below; "A file's link"). Milestone 31 built it; the approved page is
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
  `https://share.landonhale.com/g/<id>#k=<secret>` (the box's own name,
  `https://docket.landonhale.com`, while no guest origin is set). No request, log or
  row holds it. A Mac-hosted workspace's LifeOS items are shared from the box
  as well (§19); any other host answers `served elsewhere: <env>` and the
  client asks that one (renderer/work/guests/api.ts).
- **Roles.** `view` reads. `comment` reads, comments on words it selects and
  replies; the service makes the comment and marks the words. `edit` writes
  the document or the sheet's cells live. A sheet's link is `view` or `edit`
  (sheets keep no comments); a document's is any of the three, kept in
  LifeOS or as a file ("Comments on a file's link" below); a project's is
  `view` (`guestRolesOf`,
  src/shared/work/guestRoles.ts). His role change on a live link
  (`work.guests.setRole`, approve) keeps the address: the link's tokens from
  before stop opening anything, as a new address's do (`retoken`), its open
  sockets close, and the page asks again and opens as the new role
  (`afterRevoked`, src/hosted/guest/ending.ts).
- **Ends** thirty days out unless he picks (1, 7, 30 or 90 days in the
  dialog; an hour to a year on the wire). An ended or revoked link stays in
  the lists a week, muted.
- **Shared.** While any live link names an item, its LifeOS row's `shared`
  is on (`docs:setShared`, `sheets:setShared`; a project's link marks more,
  below); revoking the last link, or
  its end passing, turns it off within 30 s. A link goes live only once
  LifeOS has taken its item's `shared`: if it does not, the link is not made
  (the held act fails as not sent), and a live link whose item LifeOS has not
  marked since a start stays out of what the service is told until a tick
  marks it. Agents' writes to a shared item
  become suggestions, as for any shared item.

## A file's link

A `.tcdoc` or `.tcsheet` on the host that serves guests (the box) takes a link
of its own (`{at: 'file', host, path}`; its row adds `table` and `id`, a
digest of the resolved path, `fileLinkId`, so the phone reads it as any row).
`GuestRuntime.resolve` holds it: the host that has the file (another answers
`served elsewhere`), the caller's reach (`ctx.reaches`; a thread's at its
ask), the file there, not in a place others open (`sharedOf`) and not a copy
of a Teams file (`madeFromShared`), then a host whose pages a guest can reach
(`servesPublic`): a file others open is told it is shared where it lives on
every host, never "the box only". Each refusal is one line of `SHARE_REFUSALS`
(guestRoles.ts), which the Share sheet shows in the form's place.

**Share in Teams** (decision 9 of the files pass). A file in a place others
open is shared from its own page, never by a guest link. The window asks the
workspace's host for that file's page with the existing read method
`work.office.live.address` (office/live/handle.ts `addressOf`: the library's
web folder from its sync, or the address he gave, through `liveAddress`; a
`.tcdoc` kept for a Word file, `work_files_word.doc`, answers the Word file's
page; the file is located for the caller, so a key that could not name it
learns nothing). A Files row in a library or his OneDrive offers "Share in
Teams" ("Share in OneDrive") for a document, sheet or deck: asked as its menu
opens, live once the page is known, else greyed with "Share it from Teams."
(`PageActs.shareIn`, `actsFor`'s `shareIn`). A document's or sheet's header
Share reads the same and opens the page where the host names one
(`ShareButton`'s `workspaceId`, `fileShareOf`). Where the file is in a library
whose page the host knows none of, the answer says where it is shared from
(`home: 'Teams' | 'OneDrive'`, an optional field of `OfficeLiveAddress`) and
the header's Share in Teams is greyed with "Share it from Teams.", as the row's
is; any other file keeps the sheet. Share is drawn at once; a press before the
answer, the button's or File → Share…'s or More's (`openShare`, held by the same
`hold`), waits for it, the button busy meanwhile (its glyph turns to the spinner, `BusyLabel`,
`aria-busy`), and then opens the page or the sheet, or, greyed, says "Share it
from Teams." in a toast (`sayHome`), as File → Share… and More do on the greyed
button from then on (`ShareRefused` hears `useShareAsked`), and
a press after an ask that got no answer (undefined) asks again, so one drop
never leaves Share on the sheet; only the host's own "none" greys Share in Teams. A document kept for a
Teams file, where the host knows no page, says "This document is a Teams file
opened here. Share it from Teams." (`teamsCopy`). Revoking the link the sheet
just made takes its address from the sheet, so it cannot be copied after. The page
opens in his browser (`openUrl`); TempCode makes no link and sends nothing.

### A file's link is for one file

A link names its file by path, and a path can come to hold another file: one
moved or saved over it, a folder link pointed elsewhere. So a link also
remembers which file it was made for (guests/fileIdent.ts). A `.tcdoc`
carries an id of its own in an entry `ident.json`, a `.tcsheet` in its
`meta.json`; every save of ours keeps it (the document store keeps every
entry it does not write, a sheet's meta goes back as read), and a copy of
the file carries the same id, since it is the same document. The Work
service, the file's one writer, makes the id when a file has none
(`/internal/guests/ident`; a new `.tcsheet` is made with one). The link's
row keeps it (`work_guest_links.file_uid`), and it is checked in three
places:

- main, before every list it sends the service (`fileServes`): another id, or
  none, ends the link for good, as a file that went does;
- the service, on every request and socket of the link (`guestLink` in
  routes/guests.ts reads `guest.file {path, uid}`): another file at the path
  opens for nobody from the first request, before main's next pass;
- his press on a thread's request: the held act carries the id the file had
  when the thread asked (`fileUid`), and Create refuses another file at that
  name (`SHARE_REFUSALS.moved`).

A link made before files carried an id takes the id its file has at the next
pass, once (`adoptIdents`). A path is taken as the file it reaches: an
absolute path only, and a name that links to a Word file or a workbook is
refused, since the service would open and write the file behind it.

Save As that keeps a document linked to another file first turns every edit
link to it into a view link (store.ts `endGuestEditOn`, called by
files/saveAs.ts): the sockets close and the pages open again as readers, so
nothing a guest types reaches the linked file. An edit link to a document
that is already linked is refused (`SHARE_REFUSALS.linkedOut`).

A token is held to what its link is now: the service refuses one signed for
a role the link no longer has, whenever it was signed (`claimLive`), and a
sheet socket's ops and what it hears are checked against the link as it
stands at each op, not as it stood at hello.

- **No LifeOS mark.** The live link is the file's mark: `fileLinked`
  (guests/store.ts) makes the docs pillar's `othersOpen` and the sheets
  pillar's `shared` true, so an agent's own write to it is a suggestion, as
  on a LifeOS row marked shared.
- **One document, one workbook.** The link's item is named as its pillar
  names it, so the guest and his editor are on one: a `.tcdoc` by
  `fileDocName` of its resolved path, its token carrying `file` (work-kit lets
  a guest's token name one); a `.tcsheet` by `fileSheetId` of its spelling,
  the link telling the service the file (`sheetFile`). The sheet route opens a
  file for this host's own token while a pass of his names it, or a guest's
  token of the link that names it (`opensFile`, service/routes/sheet.ts),
  checked at hello and each second.
- **Ended when it no longer fits.** At each pass over the list (every 30 s
  and on every change) a file's link stands only while the file is there,
  its spelling still reaches the same file, it is still his alone, and an
  Edit link's document is not linked out by Save As (`fileServes`); a link
  that fails ends for good (`endFileLinks`), so a file put in its place later
  is never shown under it. Between two passes a link follows its path.
- **Edit and Save As.** A document Save As keeps linked to another file
  (`linkedOut`, docs/target.ts) takes View links only: an Edit guest's words
  would reach that file after each pause. Create and `setRole` say so.
- **A thread's file.** `guest_link {path}` takes a file in the thread's own
  workspace folder alone (`threadFile`: no fence binds a thread on its own
  host), and the held act keeps the file's id (`fileId`): his press makes the
  link only if the path still reaches that file. The Outbox shows the file's
  folder ("In").
- **No comments.** The open answer says `comments: false`; the page draws
  none, `/threads` answers none and `/comment` refuses.
- **Tokens by role.** A link's token is kept by link and role, and a list
  signed while the role changed drops that link until the next sync, so an
  older role's token is never handed out; a sheet socket checks its link
  again before each batch of ops, not only each second.
- Tests: guests/fileLinks.test.ts (the real service, a guest's and his own
  client on one `.tcdoc` both ways, a `.tcsheet` held to its link, revoke and
  a role change inside a second, a link ended when its file goes, Edit refused
  on a linked-out document, a thread's request held to its workspace and its
  file). A read-only review by GPT-6.2 Sol of the whole change is in
  `.temp-code/plans/landed/F-share-guest-link/sol-review.md`.

## The methods and the tools

The reply to `guest_link` and the thread's note after the owner creates the
link word the expiry day in `hisZone(ctx)`.

`src/shared/contract-work-guests.ts`:

| Method | Cap | What |
|---|---|---|
| `work.guests.list {}` | read | every listed link, live first, with when the service last saw each opened and how many sockets it holds |
| `work.guests.forItem {source}` | read | one item's links, for its Share popover |
| `work.guests.create {source, title, name, role, expiresAt, attempt?}` | approve | his own link; answers `{link, url}`, the only time the address exists. `attempt` (the phone's, 8 to 64 characters): a repeat of the key makes no second link (below) |
| `work.guests.attempt {attempt}` | approve | what became of a Create link by its key, read without making anything: `{state: none \| making \| made \| refused \| unknown, linkId?, words?}` |
| `work.guests.rekey {linkId, attempt?}` | approve | a new address for a live link, shown once; the one before opens nothing from then on. `attempt` (the phone's) is answered once on Create's rows (`rekeyOnce`): a repeat answers `{again: true}` with no address, and `work.guests.attempt` reads it back |
| `work.guests.revoke {linkId}` | operate | at once |
| `work.guests.setRole {linkId, role}` | approve | what a live link may do, at once; the address stays |
| `work.guests.ticket {source, title}` | operate | the owner's hosted editor (below); `source` is a LifeOS row or `{at: 'item', itemId}` for a document or sheet kept as a file |

A thread's call to any but the two reads is refused: an agent asks with
`guest_link {docId | sheetId | projectId | path, name, role, days}`, which checks the item is in
the thread's sector (a file: within the thread's reach, as `resolve` rules) and holds a `share.guestLink` act (no matcher, so no
grant fits and Away releases none). His Create link in the Outbox makes the
link and resumes the thread with the link's id, never its address: he sends
the address himself, copied from Settings → Files → Guests → Shared with guests. The act's Result's way back is Revoke link:
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
  sent only once LifeOS reads it shared. An agent adds none: a thread's
  link into a shared project is refused (`work/projects/link.ts`) and so
  is a document made there (`/internal/doc/create`). `reconcile` tells projects first
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
  in place (`ChildPage` in GuestApp.tsx) with the way back first in the
  line, and Escape goes back too. A task's page puts its way back in the
  same first place (the line's `data-project-lead`, before the glyph), with
  its key where the screens' crumb was. Faces wear the image outline, as
  the desktop's do. A document is shown as text (`DocText`), read again every 15 seconds; one the
  project no longer lists is closed at the page's next read, and a link
  that ended shows the end. One that did not open says "Couldn't open this
  document" (or sheet), "Try again in a minute.", with Retry, as the page's
  own failures are said. `GuestApp.preview.tsx` draws the page over a
  stand-in host: a project's link, that failure, and an Edit link's
  document and sheet as far as they draw with no socket.
- **The owner's hosted editor** has no project: `work.guests.ticket`
  refuses one.

## Main and the service

The Work service is the internet-facing process and holds no signing key.
Main tells it every live link and every open ticket through
`supervisor.setLinks` (guests/links.ts `sync`; the extra fields on
`ServiceLink` are typed in guests/wire.ts): the secret's hash, the guest's
and the owner's names, the title, and a collab token main signed for the
link's item (`principal: guest:<id>`, `link: <id>`, no file path, ten
minutes, signed again with five left on a 30 s tick; a project's link
carries none, and what it shows goes in a message of its own, above). A revoked or ended
link is not sent, so the service no longer knows it: its document sockets
close at once (`collab.closeWhere`), its sheet sockets at the sheet route's
next second, and every route answers it as gone.

### The guest origin

A guest's page, the owner's hosted editor and his TempCode web session
(`/ui`, `/ws`, `/api`) shared one origin, `https://tempcode.landonhale.com`.
His session cookie is `Path=/; SameSite=Lax`, and `/ws` takes any socket
whose `Origin` is that host: one script fault on a hosted page, opened in a
browser where he is signed in, would be his whole app, with only the page's
CSP between. So guest pages have a hostname of their own,
`https://share.landonhale.com`. The tunnel sends the whole host to the Work
service, whose closed route list answers 404 for everything else; the cookie
is host-only and never reaches it; the page's CSP (`connect-src 'self'`)
holds as it is, since the page and its socket share the new origin.
`docket.landonhale.com`, the app's new name, is an owner origin like
`tempcode.landonhale.com` (src/shared/publicHosts.ts), never a guest one: a
guest page asked for there is sent on to the guest origin as from the old
name.

- Which origin new links and tickets carry is one host setting,
  `work.guests.origin` (service/config.ts `GUEST_ORIGIN_SETTING`), unset by
  default: then `publicOrigin` as before. `guestOrigin(ctx)` (links.ts) reads
  it for a guest's address and for his own hosted editor's; every other
  address of the host (the full editor, forms) keeps `publicOrigin`.
- `work.guests.setOrigin {origin}` sets it (admin; a thread's call is
  refused): the origin must be `https://` and a name, and is taken only once
  `<origin>/w/healthz` answers this very service's start mark, so a name
  that reaches nothing, or another machine, cannot break links. `null` puts
  it back.
- Once it is set (the service is told with its origins,
  `ServiceOrigins.guest`): `GET /g/<id>` and `GET /w/open` reached on any
  other host answer 308 to the same path on the guest origin, so an address
  already handed out keeps opening (a browser carries the fragment across);
  the guest's POST routes, `/threads` and `/g/ws/*` answer 404 there
  (routes/guests.ts `elsewhere`). A guest's socket takes the guest origin
  alone ([work-service.md](work-service.md) "Origins"). What is not a
  guest's stays where it was: `/w/hosted/`, `/w/healthz`, `/f/`, `/w/full/`,
  the Office routes, and an open page of his own renewing its pass.
- The DNS name and the ingress rule are the owner's or the master's step
  (docs/box.md "Cloudflare tunnel"), never a build's.

### A start is not an end

After a start the service knows no link until main has named them, and "not
in the list" would read as "gone", which a page takes for the end. So the
service is told whether its first list is one main settled
(`ServiceConfig.linksSettled`): the supervisor's last list, handed on when
the service alone restarted, is; the empty list of a main that has itself
just started, or whose keys are new, is not. Until main's first `links`
message every route that could answer "gone" answers 503 `{error:
'starting'}` instead (`/g/<id>/open`, `/item`, `/threads`, `/comment`,
`/g/ws/*`, `/w/open/redeem`, `/renew`), and counts no failed secret. Once
main has spoken, a link that is not in its list is gone at once (403).

Main sends that first list as soon as it can sign a token, and never before
(a list with no link in it would be its word that every link is gone). It
does not wait on LifeOS for it: what LifeOS was told of each row is kept on
this host (`work_guest_marks`), read back at a start, and a link whose row
is in it is sent at once. Each such row is still told to LifeOS once more
after the start, as every row is; a link with no record of a mark waits for
LifeOS's answer.

The signing key is new at every start of main and is kept nowhere. Pages
ask for a fresh token with their secret, so nothing needs the old key. A
link's `keyedAt` (the moment of its last new address or role) lives in
main's memory, and that is safe only because the key changes at a start: if
a key is ever kept across restarts, `keyedAt` must be kept in the link's row
with it.

## The routes

On the public listener (service/routes/guests.ts, item.ts). Callers are
told apart by `CF-Connecting-IP`, else the peer address.

| Route | What |
|---|---|
| `GET /g/<id>` | the page, the same bytes for any well-formed id |
| `POST /g/<id>/open {secret}` | the link's facts and its current token (a project's link: its projection and no token, above); a wrong secret, an unknown, ended or revoked link all answer 403 `gone`; 503 `starting` until main has named its links ("A start is not an end") |
| `GET /g/ws/<id>` | a document's or a sheet's link: the item's socket, bound to the link's item whatever the client names (a project's link has none: 404); the token is still checked inside (Hocuspocus for a document, the sheet route's hello for a sheet), and must be this link's own: another link's token for the same item opens nothing here, and a link's token opens nothing on `/w/doc/*` or `/w/sheet/*` reached directly |
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
(sheets/host/live.ts): cell values, formulas and styles, number formats set
and removed, rows and columns inserted or removed (1,000 at a time), merges
made and parted, a column's width, a row's height and its fit. Nothing
else: no sheet added, removed, renamed or moved, no name, note, rule,
filter, sort, table, chart or picture; one of those is refused as "a guest
cannot …" before any other check. `guestCells` keeps a cell's value, formula,
style and type only, and the page cuts its own writes the same way before it
sends (`src/shared/work/sheetGuest.ts`). A sheet link's sends are held to 600
a minute and 20 MiB an hour (routes/sheet.ts `SHEET_BUDGET`), past which a
batch is refused "too many edits at once: wait a minute". A message on a
sheet socket that is not an object with its kind closes that socket alone.
Nothing on these routes links to `/w/full/` or mints a full-editor token.

**A file link is the file it was made for, every moment.** The service reads
the file's id again when a token signs in and on every live check (the sheet
route's each second and before each batch), and a guest's document socket on a
file replaced since is let go within two seconds; main's comment relay checks
it too (guests/comments.ts). A comment is written only if, after its words are
read, the link still stands with the same role and the token is still good.

**A link's budget** (routes/budget.ts, counted in routes/guests.ts where a
link's frames pass, before the document sees them). A guest with an Edit
link holds a writer's token, and nothing else capped what a writer sends but
the 4 MiB frame.

| What | The line | Past it |
|---|---|---|
| bytes a link's document sockets send | 4 MiB at once, 1 MiB back a minute, one bucket a link whatever sockets it holds | the frame is not passed on and the socket closes 4429 "too much at once: wait N s"; until then the link's upgrades answer 429, so a page's tries cost a refused upgrade each. The page says "Too much at once. Your edits are kept and will send in a minute." and comes back by itself |
| sockets a link holds | 8 | the upgrade answers 429 |
| a document's state | 32 MiB (measured at most every ten seconds a document) | a guest's frame that adds to it closes 4413; the owner's own edits and every read go on. The page says "This document is as large as a guest can make it. Your last edit was not saved." with Reload |

**Whose name a caret carries.** A guest's presence is stamped whole by the
service (work-kit `guardPresence`): the link's name, no picture, and a hue
the service picks so two guests in one document never wear the same one
while eight are free (`presenceHue`: a principal keeps its hue while it
stays, its second tab wears the same, a newcomer takes one nobody wears).
The owner's own connections carry his name as the host keeps it (`work.ownerName`,
learned from his default mail identity; `ServiceConfig.owner`, `namePresence`) and keep the rest they sent; unset,
his client's word stands.

An edit link's guest leaving a document cuts a `guest-end` version.
History and the document's comments name a guest by their link's name
(`guestNameOf`).

## Comments on a file's link

A `.tcdoc`'s comment threads are rows in the app's database
(`work_docs_threads`, docs/threads.ts), which the Work service never opens.
So the service asks main over its wire (`{t: 'guest-ask'}` with `what:
'threads'` or `'comment'`, answered by `{t: 'guest-answer'}`; the
supervisor's `setGuestAsks`), and main answers for that link's own file
alone (guests/comments.ts `answerGuestAsk`): a link that is not live, or is
not a document kept as a file, is gone. The rules are the LifeOS
document's: plain words the service builds into the comment, 4,000
characters, 20 a minute a link, a reply only on a thread of this document
that still stands, a view link writes nothing (refused by the service and by
main), and a guest learns no other guest's name (`guestRows`: ids are
stand-ins made for the answer, and reactions, which name who reacted, are
left out). The words a new comment is about are looked for in the live
document opened as its file, and for a comment link the service marks them
(`quoteIn`, `markIn` in routes/guests.ts). His open editor hears of each at
once (`work.docs` push, `threads`), and History and the margin name the
guest by their link (`guestNameOf`). The page draws the same margin as for a
LifeOS document.

## Tells

Through the digest (`ctx.tell`, [work-digest.md](work-digest.md)), never a
thread, and with no deadline, so both wait for the day's digest
(guests/tells.ts):

- `guests.opened`: the first time a link is opened, "Dana Lee opened Spring
  LAN run of show", key `guest-open:<link>`.
- `guests.edited`: once a day for each link whose guest changed the item,
  "Dana Lee edited Spring LAN run of show", key `guest-edit:<link>:<day>`
  (the day in his zone).

A title holds the name he gave the link and the item's title as it was when
he made it: never a word a guest typed. A press opens the document or sheet
in its job (a file's job by its folder, a LifeOS row's by its sector), else
Settings → Files, where the links are listed (Guests). The service says what it saw
(`routes/seen.ts`: `at`, `open`, and `wrote`, set when a guest's document
frame that adds content is passed on or a guest's sheet batch is
acknowledged), main reads it on its 30 s pass (`tellSeen`), and what he was
told is kept in the link's row (`first_opened_at`, `last_wrote_at`), so a
restart tells nothing twice. The service's memory of an edit made in the
half minute before it restarts is lost with it: that day's tell then waits
for the guest's next edit.

## The page

`src/hosted/guest/` (built into `out/hosted/guest`, served at `/g/<id>` and
`/w/open`): one 44px line (the item's glyph and name, whose it is, "Can
edit", "until Dec 18", the guest's initials), then the owner's own editor
(work-kit/editor) or grid (work-kit/sheet) on the app's own tokens, light or
dark by the browser's setting. Before the guest's own face the line draws the
faces of who else is in the file (`Faces`: the app's 20px `Face`, lapped 6px,
each ringed in the hue of their caret, three and a count past four); the
owner's hosted page draws them too. The owner's page says his own name on
his caret (`self`, handed over with his pass), never "You", which a guest
would read as themselves. What a link may not do is not drawn. A comment
link gets its own small bar over selected words, since the editor draws none
on a text it only reads. The page asks the service again with every token
the editor asks for, and when the host closes the document's socket as
revoked (4403, `ending.ts` `endingSocket`, the editor's `collab.socket`): a
link that is gone then ends the page at once, its document off the screen,
for an Edit, Comment or View link alike. A reader's editor shows no trouble
once the text is in, so without that close the open page kept the document
(W-46). A sheet's page ends on its own socket's 4403; a project's page,
which has no socket, on its next ask (every 15 s and when the window comes
forward). Each says "This link no longer opens anything". The service gives
one answer for every link that opens nothing, on purpose, so the page tells
one case apart by itself: a link past the end time this browser was given
says "This link ended Dec 18" and "Ask Landon Hale for a new one if you
still need it." (`endWords`; what it needs is kept in this browser's
`localStorage` under `tc-guest:<id>`: the end time, the owner's name and the
document's name, nothing else). The other states: too many tries, cannot be
reached (Retry), loading bones. A host that is starting (503) is neither: the
first open asks again every 2 s for 2 minutes under the bones before it says
the page cannot be reached (`openWhenUp`).

**The copy on a guest's device.** An Edit link's document page keeps the
document in this browser's IndexedDB (`tempcode-guest:<link id>:<document>`,
offline.ts), so words typed while the line is down outlive a closed tab and
are sent when the page next opens. A View or Comment link keeps none, and
the owner's page keeps none. The copy is wiped when the link ends (any way
the page learns it is gone), when the host refuses what it holds (a close
that says another writer's; wiped and read afresh once, never in a loop),
and when an update too large to send is stuck in it.

**The lines.** One muted line under the format row says when what is typed
is not saved yet: "Offline. Your edits are kept on this device until the
connection is back." (an Edit link), "…in this tab…" (the owner's page),
"Offline. Changes will show when the connection is back." (a reader). It
shows within two seconds of a change the host has not answered
(`watchedSocket` in ending.ts counts from a change sent to the host's next
word; a line that drops without a word is known to the browser only after
half a minute), at once when the browser says it is offline, and leaves at
the host's next word. An update the host cut as too large (close 1009) is
said once in the text's place, "That is too much to add at once. It was not
saved." with Reload, and the editor is gone: sent again it would be cut
again. After a reload an Edit link's caret is back in the text, at its start.
Under 640px every comment control keeps its drawn size and takes a 44px hit
area (guest.css).

**A sheet's page** runs work-kit's sheet session (`sheetLine.ts`; the account
is work-sheets.md "Live editing"): its own unanswered edits kept apart, one
batch in flight, everyone else's moved through them, and the grid editable
while the line is down under "Offline. Your edits are kept on this device
until the sheet is back." An Edit link's unsent edits live in IndexedDB
(`tempcode-guest:<link id>:sheet`, sheetQueue.ts: one tab a link, a day at
most), wiped with the document copies when the link ends. A refusal says
"Edit not saved" and why in plain words; edits that could not be kept are
said once ("3 edits made offline could not be kept. The sheet changed under
them."). Others' selections are drawn on the grid in their hue with the
service's name for them, and their faces in the line.

## The owner's hosted editor

For the phone (milestones 46, 47): `work.guests.ticket` answers
`<guest origin>/w/open#t=<ticket>` (`guestOrigin(ctx)`, "The guest origin"
above). The ticket opens once,
within two minutes (`POST /w/open/redeem`); the service then makes a renewal
key it keeps in memory for that run of the service (by its route context,
so a service restarted inside one process forgets them too), the page keeps
it in the tab's session storage, and `POST /w/open/renew` hands a fresh
owner token for that item while main keeps the pass (eight hours, in memory:
a restart of main or the service ends it). A page whose renew is refused as
gone shows its end and, inside the phone's web view, posts `{kind:
'passEnded'}` to the handler `tempcodeHosted` (src/hosted/guest/phone.ts), and
the phone opens the file again on a new ticket, once in a row
(docs/agents/work-phone-files.md "The hosted editor"). The item opens on its own route (`/w/doc/<id>`, `/w/sheet/<id>`) with
the owner's token; the ticket leaves the address once used.

A pass's token edits, except on a LifeOS row others can read (LifeOS's
`shared`, a row it does not answer for taken as read) asked by a key that is
not his press (files/policy.ts `pressesFor`): that token views, as
docs/index.ts `roleOf` rules for the desktop. Such an editing pass is looked
at again at every pass over the list (`dropShared`): once its row reads as
shared it ends, its page cannot renew, and a new ticket views. The service's
redeem still answers `role: 'edit'` whatever the token says
(service/routes/item.ts `answer`); the token decides what the socket takes.

The phone (milestone 47) asks a ticket each time it shows a LifeOS document
or sheet in a thread's Item segment and loads the address in a WKWebView
with a store of its own that keeps nothing (`.nonPersistent()`), so each
open is a new pass. Share… in the item's More opens the phone's Share sheet
(below).

### Share on the phone

The phone's sheet is the desktop's one Share sheet (`ShareLinkSheet`,
ios Work/Items/GuestLinkSheet.swift; rules in the client's
Work/Guests/ShareRules.swift, held to `SHARE_REFUSALS` and `guestRolesOf` by
scripts/ios-share-fixture.test.ts): For, Can, Ends (a day, a week, thirty
days, ninety); Create shows the address once with Copy and Share; the item's
live links under it, each with its line of facts and a menu of Replace
Address…, the role and Revoke; a host's refusal in the form's place; Purdue's
line under the form. It takes a LifeOS document or sheet and a `.tcdoc` or
`.tcsheet` kept as a file, sent as `{at: 'file', host, path}` ("A file's
link" above; the phone's Swift reads the wire's own source union), and a
sheet's link views or edits (`ShareSource.of`). It asks the host that `served elsewhere`
names when the first one does not keep the item's links. Create, the role and
a new address go through `PressGates` first; Create also through the press
record under an attempt key.

**The attempt key** (guests/attempts.ts, as Messages' Send,
messages/attempts.ts): the host writes the key's row in the same turn as its
check, before anything is made, and keeps what it did for a day (a phone key past
the day, `phone-<ms>-…`, reads back as unknown and a repeat of it is refused, never
made anew: `attemptAge.ts`). A repeat
while the first is still making waits on the same answer, address and all; a
repeat after it answered gets `{link, again: true}` and no address, since the
address is never kept (the sheet says so and points at Replace Address); a
refusal is said again in the same words; a key cut off by a restart reads
"The host restarted while making the link…"; a key reused for another item or
person is refused. The phone keeps one key until a press is answered, so
Create after a lost answer makes no second link, and on its next link it reads
a lost press back by `work.guests.attempt`. The desktop sends no key and is
unchanged. Tests: guests/attempts.test.ts.

### A file in the hosted editor

`work.guests.ticket` also takes a canvas item, `{at: 'item', itemId}`
(`TicketSourceSchema`): a document or sheet kept as a file, shown by a
thread's item or a Files tab. (A guest's link to a file names the file
itself: "A file's link" above.) Main decides what the item opens
(`GuestRuntime.opensOf`), and refuses in words a screen shows
(`TICKET_REFUSALS`):

- the item is gone, or is not a document or a sheet;
- the file is on another host of his (`served elsewhere: <env>`, as a LifeOS
  row another host serves);
- the file is outside the caller's reach (`ctx.reaches`, a `FenceError`);
- others can open the file (`sharedOf`): it never goes to a phone;
- this host serves no page a phone can open (`servesPublic`: the box behind
  its tunnel, or a proof that names `TEMP_CODE_WORK_PUBLIC_ORIGIN`);
- it is a Word or an Excel file: the desktop's own editor saves those, so it
  says "Edit it on your computer".

A `.tcdoc` then redeems to its own room (`fileDocName(canonicalPath(path))`)
with an owner token that carries the file's path, as the desktop's editor
uses; the service's file store writes the `.tcdoc`. A `.tcsheet` redeems to a
name with no path in it (`fileSheetId`, `tc` and 40 hex digits, of the path as
the item spells it, which is how the sheets pillar names its workbook, so the
phone and the desktop are on one); the pass main
sends the service names the file (`sheetFile`), and the live socket
(`routes/sheet.ts` `filedSheet`) opens that file for this host's own owner
token of that name, while the pass stands, through the service's one sheet
host. A guest's token, LifeOS's token and a name no pass gave a file open
nothing of it. A file's pass is looked at again at every pass over the list
(`stillOpens`, every 30 s): once its item is closed (its row stays, `state:
'closed'`, and a closed item gets no ticket either), names another file, its
spelling reaches another file (a `.tcsheet`'s pass keeps the file its
spelling reached when it was made, so a linked folder pointed elsewhere ends
it), or its place is one others can open, the pass is dropped, the sheet's
socket closes within a second and the document's token is not renewed (it
runs out within ten minutes). A document socket already open is not closed
by the drop: the owner's token names no pass (work-kit lets only a guest's
token name a link), so the service cannot tell which pass it came in on.
Tests: guests/fileTicket.test.ts.

The page's own Comment action is a guest's (`commentsOnPage` in
src/hosted/guest/session.ts): the owner's pass shows none, since the page
would take his words and send none of them (`Session.comment` is a guest's).
His comments are made in TempCode: on the phone, Comment in the edit menu.

### The phone's frame

The phone opens the ticket's address with `&chrome=none` in the fragment
(`/w/open#t=<ticket>&chrome=none`; the host never sees a fragment). The page
then draws no line of its own and no format row: the app's bar is the only
heading, and the app draws the row and Find. Only the owner's page reads the
word (`frameOf` in src/hosted/guest/frame.ts); a guest's link keeps its line
whatever its address says, and a page without the word is as it always was.
Once the ticket is used the address keeps `#chrome=none` alone, so a reload
of the tab keeps the frame.

Where the app's web view listens (`window.webkit.messageHandlers.tcFrame`),
the page answers a closed set of messages, and drops anything else unread.
The app calls `window.tcFrame.receive(message)` with:

- `{kind: 'format', what: 'bold' | 'italic'}`, `{kind: 'format', what:
  'style', style}` (only a style the page offered), `{kind: 'format', what:
  'list', list: 'bullet' | 'number' | 'check'}`;
- `{kind: 'find', what: 'search', query}`, `{kind: 'find', what: 'next' |
  'previous' | 'clear'}`;
- `{kind: 'undo'}`, `{kind: 'redo'}`.

The page posts back `{kind: 'drawn', v: 1, offers: {format, find, undo}}` once,
two frames after the editor hands over its text (a sheet: after its grid is
up; a page that opens nothing: at once, so the app shows its words);
`{kind: 'state', editing, style, styles, bold, italic, list, undo, redo}` at
most once a frame and only when it changed (`editing` is the text holding the
focus: the keyboard is up); and `{kind: 'found', query, count, at}` after each
find (`at` from 1, 0 with none). Find draws its matches with the page's own
highlights (`::highlight(tc-find-hit)`, `tc-find-current` in guest.css) and
never takes the focus, so it raises no keyboard. A reader's page writes
nothing; a sheet offers Undo and Redo alone. Code: frame.ts (the set, pure),
frameDoc.ts (the document's side); tests beside them, GuestFrame.dom.test.tsx,
and the frame's cases in DocPage's and SheetPage's tests.

The page's word of its pass (`opened`, `passEnded`: "For the phone" above)
goes to a second handler, `tempcodeHosted` (phone.ts), with or without the
frame. The app hears both on one coordinator, from the ticket's origin in the
main frame alone (ios HostedItemView.swift).

## The screens

- **Share** is one sheet (`guests/ShareSheet.tsx`, its own chunk, loaded on
  the press) for every document and sheet: the header's Share
  (`ShareButton`, guests/Share.tsx, mounted from each kind's `Bar`), More's
  Share… and File → Share… (the `share` work command, through `openShare`,
  guests/sharePort.ts), and a Files row's Share… (`actsFor`'s `share`,
  FilesView). On top For, Can, Ends; Create link shows the address once with
  Copy and New link. Under it the item's live links: who, then what they can
  do, made, last opened and until when in one muted comma line (`linkFacts`,
  guests/api.ts: the one way a link's facts are said, never a run of dots),
  and a menu: Replace address… (asked first; the new address shows once, in
  the form's place, with Copy), Can view / comment / edit, Revoke… (asked
  first, `confirmRevoke` in Share.tsx; no Undo, since an old address must
  never open again: decision 21 of the files pass). Until
  `work.guests.forItem` answers the sheet is the form's bones
  (`data-share-bones`), so a form is never shown and then refused. A
  document or sheet no link can take opens on one line saying what to do
  instead (`shareTargetOf`, guests/api.ts, and the host's `SHARE_REFUSALS`):
  a Word file or a workbook says "Share this file from where it lives", never
  a Save As that offers no Docket kind;
  a mail's attachment draws no Share. A Purdue workspace's sheet says beside
  Create link that the link shares university data (`PURDUE_LINE`); it does
  not stop him. A project has the same sheet from its page's bar
  (`ProjectShare`) and from the Sharing row of its settings sheet (the same `ProjectShare`,
  one row, never a second list of links); its sheet has no Can row.
- **The held request** in the Outbox (`ShareActView.tsx`): To (the item by
  its glyph and title, a file's with its folder's name alone: "Field trip
  plan in Trips", never a disk path), For, Can, Ends.
- **Shared with guests** in Settings → Files, Guests (`GuestLinksSection.tsx`, its list in a sheet): every link on
  every Work host, live first: who, then `linkFacts` with the item (a
  project's as "Spring LAN project", a file's with its folder's name): the
  role where there is a choice, made, "in it now", "opened …" or "not opened
  yet", until when, or for an ended one when it ended or was revoked.
  Replace address… (`work.guests.rekey`, asked first) shows the new address
  once in the link-made dialog with Copy; Revoke… asks first. Ended ones
  muted.

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
- `bun run script:e2e-phone-hosted` (scripts/e2e-phone-hosted.ts; through
  the box's `heavy` queue): a file-kept `.tcdoc` and `.tcsheet` opened from
  `work.guests.ticket {source: {at: 'item'}}` in headless WebKit at 390×844
  with touch, against the iOS test server's in-process service serving a
  hosted build (`TC_TEST_HOSTED_DIR`); typing reaches `doc_read`, the file
  and `sheet_read`, a Word and an Excel file are refused in words, a used
  ticket answers 403, and report.md says what the owner's page draws of
  comments and suggestions (none: DocPage passes no `review`, SheetPage no
  `marks`, and an owner's session reads no threads). Then the service is
  restarted with the memo open (`POST /work-service/restart` on the test
  server): the page posts `passEnded` to a stand-in for the phone's handler,
  and a new ticket opens the memo again with its edit kept. `TC_WEBKIT` and
  `TC_WEBKIT_MESA` launch a copy with its libraries where the host lacks them.
- `renderer/work/guests/guests.dom.test.tsx`: Share and its dialog, the
  held view, the list, and a guest's `javascript:` link and hostile paste in
  the owner's editor (the link's `href` is emptied, the paste keeps words
  only, nothing runs, a press opens nothing).
- `bun run script:e2e-guest-live` (scripts/e2e-guest-live.ts, through `heavy`):
  an isolated instance of the built tree and a clean Chromium as the guest,
  through a TCP proxy it can cut. The default run (`F-live-guest/M1/`) is a
  `.tcdoc` by an Edit link: both type and see each other with names, faces,
  the guest types with his document closed, History under the guest's name,
  a reload, 20 s offline, the host restarted with the page open (live again
  1.1 s after the service's port answered), revoke. `--restart` (`M2/`): two
  guests and his window, three restarts while one types, every character
  kept. `--sheet` (`M3/`): a `.tcsheet`: cells and selections both ways, a row
  inserted while the other types below it in both orders, a formula across,
  20 s offline with three edits, a restart, a refused act in words, History,
  revoke.
- `guests/linkedWrites.test.ts`: with a live link an agent's own write to a
  LifeOS document, a LifeOS sheet, a `.tcdoc` and a `.tcsheet` waits as a
  suggestion and the item's bytes do not change; revoked, it writes again.
  `guests/awayHold.test.ts`: a thread's `guest_link` is held and stays held
  under Away, and its own call to create, setRole, rekey, revoke or setOrigin
  is refused, Away on or off.
- The tunnel rule (`scripts/box/ingress.yml`, `^/(g|w|f)/`) is live: checked
  on 2026-11-24, `https://tempcode.landonhale.com/g/<id>` answers this
  service's page, and its sockets upgrade through Cloudflare. A guest link
  works from outside now.
