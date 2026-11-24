# Files and the editors on the phone

The phone's reader, its comments and review, Page Preview, and the hosted
editor on a file. Plan `.temp-code/plan-gVZtfM43w1Mv.md` (PF1 to PF7); the
landing note is `.temp-code/plans/landed/R3-phone-files.md`. The look is
docs/IOS-DESIGN.md "A file on the phone". Files' own page on the phone (browse,
search, New, Upload) is the Files build's (docs/agents/work-files.md, F9); a
file opened there lands on this build's reader page ("From Files" below).

The native clicker is built and has no way in yet: "The clicker" below.

## One open file: the reader page

- `FileReaderPage(client:item:thread:)` (ios/TempCode/Sources/Work/Reader/)
  is the page any screen pushes to show one canvas item full screen, by the
  route `Route.file(environmentId:item:sessionId:)` (a `CanvasItem` is
  `Codable`, so a launch restores the page). It wraps the kind's own view
  (`ItemBodyView`), which the thread's Item segment (`ItemPage`) shows too.
- The bar is the system's: the file's name (`ReaderVerbs.title`: without
  `.tcdoc` or `.tcsheet`), Ask (a key that may operate) and More. More's rows
  are one rule for both hosts of a file, `ReaderVerbs.of(item, facts)` in the
  client package: Find… (a PDF, a deck), Comments, Review Changes, Page
  Preview (a document) or Print… (a PDF, a deck), Share…, Make a Guest Link,
  Close. A row is there only when it can act: `ReaderFacts` carries what the
  host and the key allow (a key that may only read has no Ask and no Close),
  and a host that lacks a wire simply has no row.
- `ReaderFrame` wraps the kind's view on both hosts: the review row while
  changes wait, the sheets for comments and review, and Comment in the hosted
  editor's edit menu. `ReaderFile` (client) holds one file's `WorkComments`
  and `WorkReview`; a part counts only once its host has answered for it.
- The page and its frame act on the item as the host last pushed it
  (`ReaderFile.live`, from `work.canvas`): a file renamed or moved on the
  host is titled, previewed, asked about, commented and reviewed at its new
  path; the kind's view is built from that item too (so Ask's chip for a page
  or picked words names the new path) and is made anew when it moves. Once
  the host's list no longer holds the item (closed, its tab gone) the page
  fails closed: no More rows, no Ask, no comments or changes, and a page that
  saw the item listed closes (`ReaderFile.presence`). The page reads its
  item's list once as it shows (`WorkCanvas.load`): pushes sent while the
  phone was away are lost, and seating a file the desktop already had open
  sends none. From Files, Quick Look
  stands in for a refused document only while the item is still at the
  entry's path, and the file is seated once (back from a thread or Page
  Preview nothing is asked again). A
  comment sent before the move's push arrives still names the old path; the
  host's check of a comment write against its item is not built yet.
- A tap on a page, a slide or a picture hides the navigation bar and the
  kind's foot (stamp, notes, filmstrip), and a tap brings them back. The page
  keeps the bar's room above it, so nothing moves. The status bar stays.
- `ReaderCommands` is how the hosting page reaches the kind's view: Find
  pressed, whether the page owns Ask, and Comment for a document.

## Reading

- **A deck** is its render's pages, one slide to a page (PDFKit's page
  controller), with the slide's speaker notes under it and a filmstrip of
  every slide. The notes come with `work.slides.open` (`DeckPhoneViewSchema`
  reads `notes`). `DeckPager` (client) maps the render's pages to slides: a
  hidden slide keeps its page and is marked in the strip; `DeckPager.layout`
  gives the notes room only where two lines fit (a phone on its side shows
  the slide alone). While an agent's changes wait, the proposed render shows
  under the deck's own review row, as before.
- **The place he stopped** is kept per file for the last 200 files
  (`ReaderPlaces`, UserDefaults, by host and the file's key, so a file opened
  from a thread and from Files is one place). A new render keeps the page
  while it still exists; a deck follows its slide's key. The restore waits
  for the viewer to have a size, since PDFKit's first layout undoes an
  earlier go-to.
