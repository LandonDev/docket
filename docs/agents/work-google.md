# Work: Google files

Milestone 30 of the Work plan. Google Docs, Sheets and Slides in a Work
thread's canvas, through LifeOS's own Google client: TempCode has no Google
client of its own and never holds a refresh token. The server is
`src/main/server/work/google/`, the wire `src/shared/contract-work-google.ts`,
the screens `src/renderer/src/work/google/`. Landing note:
`.temp-code/plans/landed/M30.md`.

## Tokens

Every call goes with a short-lived `drive.file` access token from LifeOS's
worker: `POST <LifeOS MCP origin>/google/token {account, scope}` with the
owner's LifeOS JWT (`ctx.lifeos.jwt()`), M24. `client.ts` `GoogleTokens`
keeps a token in memory until a minute before it ends, asks again after a
401, and words each refusal (409 `needs-consent`: the account must be
reconnected in LifeOS with every box ticked; 404: no such account; 502
`too-wide`: Google gave a wider token than asked, which is never used). No
token reaches the database, a log or the wire.

## Picking a file

`work.google.pick {account}` (capability `local`: this machine's own window)
opens Google's desktop Picker in the system browser with LifeOS's Google
client id, `drive.file`, `trigger_onepick=true` and `login_hint`, and waits
on a loopback listener (127.0.0.1, any port, `/picked`, this pick's `state`
only) for the ids he picked (`picker.ts`). The `code` Google sends along is
never exchanged. A picked file is reachable by any `drive.file` token of
that client, so LifeOS's tokens read it.

The client id is a host setting, `work.google.clientId` (`work.google.setup`,
local only), or `TEMP_CODE_GOOGLE_CLIENT_ID`. It is LifeOS's `GOOGLE_CLIENT_ID`
(root-only in `/etc/lifeos/worker.env` on the box; a client id is not a
secret). Until it is set, the dialog says the computer does not know
LifeOS's Google client yet.

`work.google.open {sessionId, account, fileId}` opens a picked file in the
thread's canvas by its kind: a Doc as `document`, a Sheet as `sheet`, a deck
as `slides`, each with the source `{at: 'google', account, fileId, mime}`.
`sessionId` may be a workspace's Files pane (`filesPaneOf(workspaceId)`):
the file then opens in a Files tab through `work.files.open`, with no thread
and never twice, and the answer carries the tab too ("Drive in Files").

The screen: **Open from Google…** in the canvas's ⋯, a dialog with one
choice (the account; `PickDialog.tsx`), as Export is. It closes as the
Picker opens; a failure is a toast. Accounts come from
LifeOS's `calendarOps:accounts` rows; only those whose grant has
`drive.file` (`files: true`) are offered.

## Drive in Files

`drive.ts` is Drive as the Files place reads and changes it
(work-files.md "Google Drive"): a folder's children and everything this
client may see (`files.list`, a thousand a page, 10,000 at most), one item's
facts with whether others can open it (`othersCan`: Drive's `shared`, a
shared drive, another owner, or facts that do not say), and the verbs, each
one call: `files.create` for an empty Doc, Sheet, Slides deck or folder,
`files.update` for a rename, a move (`addParents`, `removeParents`) and the
bin (`trashed`). Every call goes with the same `drive.file` token as the
rest of the pillar; nothing asks for a wider scope, so a Drive place lists
only what LifeOS's client made and what he picked. Add from Drive is the
Picker above; a pick drops what Files kept of that account's listings.
`googleSeatOf` and `googleSeated` are what any opener of a Google file
shares: its kind and source, then the pillar's row and the version poll.

## Docs

A Doc is read when it is opened, never mirrored live (`docs.ts`). The
document kind's `targetOf` (`work/docs/target.ts`) turns a Google source into
its mirror: a `.tcdoc` under `<dataDir>/google/<hash>/`, written by the
import pipeline (`writeImportedTcdoc`) from `documents.get` with every tab,
suggestions inline and comments included, mapped by `mapper.ts` to the
pipeline's `Block`, `SidecarThread` and `SidecarChange` (the formats
research's mapper, its three fixtures as `mapper.test.ts`). Comments land in
`work_docs_threads`; each author's suggestions become a branch
(`external:<name>`). Images are fetched at once (their address lives 30
minutes) and kept as data URLs up to 4 MB. Later tabs follow the first under
a heading of their title. The mirror is kept while the Doc's Drive version
has not moved, and while his edits wait to be written (the row is then
`behind`); otherwise a new mirror is read and the old one removed. Drive is
asked only when the item opens (`work.docs.open`) or on Read again; every
other docs call takes the mirror there is, and opens and writes of one file
run one at a time. A thread may not name a mirror's path to the doc tools.
Comments made on the mirror stay in TempCode: they are not sent to Google,
and a fresh read replaces them with Google's.

**Writing to Google** (`write.ts`, `work.google.write`, his only, never a
thread's): the mirror's blocks (`/internal/google/blocks` on the Work
service) are compared with what was last read (`DocBase`); the Doc is read
again; each changed paragraph is found there by the words it had, nearest
its old place (two equally near: refused, never guessed), and only the
differing words are deleted and inserted, a surrogate pair kept whole. New
text paragraphs go after the paragraph they follow, with their heading or
normal style and no bullet, and only after a paragraph Google still holds as
it was; removed paragraphs side by side go as one range, and when the run
ends the Doc the paragraph left last keeps its own style. All of it is one `batchUpdate` with
`writeControl.requiredRevisionId` of the revision just read; a revision
conflict reads again once. Not written, and said one line each: a paragraph
whose words changed in Google since, one holding a chip, footnote, soft break
or waiting suggestion, a change of formatting alone, a table, a picture, a
block of another kind. After a write (or a failed one, whose answer may have
been lost) the base is matched again to the Doc as Google has it; a refused
paragraph keeps its old base, so it stays counted as his and is never
dropped by a later read. The base's hashes are taken from the mirror as the
Work service reads it back, so an untouched table compares equal.

**An agent's edits** never reach Google before his press (the owner's
ruling of 2026-11-23; work-outbox.md "An agent's suggestion stays his"):
`google_doc_suggest` checks its `{find, replace}` pairs against the Doc
(each `find` must stand once in a plain paragraph; `checkEdits`) and holds
them as a `google.edit` with the revision it read. Nothing goes to Google:
no suggestion, no comment. His press in the Outbox reads the Doc again and
writes them as plain edits in one `batchUpdate` bound to the revision just
read (`writeEdits`); a `find` no longer standing once, or standing in a
paragraph other than the one it was suggested in (`within`, its tab `tab`
and its place among the Doc's paragraphs `at`, kept with the hold, so the
same words in another tab, or moved within one, are another passage), leaves
the act stale; a hold from before `tab` was kept, on a Doc of several tabs
that changed since, is stale and asks for a fresh hold, and a Doc that moved while every `find` still
stands where it did is written and said.
The docs tools refuse a Google item and name the google tools.

The screen: a Google Doc's ⋯ holds **Write to Google**, **Read again from
Google**, **Drop unwritten edits** (while there are some) and **Open in
Google** before Export (`docMore.ts`). The open item
asks `work.google.watch` once a minute; when Google moved, one toast says so.

## Sheets

A spreadsheet is a held kind of the sheets pillar, `{at: 'google'}` in
`heldOf` (`grid.ts`), drawn as an opened file whose cell contents save:
loaded as a Univer snapshot from `spreadsheets.get` with grid data (sheet
ids are tab names), at most 200,000 cells. Every write is compared first:
the cells are read again and if any holds something other than what the
grid or the agent saw, nothing goes (`conflict`). What passes goes as one
`values:batchUpdate`, `USER_ENTERED` (text that looks like a formula is
written as text). The Sheets API has no conditional write, so a change
landing between the compare and the write is not caught. A spreadsheet past
the cell cap refuses writes. An agent's cells are suggestions in
`work_sheets_suggestions` under `google:<fileId>` (`google_sheet_suggest`);
an accepted set is written as one update, a cell changed since stays a
conflict. `googleSource` is the spreadsheet as work-kit's `SheetSource`
(`formulas: 'store'`, `live: false`). History, structural edits and export
are Google's: the sheets pillar says so. The switch (`reach.to: 'google'`)
opens the spreadsheet in the system browser.

## Slides

Slides has no suggest mode. `google_slides_read` reads each slide's words
with shape ids; `google_slides_revise` checks its edits (replace words
everywhere, or set one shape's words) against the deck and holds them as a
`google.edit`, with each shape's slide and words as they were. No copy is
made: Drive puts a copy in the deck's own folders, where everyone who shares
them would see it. His press makes the edits in the deck itself, in one
`batchUpdate` bound to the revision just read (`writeDeckEdits`); words gone,
words replaced everywhere now standing in more or fewer boxes than he was
shown (`boxes`), in boxes whose words are not all as they were (`spots`, each
box's words whole, so a match moved to another bullet of the same box is
seen; `spotsForm: 2` marks that form, and a hold without it is read in
either form, round 1's per-box counts included, so a hold made before is never
stale for a change of form; a deck still at the revision he was shown is not
compared at all), or a shape holding other words than it did, leave the act
stale. A replace-all names the slides the card counted (`pageObjectIds`, the
ids of the deck just read for the act's `on`): without them Google matches
every page, a slide's speaker notes, layouts and masters included, which the
card never read (google/slides.ts `requestsOf`).

The slides canvas reads Drive's PPTX export from a mirror under
`<dataDir>/google/<hash>/deck.pptx` (`deckMirror.ts`). Opening checks the
Drive version; when Drive cannot be reached and a mirror was read before,
the mirror opens and the view says so (`mirrorUnreached`). Read again from
Google fetches a fresh export. The host swaps in the complete file after
checking its header. Present uses those bytes. The deck is read only here:
to change it, Open in Google, or Make a copy to edit, which writes a
`.pptx` he can see in Files (work-slides.md "Every format in"). The poll's
`behind` reaches the slides body through the `work.google` push.
[Slides pillar](work-slides.md)

## Changes

`poll.ts`: while an item shows a Google file, its Drive `version` is read
once a minute (a sheet view and the Doc's minute's check register it; a
closed item drops it). A version this host's own write made passes quietly;
any other is someone else's change: a sheet's grids read it again, a Doc
or deck's item is told it is behind, and a routine's `{on: 'file', source: google}`
trigger fires (`googleChanges`, `at: 'google'`). Nothing is polled for a
file no item has open.

## What is held

`google.edit` (`held.ts`): an agent's change to a Doc or a deck, above. It
takes no grant and no edit in the Outbox; Away releases none.

`share.google` (`held.ts`): letting a person into a file as reader,
commenter or writer, made by `google_share` and run only after his press or
a grant (matcher: account, people by address or domain, `upTo` a role). Its
way back is `google_unshare`, which takes back only a share recorded for
the asking thread's tree (`work_google_shares`).

## Save to Google

`work.google.upload({ itemId, account })` saves a new file to the owner's
Drive through Drive's format conversion. A document still uploads its
Word export, with suggestions arriving as Google's. Slides registers
its saved PowerPoint bytes with `registerUploadBytes('slides', read)`:
the file itself, or an import's converted snapshot. The call
returns the new file's ID and link. Sheets registers its own bytes with
`registerUploadBytes('sheet', sheetUploadBytes)` when its module starts
(sheets/toGoogle.ts; [work-sheets.md](work-sheets.md) "Save to Google
Sheets"): an opened Excel file as it stands, or a sheet of ours as the
.xlsx the model writer makes. On a host whose sheets module is not
running, the upload answers that Save to Google Sheets is not built yet.

The owner's save goes straight to Drive and records a result. Threads
have no upload tool. `uploadOfficeFile` checks, for every kind's provider:
the caller (never a thread, never another host's call through `ctx.peer`),
the item's file fence, and the library rule: a file from a shared library,
or a snapshot the Teams view made of one (`isTeamsSnapshot`), stays on its
host before any bytes are read.

## Proven against the fake

`fake.ts` is a `fetch` in the shapes of LifeOS's token route, the Picker's
redirect and the Drive, Docs, Sheets and Slides calls above, keeping
`drive.file` (a token reaches only picked or made files) and Docs' indexes
(a Doc held as characters with their suggestions). Its Drive is a tree:
folders (`parents`, My Drive's top `myroot`, which `root` names), the bin,
each file's sharing, and `files.list` a page at a time (`pageMost`). Tests:
`mapper.test.ts`, `docs.test.ts`, `grid.test.ts`, `index.test.ts`,
`write.test.ts`, and the Files place's `files/drive.test.ts`. The wire
tests check the deck mirror, Read again, the mirror shown when Drive cannot
be reached, the copy to edit by caller, the exact bytes and MIME type of a
deck's upload, a peer's upload and a Teams snapshot refused for every kind,
and the reply for a sheet where the sheets module has registered none.
