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

The screen: **Open from Google…** in the canvas's ⋯, a dialog with one
choice (the account; `PickDialog.tsx`), as Export is. Accounts come from
LifeOS's `calendarOps:accounts` rows; only those whose grant has
`drive.file` (`files: true`) are offered.

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
`behind`); otherwise a new mirror is read and the old one removed.

**Writing to Google** (`write.ts`, `work.google.write`, his only, never a
thread's): the mirror's blocks (`/internal/google/blocks` on the Work
service) are compared with what was last read (`DocBase`); the Doc is read
again; each changed paragraph is found there by the words it had, nearest
its old place, and only the differing words are deleted and inserted. New
text paragraphs go after the paragraph they follow, with their heading or
normal style; removed ones are deleted. All of it is one `batchUpdate` with
`writeControl.requiredRevisionId` of the revision just read; a revision
conflict reads again once. Not written, and said one line each: a paragraph
whose words changed in Google since, one holding a chip, footnote, soft break
or waiting suggestion, a table, a picture, a block of another kind. After a
write the base is matched again to the Doc as Google has it.

**An agent's edits** are always Google suggestions: `google_doc_suggest`
sends `{find, replace}` pairs (each `find` must stand once in a plain
paragraph) as one `batchUpdate` with `writeMode: SUGGEST`. The docs tools
refuse a Google item and name the google tools.

The screen: a Google Doc's ⋯ holds **Write to Google**, **Read again from
Google** and **Open in Google** before Export (`docMore.ts`). The open item
asks `work.google.watch` once a minute; when Google moved, one toast says so.

## Sheets

A spreadsheet is a held kind of the sheets pillar, `{at: 'google'}` in
`heldOf` (`grid.ts`), drawn as an opened file whose cell contents save:
loaded as a Univer snapshot from `spreadsheets.get` with grid data (sheet
ids are tab names), at most 200,000 cells. Every write is compared first:
the cells are read again and if any holds something other than what the
grid or the agent saw, nothing goes (`conflict`). What passes goes as one
`values:batchUpdate`, `USER_ENTERED` (text that looks like a formula is
written as text). An agent's cells are suggestions in
`work_sheets_suggestions` under `google:<fileId>` (`google_sheet_suggest`);
an accepted set is written as one update, a cell changed since stays a
conflict. `googleSource` is the spreadsheet as work-kit's `SheetSource`
(`formulas: 'store'`, `live: false`). History, structural edits and export
are Google's: the sheets pillar says so. The switch (`reach.to: 'google'`)
opens the spreadsheet in the system browser.

## Slides

Slides has no suggest mode, so an agent never changes his deck:
`google_slides_read` reads each slide's words with shape ids and
`google_slides_revise` makes a copy with its comments (`files.copy`) and
edits that (replace words everywhere, or set one shape's words) in one
`batchUpdate`; the copy's link goes to the thread and the Results. A deck
is not drawn in our slides canvas: it says it lives in Google.

## Changes

`poll.ts`: while an item shows a Google file, its Drive `version` is read
once a minute (a sheet view and the Doc's minute's check register it; a
closed item drops it). A version this host's own write made passes quietly;
any other is someone else's change: a sheet's grids read it again, a Doc's
item is told it is behind, and a routine's `{on: 'file', source: google}`
trigger fires (`googleChanges`, `at: 'google'`). Nothing is polled for a
file no item has open.

## What is held

`share.google` (`held.ts`): letting a person into a file as reader,
commenter or writer, made by `google_share` and run only after his press or
a grant (matcher: account, people by address or domain, `upTo` a role). Its
way back is `google_unshare`. Making a document of ours a Google Doc
(`work.google.upload`: our Word export uploaded with conversion, its
suggestions arriving as Google's) is his and lands in his own Drive, so it
is not held.

## Proven against the fake

`fake.ts` is a `fetch` in the shapes of LifeOS's token route, the Picker's
redirect and the Drive, Docs, Sheets and Slides calls above, keeping
`drive.file` (a token reaches only picked or made files) and Docs' indexes
(a Doc held as characters with their suggestions). Tests: `mapper.test.ts`,
`docs.test.ts`, `grid.test.ts`, `index.test.ts`.