- **Renders in memory**: `ReaderCache` keeps the last three by file and
  `rev`, so a second open in the same run paints at once and then asks the
  host; bytes of another `rev` are swapped in. A render painted from memory
  shows no review row until the host has answered, and a deck's proposed
  render is never painted from memory (`DeckRender.paintsFromMemory`): an
  agent's slides with no row over them would read as the file. Everything is dropped on
  a memory warning. Nothing of a file is kept on the phone's disk
  (`ReaderCache.keepsOnDisk` is false: the owner's ruling). A video is the
  one thing the player must read from a file: its copy (`MediaFiles`, under
  the temporary folder) goes when its view closes, a picture's the moment it
  is decoded, and a launch removes any a crash left (`sweepAtLaunch`). The
  other is Files' Quick Look, which stands in for a document the hosted
  editor refuses (`hostedFallback`): Open the Original writes the file to the
  temporary folder while it shows (`OriginalFiles`, removed on close, swept
  at launch). A kept
  place is stored under a digest of the host and the file's key
  (`ReaderPlaces.key`), never a path or a name.
- **Loading** draws the paper's shape with a bar that follows the bytes read
  (`ChunkedRead.share`); a failure is one line with the host's reason and
  Try Again.
- `HostCan` (on `WorkHost`) remembers a method an older host refused as
  unknown (`bad request` with zod's "No matching discriminator") until the
  socket opens again. `WorkComments` and `WorkReview` ask through it: a host
  from before these calls is asked once a socket and has no row.

## Comments and review

The hosted page shows the owner no comments and no review, so both are native,
over the docs, history and sheets wire (`SUBSET` rows in
scripts/gen-swift-contract.ts): `work.docs.open`, `threads`, `thread`,
`work.history.branches`, `decide`, `work.sheets.open`, `review`, and the
`work.docs` and `work.sheets` pushes (they move `WorkHost.docsRev` and
`sheetsRev`, which a sheet on screen reloads on).

- `WorkComments`: a document's threads, open first then resolved; `post`,
  `reply`, `resolve`. A press the host refuses throws and changes nothing
  held, so the screen keeps his words. Bodies are the editor's block JSON on
  the wire and plain words on the phone. `DraftTarget.moved` is the field's
  rule: a tap on a thread, or the thread resolving, moves only an empty
  field; words keep their thread until he closes the "Replying to" line.
- Both drop the answer of a read that a newer one overtook, and `ReaderFrame`
  is the one place a push reloads them.
- `WorkReview`: a row per change. Accept All and Reject All send the ids of
  the rows on screen, never the host's "all": a change an agent added since
  the list was read is not decided unseen. The rows are taken, a
  `ReviewBatch` per branch, before the first call, so a push that reads a
  branch again between two calls adds nothing, and a refusal stays on the
  batch's own rows. A document's decision carries its branch's `editedAt` as
  the phone read it (`ReviewRow.revision`, `ReviewBatch.editedAt`, read
  through `HistoryBranchesPhoneSchema`): a block an agent rewrote since is
  refused by the host, and the row keeps its words. Taking part of a branch
  rewrites it on the host (its `editedAt` moves, and no push says so), so
  after each document decision the host takes the branches are read again
  before the next one, each refusal kept on its row. One decision runs at a time (`deciding`): `decide` and
  `decideAll` send nothing while one does, and Review Changes turns its
  swipes and bar off. A document's rows are the blocks of its
  pending branches (old and new words); a sheet's are its open suggestions
  (the cell, its value and the proposed one, the agent's reason once per
  change set, `ReviewGroup`). A decision the host takes drops the row; one it
  refuses keeps the row with the host's words. A sheet's cell the host found
  changed since (`conflict`) or moved (`orphaned`) says so on its row from the
  first read, and only Reject takes it (`ReviewRow.accepts`): Accept All on a
  sheet sends only the rows Accept can take, and when the host refuses part of
  it the sheet is read again, so its words stay only on rows still open. A
  format or a rule an agent proposed (`SheetView.changes`, carried by
  `SheetPhoneViewSchema`) is a row too: its words drawn as a document's added
  words, under its change set's reason, decided by its own id through
  `work.sheets.review` as a cell is; an `orphaned` one only Reject takes. The
  sheet view names a sheet by Univer's id, not its tab, so an address reads
  "C4".
- It works for LifeOS's documents, for documents kept as `.tcdoc` files and
  for sheets kept as files (`ReaderFile.parts`); not for a Word file.
- The page's review row over a document or a sheet only counts and opens
  Review Changes (`DeckReviewRow` with `decides: false` in `ReaderFrame`):
  the hosted page draws no suggestion marks for the owner, so a decision there
  would write changes he has not seen. A deck's row, in `PdfItemView`, keeps
  its buttons.
- `ChangeText` draws what went (struck through, red) and what came
  (underlined, green) for the history compare and Review Changes alike.

## Page Preview

`PagePreview` pushes a document as it will print, read from the host at one
`rev` (`PagePreviewSource`: pages that moved on under the read are refused),
with the system's Print. Its pages are its Word file as the host draws it
(`work.formats.preview {format: 'docx'}`, then `previewRead` by range): the
window's own print page needs a window, which a phone has not. The row is
there for a key that may act, on a host that has the call (`HostCan`); a host
with no LibreOffice says so where the pages would be. Not built for a sheet:
its pages wait for the sheets build's `work.sheets.preview`.

A PDF and a deck have no Page Preview: the reader already shows the pages
that print. More's Print… reads them at one `rev` (`WorkCanvas.printPages`: a
PDF as itself, a deck as its file's own render, never the proposed one) and
opens the system's print sheet (`ReaderPrint`).

## The hosted editor

- A LifeOS document or sheet opens `/w/open` with a ticket, as before. The
  ticket is asked the moment the item is the one to show (`HostedTickets`,
  used once, asked again after 90 s), and the web view is one made ready a
  moment after a Work thread with a document shows (`HostedWebPool`, its data
  store still not persistent), on screen before the ticket lands.
- **A document or sheet kept as a file** goes to the hosted view too
  (`ItemBody.of` names it by its item). `work.guests.ticket` takes
  `{at: 'item', itemId}` (docs/agents/work-guests.md "A file in the hosted
  editor"): a `.tcdoc` or a `.tcsheet` in a place of his own, on a host a
  phone can reach, opens and edits; anything else is refused in the host's
  words, which the phone shows in the file's place (`HostedFailure`): a Word
  or Excel file ("Edit it on your computer": the desktop's editor saves
  those), a file others can open, a computer that serves no public page.
  Comments and review still work natively for a `.tcdoc` it refuses; a Word
  file has neither on the phone (`ReaderFile.parts`: the docs pillar keeps no
  threads or branches for a `.docx`, docs/target.ts), so none is asked. A key that may only read
  is told so on any hosted item, a LifeOS row too (`HostedFailure.readOnly`):
  the ticket needs `operate`, and a Try Again would be refused for ever. A
  page already loaded asks no new ticket when it shows again (back from Page
  Preview, a swipe back to the Item segment).

## The clicker

A native screen that steps a slideshow running on the desktop (PF6; the look
is docs/IOS-DESIGN.md "The clicker").

- Built against a wire of closures, with no host call in it:
  `ClickerWire { state, press }` (ios/TempCodeClient
  Work/Clicker/ClickerModel.swift). The host's wire for a show,
  `work.slides.show.state`, `work.slides.show.press` and its push (the slides
  build's SLD9), is on master (contract-work-slides.ts, slides/clicker.ts);
  the phone does not call it yet.
- `ClickerModel` holds the show (`ClickerShow`: the deck's item and name, the
  slide from 1, the count, the notes and `notesSlide`, the slide they belong
  to, every slide's notes when the host sends them, `allNotes`, when it
  began, Blank, `rev`). A press answers at once: false where it can do
  nothing (Next on the last slide, Previous on the first), else the slide
  moves before the host answers and the press joins one queue. The queue
  sends a press only once the one before it is answered, the first on the
  `rev` he saw and each later one on the `rev` the answer before it left.
  Answers and pushes are taken by `rev`, so an older one never overwrites a
  newer, and while his presses are on the way a push behind them does not
  pull the count back. A refusal drops the presses queued behind it, puts
  the slide back to what the host last said and keeps its words
  (`ClickerRefusal`); the show ending, by a push or by End Show, sets
  `ended`.
- `ClickerModel.notes` is the notes only while `notesSlide` is the slide the
  count shows, else nil, and the screen draws nothing in their place. A
  press takes the new slide's from `allNotes` at once; without them, the
  host's notes are taken as soon as an answer or a push carries the shown
  slide's. SLD9's adapter should fill `allNotes` from the deck's notes.
- `ClickerPanes` (Shell/ClickerPanes.swift) is the layout rule: stacked
  upright, split on its side and on the Duo unfolded, on the division band
  where it leaves room.
- **No row on Home and no route.** The host's wire is there; whether the
  clicker gets a way in is the owner's ruling (landing note, "For the owner"
  6). Wired, one adapter file maps the generated types onto
  `ClickerWire` (state, press, the refusal's words through
  `ActionError.wrap`), the push feeds `ClickerModel.apply`, Home's Work
  section gains the Slideshow row while a show runs, and the deck's reader
  page shows the clicker in the slides' place.
- **Proven**: the model's rules (`ClickerModelTests`, `DuoLayoutTests`'
  `ClickerPanesTests`, run on the box in a scratch package with the Swift
  6.4.2 toolchain) and the screen's shots on a fake 12-slide show
  (`TC_TEST_CLICKER=show|first|last|blank|ended|refused|nonotes`,
  `TC_PROOF_SET=work TC_WORK_ONLY=clicker`, c01 to c12, c20 under a pose).
  **Not proven**: a live show stepped from the phone.

## Save to TempCode

The share sheet's way in: a file or a photo from any app into a Work
workspace's own folder. Target `TempCodeShare` (ios/TempCode/project.yml, an
app extension, `dev.landon.tempcode.ios.share`, the App Group
`group.dev.landon.tempcode`; it links the client and the contract and never
LifeKit: an extension has about 120 MB). It wakes for up to ten files or
pictures and three movies.

- **The sheet** is `ShareSheetView` on `ShareSheetModel`
  (ios/TempCode/Sources/Work/Share/, compiled into the extension and the app):
  what was shared, the Work workspaces with the last used checked, the folder
  (a picker of folders only, read from the host level by level with
  `work.files.list {foldersOnly}`), Save. `ShareViewController`
  (ios/TempCode/ShareExtension/) copies each shared file into its own
  temporary folder while the other app still lends it, then shows the sheet.
  It keeps a result per file: one it could not copy is named in the first
  group's footer and the rest still save; when none could be read the sheet
  says so with Done alone, never a silent cancel. Once Save is pressed the
  files are in the queue, so Cancel goes and Done alone closes. A file Save
  could not put in the queue (the phone could not keep its copy) is named
  first and the rest still go, with what became of them
  (`SharePhase.after(_:host:notQueued:total:)`).
- **One queue, one uploader.** `ShareInbox` (client, Work/Share/) is a folder
  an item in the App Group: the payload copied by stream with its sha256,
  then an atomic manifest written last, so a crash mid-copy leaves nothing
  that lists. `ShareUploader` begins with `work.files.upload`, sends the
  bytes from disk a chunk at a time (`attachment.chunk`), commits, and aborts
  on a cancel. A file over the host's limit is said before a byte moves
  ("<host> takes files up to 200 MB."); a host that cannot be reached leaves
  the item queued; a host's refusal is kept on the item in its words. The
  extension runs it right after Save; the app drains the same queue at
  launch, on foreground and when a host's state moves (`ShareBridge.drain`).
- **Claims.** A process takes an item by renaming its manifest and writes
  its own name in it (`ShareInbox.thisProcess`). Only a queued item can be
  claimed; only the holder may `mark` it; `discard` refuses while another
  process's live claim holds it; Try Again is `retry`, which moves a refused
  item alone, read from disk, and answers false for anything else. A claim
  untouched for `claimLease` belongs to a process that died and is taken
  back.
- **Ops.** Each begin sends the op `<item id>-<attempts>`, `attempts` kept on
  the manifest. The host answers the same upload id for the same op
  (`runOp`, upload.ts), so a begin whose answer was lost is sent again
  unchanged and starts no second save. Once the host answers an op it is
  spent and the next begin sends a fresh one: after an upload the host
  forgot, a connection lost mid-upload, or a refusal. A commit whose answer
  was lost is kept on the manifest (`committing`, the upload id) and asked
  again before anything else: the host keeps each commit's answer by upload
  id for a day (`AttachmentUploads.committed`, attachmentUploads.ts) and
  answers it again, so the file is not saved twice. When the host no longer
  knows the upload (it restarted, or a day went by), the phone sends the
  begin's op again: the host kept "landed" on the op's row when the file was
  made (`amendOp`, files/upload.ts; rows live a week), and answers
  `{uploadId, landed: true}`, which ends the item as Done. The host writes
  the path on the op's row before it makes the file (`landing`), so a stop
  between making it and saying so is settled when the op is asked again: the
  file there with the upload's sha256 is landed. Only an op whose file never
  landed begins anew; an op that cannot be read, or that the host answers
  with another upload id (it pruned the op after a week), keeps the commit
  pending, refused with his words ("… may already have this file. Look in …")
  and Discard, and begins nothing. The op's count and then the upload id are
  written to the manifest before a byte and before the commit go; a write
  that fails sends nothing more ("This phone could not keep track of the
  save"), with Try Again. Done is written with `committing` cleared in
  the same manifest write (`ShareInbox.mark`).
- **Final refusals.** What no retry can change is marked `isFinal` on the
  manifest (absent in an older one: retryable): the phone's "<host> takes
  files up to …", "The file is no longer on this phone." and "The file
  changed on this phone after it was shared." Its row offers Discard in Try
  Again's place.
- **What the extension knows** comes from the app: `ShareTargets` (the hosts
  and their Work workspaces, ordered by last use, with the last folder) in
  the App Group, and `ShareKeys`: a second copy of a host's key in the
  group's keychain, only for a key that may operate, removed when the host
  is. `ShareBridge.publish` writes both whenever the hosts or their
  workspaces change.
- **Only a workspace's own folder** is offered: the picker starts at the
  workspace's own folder and lists only the folders under it. A `ShareFolder`
  could name any folder of a host; the picker never offers one outside.
- The folder picker reads with the Files build's own contract rows
  (`work.files.list`, `FilesListing`, `FolderRef`): the phone names each row
  once. It does not go through `FilesHost`, which lists whole folders a page
  at a time for a screen; the picker asks for folders only.
- It raises no notice. The sheet says how the save went; an item the host
  refused shows at the top of the next sheet with Try Again (a spinner while
  it goes) and Discard, and at the head of its workspace's Files screen in
  the app (`ShareRefused`, `ShareRefusedSection`,
  ios/TempCode/Sources/Work/ShareRefused.swift; the rows are
  `ShareInbox.refused(hostId:workspaceId:)`). In the sheet, a row whose host
  is no longer in the list reads "That computer is no longer on this phone."
  with Discard: Try Again never deletes.
- The sheet's words and states are pure rules with tests (`SharePhase`, its
  bar weighted by each file's bytes; `ShareSummary`, with what could not be
  read; `ShareFolders` in `ShareSheetRules.swift`).

Proof: `TC_PROOF_SET=work TC_WORK_ONLY=share` opens the same sheet over Home
in each state (`TC_TEST_SHARE`, `ShareProofSheet`; `unread` and `unread-all`
draw a file not read), then makes one real save;
`verifyShare` reads the workspace's folder back by the file's sha256. Not
proven: the sheet from another app's share sheet (the simulator registers the
extension; the drive was not run), and a large video on a phone network.

