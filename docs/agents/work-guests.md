# Work: guest links

One named person outside lets themselves into one LifeOS document or sheet
on a web page, with no sign-in, to view, comment or edit, until the link
ends or the owner revokes it. Milestone 31 built it; the approved page is
`.temp-code/prototypes/work-workspaces-2/guest.html`, and docs/DESIGN.md
("History and Share", "The guest's page") holds the look. This is the one
place people outside reach the owner's data: every rule below is a check
with a test.

## A link

- **A row on the host that serves LifeOS's documents** (the box):
  `work_guest_links` (guests/store.ts) holds the id, the SHA-256 of the
  secret, the guest's name, the item (`{at: 'lifeos', table: 'docs' | 'sheets', id}`),
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
  (sheets keep no comments). Files are not shared: Share on a `.tcdoc` or an
  opened file says "Move it to LifeOS to share it."
- **Ends** thirty days out unless he picks (1, 7, 30 or 90 days in the
  dialog; an hour to a year on the wire). An ended or revoked link stays in
  the lists a week, muted.
- **Shared.** While any live link names an item, its LifeOS row's `shared`
  is on (`docs:setShared`, `sheets:setShared`); revoking the last link, or
  its end passing, turns it off within 30 s. Agents' writes to a shared item
  become suggestions, as for any shared item.

## The methods and the tools

`src/shared/contract-work-guests.ts`:

| Method | Cap | What |
|---|---|---|
| `work.guests.list {}` | read | every listed link, live first, with when the service last saw each opened and how many sockets it holds |
| `work.guests.forItem {source}` | read | one item's links, for its Share popover |
| `work.guests.create {source, title, name, role, expiresAt}` | approve | his own link; answers `{link, url}`, the only time the address exists |
| `work.guests.revoke {linkId}` | operate | at once |
| `work.guests.ticket {source, title}` | operate | the owner's hosted editor (below) |

A thread's call to any but the two reads is refused: an agent asks with
`guest_link {docId | sheetId, name, role, days}`, which checks the item is in
the thread's sector and holds a `share.guestLink` act (no matcher, so no
grant fits and Away releases none). His Create link in the Outbox makes the
link and resumes the thread with the address (it may then draft a mail with
it, held as every mail is). The act's Result's way back is Revoke link:
`guest_link_revoke {linkId}`, which revokes only a link the same thread
tree asked for. The preamble tells Work threads that sending one of his
documents means sending such a link.

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
  address once with Copy.
- **The held request** in the Outbox (`ShareActView.tsx`): To, For, Can, Ends.
- **Guest links** in Settings → Work (`GuestLinksSection.tsx`): every link on
  every Work host, live first: who, the role and item, until when, and "in
  it now", "opened …" or "not opened yet"; Revoke. Ended ones muted.

## Proofs

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