## From Files

The Files place on the phone is the Files build's; three things in it are
this build's (PF5).

- **A file opens on the reader page.** `FilesOpen.page`'s `.item` line draws
  `FileItemScreen`, which seats the file (`work.files.open`) and shows
  `FileReaderPage(client:item:thread: nil, workspaceId:)`: the same bar, More
  and sheets as a file open from a thread.
- **A row opens by the place it lives in.** Recent and Starred rows (and a
  search's) carry no home or sharing from the host (files/handle.ts
  `markEntry`), so the phone finds the home place itself
  (`FilesRules.knownHome`, `homeId`): the row's `where`, else the place whose
  top folder holds its path on its host, the longest such. A file in a
  library others can open shows facts alone; a file no place is known to hold
  shows facts too, unless it is his own mail's or LifeOS's (`isOwn`).
- **The hosted editor first.** A document or sheet kept as a file in a place
  of his own is seated too (`FilesRules.opening` answers `.item` for a key
  that may operate), so a `.tcdoc` or `.tcsheet` edits on the phone. Where
  its host will not open it there (a Word or Excel file, a computer with no
  public page) Files' Quick Look stands in the file's place, read only, with
  the reader's bar still over it, with what More has for the file: an Excel
  file keeps Review Changes; a Word file has no comments, changes or Page
  Preview on the phone. The screen hands Quick Look in through the environment
  (`hostedFallback`); a file open from a thread has none and shows the
  host's words.
- **Ask with no thread** (`FileAsk`, client Work/Reader/). The reader page
  shows Ask for a key that may operate. On Send: `work.files.threads {ref}`;
  the newest thread the phone knows that holds the file and is not archived
  gets the words (`session.send`). Where none does, the phone does what the
  desktop's docked chat does (docs/agents/work-files.md "Ask"), in its
  order: `session.create` in the workspace with the file's chip as `about`,
  `work.canvas.open` with the file's kind, source and title, then
  `session.send`. He lands in the thread, which opens on its Item segment
  (the file), Chat one swipe away. Nothing is made until he sends. The phone is
  stricter than the desktop in two things. Where the file will not open in
  the new thread the words do not go: the sheet keeps them with the host's
  reason, and Send again opens the file in that same thread and sends
  (`FileAsk.NotSeated`). And a lookup that fails is said, never read as "no
  thread holds it": only a host from before `work.files.threads` starts a
  thread unasked.
- **Quick Look's pages are of one version.** Each page the host draws names
  the file's version it is of (`FilePreview.version`, a digest); the first
  pins it, and a page of another version (the file saved on the computer
  between two reads), or a page the saved file no longer has (its answer
  names the version too), starts the pager over from page 1 of that version
  with its count (`FilesRules.startsOver`); a reply to the pager before the
  start-over is dropped. The start-over runs in the screen's own task, not a
  page's (the pager it replaces would cancel it): a spinner while it reads,
  and a page 1 that does not come says why with Try Again. No two pages of different versions show together.
- **Share…** has no row. The one way to share a file from the phone today is
  the guest link, which is its own row (Make a Guest Link, a LifeOS document
  or sheet, a key that may approve). No wire lets a remote key draft a mail
  with a file, so there is no second way to list; `ReaderFacts.shares` is
  the switch for when one exists.

## Proofs

- Pure logic runs in `swift test` (ios/TempCodeClient: `ReaderTests`,
  `ReaderReviewTests`, `FileAskTests`, `WorkItemsTests`, `ShellPathsTests`). On the box the
  files that need no socket also run in a scratch package with the Swift
  6.4.2 toolchain; anything on `FakeWebSocket` needs the Mac.
- The simulator: `TC_PROOF_SET=work TC_WORK_ONLY=reader bun
  scripts/ios-sim-proof-local.ts`. The seeds are `seedReader` and
  `seedReview` (scripts/lib/ios-work-seeds.ts): a deck with notes, an
  eight-page PDF, a picture, a `.tcdoc` with a comment thread and a waiting
  suggestion, a `.tcsheet` with a waiting change set. `verifyReview` reads the
  host back after the phone's presses into `work-report.txt`. Launch hooks:
  `TC_TEST_ROUTE=reader` with `TC_TEST_ITEM`, `TC_TEST_ACTION=reader-page:<n>`,
  `reader-tap`, `review-accept-all`, `comment-post:<words>`, and
  `TC_TEST_SHEET=reader-preview|reader-comments|reader-review|reader-comment`.
- From Files: `TC_WORK_ONLY=files` walks the first Work workspace's Files by
  names (`TC_TEST_FILES`, "@folder" for the workspace's own folder) to a PDF
  on the reader page, the Ask sheet (`TC_TEST_ACTION=files-ask`), a `.tcdoc`
  the test server will not open in the hosted editor (Quick Look in its
  place), a refused save at the head of Files (`files-refused`), then sends
  one Ask about a PDF no thread holds (`files-ask:<words>`); `verifyFilesAsk`
  reads back that a new thread holds it as its item.
- The host: src/main/server/work/guests/fileTicket.test.ts (every refusal, a
  `.tcdoc`'s room, an edit written to the file, the sheet socket held to the
  pass).
