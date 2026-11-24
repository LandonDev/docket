# Work: money, receipts to a ledger by job

A receipt reaches the right job's ledger in two presses: drop it (or
photograph it, or press File as receipt on a mail's file), check four fields
beside its picture, Save. The ledger is a real sheet he can open and edit,
and what he edits there is what Money shows. Built 2026-11-23 (round 3, row
6; plan `.temp-code/plan-VWTDbboLt6UA.md`; landing note
`.temp-code/plans/landed/R3-money.md`). Pillar `money`, milestone 60.

Nothing here moves money, nothing is sent without his press, and no model
is called anywhere: a receipt is read by a tool on his own machines.

What it does not do: bank feeds, payments, tax forms, more than one
currency, a Money page on the phone.

## What is kept where

| Thing | Where |
|---|---|
| Ledger rows | `<workspace folder>/Money/Ledger.tcsheet`, tab 1. **The sheet is the truth**: Money keeps no copy of a row. |
| Mileage log | `<workspace folder>/Money/Mileage.tcsheet`. Miles are not cash, so they are not in the ledger's sums. |
| Receipts | `Money/Receipts/<year>/<date> <who> <amount>.<ext>` |
| Invoices, a year's export | `Money/Invoices/`, `Money/Tax <year>/` |
| What waits for his accept | table `work_money_inbox`, its files under `<userData>/work-money/incoming/<id>/` |
| Which sheets are a job's, his mileage rates, his invoice details and terms | table `work_money_books`, one row a workspace |
| Miles there and back to a place | table `work_money_places` |
| Calendar events added or skipped | table `work_money_events` |

Everything is on the job's own host. Nothing of money goes to LifeOS and a
receipt's bytes never leave his machines. `work_money_books.home` (`file`)
and `.calendar` (`games`, `all`, `off`) are the two rulings built to flip;
nothing reads `home` yet.

A `.tcsheet` and not an `.xlsx`: the Work service's `/internal/sheet/*`
routes serve a `.tcsheet` by path and a LifeOS sheet by id, and nothing
else. Money makes, reads and writes its sheets through those routes
(`ctx.service.internal`), as forms does, and imports nothing of the sheets
pillar. The Excel file is the export.

## The ledger (`src/shared/work/money.ts`, `work/money/book.ts`, `read.ts`)

Columns: `Date | Who | For | Category | In | Out | Status | Paid on |
Receipt | Ref`. `In` and `Out` are two columns of dollars, so a plain `SUM`
works in the sheet. `Receipt` holds the file's path under `Money/` as text.
`Ref` is an id Money writes (`m` and 24 hex letters; five in rows written
before 2026-11-23, read all the same); a row he typed has none and is read
all the same.

`src/shared/work/money.ts` is pure (no zod, no node): the columns, the
statuses, the categories, the sums, the receipt parser, the CSV and the two
pages Money prints. Amounts are whole cents everywhere but in the sheet.

- **Reading** (`rowsOf`): columns are found by header name, in any order and
  any case, with his own columns among them. A date is ISO text, a US date
  as he may type it, or a sheet's serial number. A row with no date, name
  or amount is a blank line. A row with money and no date Money can read
  (blank, "TBD", "Nov 21" with no year) is in no month and no year, so no
  period's sum counts it: the read names such rows (`undated`, the problem
  `{kind: 'undated', rows}`), the view says so under Entries with Open
  ledger, `money_read` says it, and a year's export carries it as a warning
  (`undatedWords`, one sentence for all three). A `Date`, `In`, `Out` or
  `Status` header that stands twice reads no rows: which of the two holds
  his figures cannot be said (`twice`, also in `missing`; the view's line
  says "Two Out columns" with Open ledger, and Restore is refused). A
  missing `Date`, `In` or `Out` header reads no
  rows and answers `problems: [{kind: 'columns', missing, renamed}]`;
  `work.money.open {restore: true}` writes the missing headers at the end
  of row 1, each in the first cell past the headers that nothing else
  waits in (`restorePlan`, one plan for the read and the write). `waits`
  on the problem: those very headers, by name, already wait there as a
  suggestion (past the last header: a suggested change to a header that
  stands is not a restore), and a second restore writes nothing more.
  `renamed` names every column Money does not know that holds
  cells ("Spent", or "column F" for cells under no header): with any, a
  header was most likely renamed, and the restore is refused, since an
  empty Out beside his figures would read them as nothing. He names it
  back in the sheet. Status is such a header too while a column Money does
  not know holds a status's words ("Unpaid" under "State"): read without
  it, every unpaid row would be money in hand. A ledger that never had a
  Status column reads, every row Paid. Money never reorders or deletes his
  cells. A figure below nothing (a correction he typed) keeps its sign in
  every sum and export, as the sheet's own SUM counts it; the form cannot
  say such a row (`sheetOnly`), so it opens read only, as a row with money
  both ways does. `moneyWords` is the one form of a row's money in words.
  Cents are rounded half away from nothing through a float's noise, as the
  sheet's ROUND does (`centsFrom`, `wholeFrom`): -1.015 is -102 cents
  whether he typed a number or text.
- **Status** is `Paid`, `Unpaid`, `To reimburse`, `Reimbursed` or
  `Requested`, read without regard to case; an empty or unknown word is
  `Paid`. What a row counts as (`countOf`):

  | Row | Counts as |
  |---|---|
  | In, Paid | income |
  | In, Unpaid | owed to him |
  | Out, Paid | cost |
  | Out, Unpaid | he owes |
  | Out, To reimburse | cost he paid, and owed to him |
  | Out, Reimbursed or Requested | not his cost: left out of Out |

- **The rev cache** (`gridOf`): `/internal/sheet/open` gives the sheet's
  revision; unchanged, the cells come from memory; changed, row 1 and then
  pages of `/internal/sheet/range` down to the sheet's last row that holds
  anything and across to its last column that does. Both are found from
  the workbook itself (`/internal/sheet/snapshot`, `extentOf`), so a
  stretch of blank rows he left, however long, never ends the read or
  misplaces the next append, a row that holds only a formula is a row, and
  figures under no header are still seen ("column K" in `renamed`), however
  far out (past AZ too, up to 1,024 columns). A cell made rich in the cell
  editor keeps its words in its document (`p`) alone and is counted all
  the same, so no append writes over a last row he typed that way. A workbook past 32 MB is not
  asked for at all: Money reads no such sheet ("too large"). A read is
  whole or it fails: when the sheet cannot say how far it goes, the read is
  tried again (three times) and then fails, so no reading that may have
  stopped short is kept, summed, exported or appended under. A read is of
  one revision too: the sheet is opened again after the last range, and a
  revision that moved meanwhile makes the read start over. A sheet wider
  than 1,024 columns is read to there (`Grid.partial`) and repairs
  nothing: Restore is refused on it.
- **`any`** on the read says whether the job has money at all (a ledger row
  or a trip in any period): the view's empty state hangs on it, not on the
  period on screen.
- **A plain entry from the form** (`work.money.entry {key?}`, `entry.ts`):
  the entry dialog sends one key for its life, as the trip and invoice
  dialogs do. Its outcome is a row of `work_money_inbox` (source `entry`,
  never in To confirm): the Ref and figures noted before the ledger is
  touched, then what was filed. A Save sent again after a lost answer finds
  its row by that Ref and adds nothing; one with other figures is told what
  was saved. A call with no key adds a row each time, as before.
- **Appending** (`appendRow`): the service has no append. Under a lock per
  workspace (`locked`) the ledger is read for its last row that holds
  anything and the new row's cells are written at once with
  `/internal/sheet/cells` (`by: 'money'`). A sheet others can open
  takes the row as a suggestion and the answer says `suggested`; the
  window then says "Suggested in the ledger. Accept it there." A new row
  goes under every cell that waits as a suggestion, by where the sheet's
  own `open` says each stands now (`Grid.pending`, `nextRow`), so two
  suggestions never name one row, after an accept and after a restart
  alike. Others can open it when the sheet says so
  (`open().shared`) or when the job's folder lies in a place Files calls
  shared (`othersCanOpen`, Files' own `sharedOf`): a synced folder shares
  a file the sheet service knows nothing about. A row that keeps a file
  needs a Receipt column to name it; without one the write is refused
  ("The ledger has no Receipt column, …") and the file is not kept. A row
  that is not Paid needs a Status column to say so, and is refused without
  one (`needs`).
- **Written once** (`appendRow {ref}`, `writtenRow`): a write with more
  than one step (a receipt's accept, a kept invoice, a trip and its pay)
  notes the Ref its row will carry before the ledger is touched. Taken up
  again after a stop between the sheet's write and the note, it looks for
  that Ref in the ledger and among what waits there, and writes nothing
  twice. Only an add taken up again looks: a new row is always a new row,
  and a row found by Ref must also name the file the note names. Both marks
  are looked for in every cell of a row (`writtenAt`), never under a
  header's name: a Receipt header he renamed since must not make a row that
  is there read as never written, or its kept file would be removed. The
  one row that holds the Ref is the add's also when he renamed the kept
  file since (the noted file is gone, and the row links another file in
  the same folder: the link followed the rename). A Ref in two rows, or in
  a row that names another file while the noted file is still there, is
  never settled by a guess: nothing is written and the error names the row
  ("Row 7 of the ledger may already hold this one. Check that row: if it
  is this one, discard it here; nothing is deleted.", `AmbiguousRow`): his
  Discard on that sentence is his word, and the receipt stops waiting with
  its note kept and no file deleted. A receipt whose half-done accept went
  into a job since removed is discarded the same way. A found row answers
  the link it holds now (`link`), read raw from the row, so a kept invoice
  is filed under the name it was renamed to whatever the headers say.
  Marks are compared as the reader reads a cell (`sameCell`: the spaces at
  its ends put aside).
- **A read that failed is never "nothing there".** Before Money deletes a
  kept file, discards a receipt, holds an invoice number or writes a row
  again, the sheet it would settle by must have been read: a ledger that
  does not answer, leads out of the job, or is gone from the place on
  record stops the press with "Money cannot tell yet …" and changes
  nothing (`settleBegun` for a receipt's Save and Discard; a begun invoice
  keep and a begun trip refuse while their sheets are not at their place,
  where `openBooks` would make empty ones; the numbers an invoice may take
  are read from every cell of the ledger, and a ledger that cannot be read
  holds no number). No sheet is made in place of one on record that is
  gone while any write into the job is unsettled (`openBooks`,
  `unsettledIn`: a receipt's, an invoice's, an entry's or a trip's note),
  whichever press would make it. A ledger read only to its 1,024th column
  (`Grid.partial`) finds a row there, and never proves one absent
  (`TOO_WIDE`); nor does it hold an invoice number. A job whose ledger is
  gone from its place on record (`ledgerMissing`) is `problem` in the sums
  and in what is owed, a failed read in the view ("The ledger is gone from
  its place in the job's folder. Put it back, or choose Open ledger under
  More to start a new one.") and an error from `money_read`, never "No
  money yet"; a job with no books on record (or a folder copied with its
  mileage log alone) is still a job with none. A write
  that throws is settled by a fresh read at once (the sheet may have taken
  the row and lost its answer): found, it is filed; not readable, the file
  and the note stay for the next try; not there, nothing is left behind.
- **A mileage log with no ledger beside it** (a job's folder copied in
  part) is read all the same: its trips are the job's, or its fault is
  said, never "No money yet".
- **A ledger already at its place** with no record of it (a job's folder
  copied from another machine) is the job's from the first read (`adopt`:
  only the record is written). A job is a Work workspace with a sector:
  one with none has no Money view in the frame, so it keeps no books, is
  not listed by `work.money.state`, and takes no receipt.
- **A ledger that leads out of the job** (its file a link) is neither read
  nor written, and is a fault, never an empty job: the read fails with the
  sentence, the sums and what is owed say `problem`, and no fresh ledger is
  made beside it. A mileage log in that state, or one the sheet service
  cannot open, is the log's own fault: the ledger still reads, an entry is
  still written, and `work.money.open` answers the ledger with `mileage:
  null` (`openBooks(…, 'ledger')`).
- **Inside the job's folder** (`moneyFolder`, `insideJob`): every folder
  Money writes into is made one level at a time and checked by its real
  spelling. A `Money` folder, or a ledger, that is a link out of the job's
  folder is refused: nothing is read or written through it.
- **Acting on a row** (`editRow`, `payRow`): the window names the row as
  `{ref, row, sig}`, where `sig` is a print of every cell Money reads of it
  (each kept apart, one length however long his words are), as the
  window last read them (`sigOf`). The host reads the sheet again and finds a
  row Money wrote by its `Ref` wherever it now stands, a row he typed by its
  number; either way only while it still reads the same (`findRow`). A Ref
  that is gone or stands twice finds nothing: the row now at its number may
  be another that reads the same (two $75 games filed apart, the first
  deleted). A row he changed since the
  window read it answers `{changed: true}` and nothing is written, so an
  edit of one field never puts another cell back and Paid never settles a
  figure he did not see. Only the cells whose reading differs are written.
  A change that already waits in those cells as a suggestion is not
  suggested twice: the same one is answered, a different one refused until
  he settles the first in the sheet.
  A row he typed is never given a `Ref`. A row he typed with money both in
  and out has no one direction, so the form cannot change it: the host
  refuses the edit and the window shows it read only, with Open ledger.
  Paid is refused on it too (one status covers both sides); the owed rows
  carry `both` so the window offers Open ledger in Paid's place, and the
  tax summary prints both of its figures.
- **The look** (`dress`): a bold first row that stays in view, set once at
  create through `/internal/sheet/apply` (raw sheet mutations).
  `real.test.ts` holds that both reach an exported Excel file. Currency
  format waits for the sheets build's named styles.

Categories (`CATEGORIES[sector]`, then every word the ledger already uses;
`work.money.state` answers each job's the same way, for the phone's picker,
waiting at most 400 ms on a job's ledger so a sender's check before Save is
never held by one slow sheet):
ref: Game fees, Mileage, Uniform and gear, Dues and registration, Training,
Travel, Meals, Other. unify: Sales, Software, Hosting, Contractors,
Equipment, Fees, Travel, Meals, Office, Taxes, Other. purdue: Equipment,
Events, Travel, Food, Software, Supplies, Other. cosmic, hypixel: Pay,
Software, Equipment, Travel, Other. life: Home, Food, Health, Travel,
Giving, Other.

## In: one list (`work/money/inbox.ts`)

Every way in makes one row in `work_money_inbox` (`partial` → `reading` →
`ready` → `filed` or `dropped`) by the sender's own key, so a retry files
nothing twice. Only his accept writes the ledger. A key is one receipt of
one job: sent again under another job it is refused. One call a key at a
time (`keyed`), so two parts that land together put the file together and
file it once.

- **Bytes** (`work.money.receive`): parts of at most 2 MiB as base64, 25 MB a
  file, written as they land (any order) and put together when the last is
  in (`parts.ts`). A window on the workspace's own host may send `file:
  {at: 'file', host, path}` instead, and the host copies it after
  `ctx.reaches(by, path)`. Pictures and PDFs only, by `receiptFileName`: a
  name with an extension Money takes, else a picture's or a PDF's type
  gives the name that extension (a mail's attachment with none). A receipt
  names its job
  by `workspaceId`, or by `sector` (the phone): the first Work workspace
  here in that sector.
- **The sender's own reading**: with `lines` (the phone's reader) the host
  does not read the file again. With `fields` holding an amount and a date
  it is filed at once, as his accept; else it waits. With `seen` (the
  sender had shown him what the parser read) a field he left empty stays
  empty; without it, the host's own parse fills what is empty.
- **Accept** (`work.money.accept {id, fields, workspaceId?}`): the file is
  copied to `Money/Receipts/<year>/` under `receiptName` with an exclusive
  create, never over another file ("… (2).png"), the row is appended with
  the path in Receipt, and the waiting one is filed. `workspaceId` sends it
  to another job. If the row cannot be written the kept copy is removed and
  the receipt still waits; a phone's Save sent again under the same key
  with an amount and a date then files it, once the ledger is right. The
  accept notes what it means to write on the waiting row first (`Intent`:
  the row's Ref, the job, the file it kept): after a stop in the middle
  the next accept finds the row by that Ref and files nothing twice, or
  finds none and lets go of the file that accept kept. The job that accept
  was filing into is read only for a caller who may ask about it. A receipt whose own
  file is gone from this host is not filed. Every accept and every discard of
  one receipt runs in that receipt's own queue (`turn`), each reading the
  row afresh when its turn comes, however the one before it ended: two
  presses that waited behind a first that failed file one row. The intent
  keeps the figures of the press that wrote it: a row found later by that
  note is filed with them, and a later press that asks for other figures
  is told. A press on one filed already answers the first only
  when it asks for what was filed (the same figures and the same job, kept
  beside the answer as `as`); one that differs (a second window, a phone's
  draft edited after a lost answer, or a field he cleared there after a
  complete Save) is refused with what was filed ("That receipt was
  already filed: $10.43 on Nov 21, 2026. Change its row in the ledger."),
  so no window or phone closes on figures the ledger does not hold. A
  caller who may not ask about the job it was filed into hears only "That
  receipt was already filed in another job." (or a plain `filed`), never
  that job's figures or row.
- **Drop** (`work.money.drop {id, undo?}` → `{dropped}`) takes the receipt out of the
  list and keeps its file a week (a phone's scan is the only copy once the
  phone has let go of its draft), so `undo` puts it back as it was. A
  retry of a dropped key answers `dropped` and brings nothing back; a
  reading that ends after the drop does not either. A discard first
  settles an accept of it that was begun and not settled: its row found,
  the receipt is filed and the discard says it did not take; its ledger
  unreadable, nothing is discarded and he is told. A discard waits behind
  an accept of the same receipt and answers `dropped: false` when that
  accept filed it: the window then says "… was already filed", with no
  Undo, and the confirm dialog moves on, since it no longer waits.
- **A restart** (`resume`, in the module's `start`): rows left `reading` are
  read again, parts nobody finished in a day go. Filed and dropped rows are
  kept for good, a sender's key and what came of it: after 30 days only
  what was read (`lines`) goes. A phone's draft kept through a lost answer
  may be sent again months later, and must hear filed or discarded, never
  file the scan afresh.
- **A picture** (`work.money.picture`): a waiting receipt by `id`, or a
  filed one by `workspaceId` and its Receipt cell (held inside the job's
  Money folder by real path, the Money folder itself inside the job's). In
  parts of 2 MiB. A HEIC or TIFF is shown as
  its JPEG, a PDF as its first page.
- **A file that moves** (`moved.ts`): Money registers `registerFileMoved`.
  The ledger or the mileage log renamed in Files is followed in the books'
  row; a receipt renamed inside the Money folder has every Receipt cell
  that held its whole path (as the paperclip reads it, ends trimmed)
  rewritten, a moment after the rename's savepoint, read raw from the
  column under the Receipt header: a ledger
  that cannot be read as money just then (Out being renamed) keeps its
  link all the same (`relink`). Only that column is written: a cell of his
  elsewhere that reads the same (a formula mirroring Receipt) stays. With
  no Receipt header, or two, nothing is written.

A write tells every window on the job (`work.money`), so one that did not
make the press reads again.

### From an agent (`work/money/tools.ts`)

Offered to a job's thread alone (a Work Chat gets none):

- `money_read {from?, to?, category?}`: read only. Sums, what is owed, the
  mileage line, then each entry.
- `money_add {date, who, amount, way, category?, for?, file?, key?}` and
  `money_receipt {file | item}` land in To confirm with the thread named.
  Each `money_add` call is an entry of its own, two equal ones too (two
  $12 parking fees on one day); only its own `key` sent again makes a call
  a retry of the first. A `money_receipt` is keyed by its file.
  A file must be in the job's own folder or among the files the canvas
  keeps for that thread's own pane (a mail's attachment one of its items
  fetched): not another thread's, not another job's waiting receipts. The
  file is copied before anything waits, so a copy that fails leaves
  nothing behind and the call can be made again. No tool writes the
  ledger.

Every wire method that changes something (`MONEY_OWNER_ONLY`) is refused for
a thread's own call before its params are read, and for a call from another
host (`by.peer`, which only a thread's tool makes there).

## Reading a receipt (`work/money/reader.ts`)

1. **A picture**: a HEIC or TIFF first through `ctx.convert({to: 'jpg'})`
   (media's). Then Money's own converters, `jpg` and `png` → `lines`
   (`needs: 'docling-models'`): a short Python script written to the job's
   scratch folder and run with the Docling venv, RapidOCR with the PP-OCRv6
   small weights from the Docling models folder, offline. It prints
   `[{text, box, score}]`. A host without the tool forwards the job to one
   that has it (the box); a host with no box in reach gets no lines.
2. **A PDF**: `pdf → extract` (the pdf pillar's, first two pages); when it
   has no text (a scan), `pdf → png` at 2000 wide, then step 1.
3. **`parseReceipt(lines, {sector, known})`**, the only parser: runs on one
   line are joined by their overlap in y; the amount is the figure beside
   the last of Total, Amount due, Grand total (a figure on the next line
   when the label stands alone) that names a sum; a Balance only where no
   total does (a gift card's remaining balance, change due and a paid
   invoice's zero balance never stand for the total); else the largest
   money figure, leaving out a figure such a label names (on its line, or
   on the line under it when the label stands alone; a figure alone may
   carry its currency's code, "USD 91.75");
   the date is the first that is not after today; the seller is the first
   line of words above the first figure; the category is the one he last
   gave that seller in this ledger, else what the receipt's words say when
   the job has such a category. Each field may be null.
4. A file that cannot be read is `ready` with empty fields. No error is
   shown for a field that could not be read.

`reader.proof.test.ts` runs the real reader on the eight made-up receipts
(`fixtures/`, drawn by `fixtures/draw.ts`; none is anyone's). It runs only
where asked: `TC_MONEY_TOOLS=<userData> … vitest run
src/main/server/work/money/reader.proof.test.ts`, through `heavy` on the
box. About 4 seconds a file.

## From the calendar (`calendar.ts`, `mileage.ts`)

- The host reads `events:range` for the job's sector, the last 60 days, as
  the owner, at most every ten minutes. Offered once: an ended event with a
  `role` or a US-dollar `amount` that `work_money_events` does not hold.
- Fee: the event's amount in dollars; an event with no amount takes the
  last fee he gave an event with the same role; one that names an amount
  in another currency, or zero, is not known (never an older fee in its
  place). Miles: the ones he gave that place in this job (`work_money_places`,
  by job and place: two jobs start from two places); else the clashes
  pillar's `milesBetween`, there and back. A leg Clashes did not
  measure along roads fills the miles with `measured: false`: the view then
  offers Review, never Add.
- `work.money.trip` writes the pay to the ledger (money in, Unpaid, under
  `payCategory(sector)`) and the trip to the mileage log (`Date | Trip |
  Place | Miles | Rate | Value | Ref`, Value a formula), keeps the miles by
  place, and marks the event added. One add an event at a time. The log is
  asked first whether it can take a trip, so the pay is not written and
  then left without one for a cause known beforehand. What the add means
  to write is noted before either sheet is touched (`TripIntent`: a Ref
  for each row, the miles, the day, the words and the rate): an add not seen to its end (a write failed,
  the host stopped between the two sheets) stays offered (`adding`), as
  that add meant it, and the next add looks for those rows and writes only
  what is missing, on the day and at the rate its first row was filed
  with, so pay and miles never stand on two days (or two years' rates) for
  one trip; the fee that was written stands, also when he skipped
  the event since and picks it in Add → Trip… (`reopen`: only his own
  pick takes a skipped event up again; an offer's Add that finds it
  skipped answers `skipped` and writes nothing). A trip typed by hand goes
  by the sender's `key` the same way, and every answer (a calendar
  trip's too) says what was filed (`filed`: miles, fee, day, trip and place), so a form changed
  since is not taken for saved: the dialog stays and says what is in the
  books. The log's Value is `ROUND(miles × rate,
  2)`, so the column's total in the sheet is the total Money says. A log others can open
  takes the trip as a suggestion on a row of its own, and the answer says
  so. The log is read and written only inside the job's folder, as the
  ledger is. `work.money.events` (Add → Trip…) leaves out an event already
  added, and a trip that names one answers `already` and writes nothing.
  `work.money.skip` marks it skipped; `undo` offers it again (a begun add
  keeps its note through both). A Skip waits behind an Add of the same
  event that is being written, and answers `{skipped}`: false when the Add
  came first, and the toast then says it was added, never "Skipped".
- The rate is `rateFor(year, his own)`: his for that year, else
  `MILEAGE_RATES` ($0.70 for 2025), else the newest year before it.
  `work.money.rate` sets a year's. A rate is printed as it was given
  (`rateWords`), never short of what the value was worked out with.
- A trip is written only into a log with Date, Miles, Rate and Value, each
  once: a log where one of them stands twice (a Miles column copied, the
  old cleared) reads no trips (`reason: 'twice'`), is refused for export
  and takes no trip, since the trips under the second would be left out. A
  log's trip with no date Money can read is named as the ledger's undated
  rows are (`{kind: 'undated', rows, book: 'mileage'}`): a line in the
  Mileage section with Open mileage log, and a warning in the export,
  which goes on. A
  log that cannot be read (`mileageLog`: its file leads out of the job's
  folder, the sheet cannot be opened, or it holds rows and lacks Date,
  Miles or Rate) is `problems: [{kind:
  'mileage', reason, missing}]` on the read: the miles shown are none and
  the view says why; the sums carry `problem`; the export is refused.

## Out (`out.ts`)

- `work.money.export {year, csv, xlsx, pdf}` makes `Money/Tax <year>/` with
  `Ledger <year>.csv` (`csvOf`, RFC 4180: the year's rows, then the mileage
  rows) and `Ledger <year>.xlsx` (`ctx.convert({from: 'csv', to: 'xlsx'})`),
  and answers the summary's page (`taxSummaryHtml`). A second export
  replaces the first's files and says so (`replaced`, for the files it
  wrote over). One export a job and a year at a time, the Excel file made
  from that read's own CSV in the host's data folder; a year whose mileage
  log cannot be read is not exported. Each export has a `generation`
  (kept by year in `work_money_books.exports`); the summary's `keep` sends
  it back, and a page that is not of the year's newest export (an older
  one's, one that names none, or one for a year never exported) is refused
  (`staleSummary`), so a slow window never leaves an old summary beside new
  files. Everything asked for is made first and then put in the folder
  together, the folder checked again after the wait for the conversion.
  The folder holds one export: a file of an older export that this one
  does not make again (a format he unchecked, an Excel file that could not
  be made, the last summary until the window brings the new one) is
  removed, each with a line in `warnings`. The files go in as one set
  (`publishSet`): each new file is staged beside its place under a fresh
  name made exclusively, every older file of the set is set aside, and only
  then is each staged file renamed in; a failure at any step puts the older
  set back, so the folder never holds new figures beside an older export's
  workbook or summary, and nothing is ever written through a name that was
  already there. Every name is checked before anything moves: a folder of
  his at a name the export takes is neither set aside nor replaced, and
  the export stops and says so. An export takes its `generation` only once
  its files are in: one that failed takes none, so the last good export's
  printed summary still lands. Rows with money and no readable date are in no year: the
  export's `warnings` say so. The window waits two minutes for the export
  (the Excel file waits on the conversion runner), as for a printed page.
- `work.money.invoiceNext` and `work.money.invoice` number an invoice (from
  1001, one past the highest in the ledger or the books), keep his details
  and terms, and answer its page (`invoiceHtml`). A purchase request is the
  same page under its name; it counts by itself and keeps its own details
  and dates, so it never overwrites how he is paid or when an invoice is
  due. A page with no sender's name is refused. `work.money.invoice`
  takes the Create's `key` and holds the number for it (an hour, or until
  its row is filed): a number another Create holds, or a row carries, is
  refused with the next free one, so two forms opened together never print
  one number. The highest number used stands when a lower one is typed.
  Every number Money files is kept in the books (`used`, noted before the
  ledger is touched), so one whose row only waits as a suggestion, or whose
  filing stopped half way, is used all the same. A keep that stopped half
  way keeps its note through the cleanup of unfinished uploads, and its
  own Create settles it however long after, for that very number and kind
  alone: a Create under the same key that changed its number since is
  checked as any Create (`unsettled`, `sameNumber`), so it never takes a
  number another invoice used. `keep` files an invoice only for the key
  that holds its number.
- A page is printed by the formats pillar from the window
  (`work.formats.print`) and handed back in parts with `work.money.keep`: a
  summary goes to the year's folder; an invoice goes to `Money/Invoices/`
  and is filed as its row (money in, Unpaid; a request: money out,
  `Requested`). The window sends one key for the invoice dialog's life,
  however he changes the form between tries, and the host files a key
  once, for the job its first part named, and by a note of its own (as an
  accept's, with the invoice itself) through a stop in the middle. A key
  whose row is in the ledger answers only the same invoice again: one with
  other lines, rate or number is refused with what was created ("Invoice
  1042 was already created, for $320.00. It is in the ledger."), never
  filed as a second balance for the same work.
- Money declares no act kind. An invoice leaves from Mail's composer, by his
  own Send; an agent's draft is the held `mail.send`.

## The view (`src/renderer/src/work/money/`)

The row after People in a Work workspace's column (`view.ts`, order 2.75,
`readsLifeos: false`, its own lazy chunk; its look is docs/DESIGN.md "The
Money view"). One read paints it (`api.ts` `useMoney`), asked again when the
view shows, when the window comes forward, after each act of its own and on
the `work.money` push.

- `MoneyView.tsx`: the header's Month or Year, the stepper, Add (Receipt…,
  Entry…, Trip…, Invoice…, and Purchase request… in a Purdue job) and More
  (Open ledger, Open mileage log, Export…, Mileage rate…); then To confirm,
  the figures, the year's chart, By category, Owed, Entries and the mileage
  line. `model.ts` is its pure half.
- Open ledger and a row's paperclip open the file in a Files tab
  (`work.money.open` or `receiptSource`, then `work.files.open` and the
  Files view): no thread is made for a file.
- `EntryDialog.tsx` is one form for a new entry, a row and a receipt to
  confirm (the picture at its left). A write that answers `{changed: true}`
  toasts "The ledger changed. Showing it as it is now." and reads again.
- `receive.ts` sends a dropped, pasted or picked file in parts under one
  key, or by its path when the window is on the workspace's own host. The
  view takes the drop itself (`preventDefault`), so the frame's drop never
  starts a thread. `ToConfirm.tsx` and `ConfirmFlow.tsx` are the list and
  the dialog that goes on to the next waiting receipt on Save.
- `TripDialog.tsx`, `RateDialog.tsx`, `ExportDialog.tsx`,
  `InvoiceDialog.tsx`: the forms. `print.ts` prints a page the host
  answered (`work.formats.print`) and hands it back (`work.money.keep`).
- `send.ts`: Send… on an invoice or a request fills Mail's composer (no
  address, the subject, two plain lines) and opens the PDF in Files to
  attach. Mail's composer takes no file from outside (`writeMail` takes
  work-kit's `MailtoDraft`: to, cc, bcc, subject, body), so the PDF is not
  attached for him. Nothing leaves until his own Send.

### File as receipt on a canvas item

`src/renderer/src/work/canvas/itemVerbs.ts` is a seam in the canvas frame
that Money added (SEAMS.md says so): `registerItemVerb({id, label, icon,
when(item, kind), run(item, {environmentId})})`, read once by
`CanvasSeat`'s More after the pane's own rows and before Close. Money's
`itemVerb.ts` registers File as receipt for a PDF or a picture (never a
video), from `view.ts`, so it is in no first paint; the press loads
`fileItem.ts`. A file's item goes by its place (`receive {file}`); a mail's
attachment is fetched (`work.canvas.fetch`), read back by range
(`work.canvas.read`) and sent in parts with `source: 'mail'`.

## The phone (`ios/TempCodeClient/…/Work/Money/`, `ios/TempCode/Sources/Work/Money/`)

Home's toolbar has a second glyph beside the voice note's while any host
has Work on: Receipt (`doc.viewfinder`). It opens VisionKit's document
camera; the scan lands in `ReceiptSheet` (docs/IOS-DESIGN.md "The
receipt"). `OnDeviceText` reads the scan on the phone (Vision, accurate,
never a network recogniser); the phone asks a host's `work.money.parse` for
the fields (one parser, the host's, asked of the held job's own host with its `workspaceId`, so the category is that job's; asked again when he picks another job) and never parses itself. Save sends the
scan in parts with its lines and the fields as they stood at his press
(`work.money.receive`, `source: 'phone'`, the job he saw named by its
`workspaceId` on its own host with the sector beside it, `seen` when the
host's parse had answered): with an amount and a date it is filed at once
(the phone says "Suggested in …'s ledger" when the answer carries
`suggested`), else it waits in the desktop's To confirm; `dropped` keeps the
draft with its key spent until he discards it. `Receipt` (the client
package) keeps each draft on the phone under one key until a host answers:
nothing is lost on Cancel, a failed Save or a quit, and a scan the phone
cannot write is held in memory with Try Again, and no second scan is taken
while it is. A receipt goes only to the host of the job it shows: a retry
goes to that host alone, and waits on the phone while it does not answer,
since the key dedupes only per host; once a part has gone the job is fixed. The phone has no Money page.

## For others

- **Weekly review**: `work.money.sums {from, to, workspaceId?}` → `{rows:
  [{workspaceId, sector, in, out, owedToHim, heOwes, miles, currency,
  problem?}]}`. Only the caller's own jobs are opened. `problem`: that
  job's books could not be read whole, and its figures are not its money.
- **Today**: `work.money.owed {workspaceId?}` → unpaid rows, the oldest
  first, `toConfirm`, and `problems` (the jobs whose ledger cannot be
  read: Money's source says so, in place of showing nothing owed). Money's own source (`src/renderer/src/work/money/today.ts`,
  one line in `TODAY_SOURCES`) lists each open row of every job under
  "Owed", order 60, drawn only while something is owed (a job whose
  ledger cannot be read is a row "What is owed is not known", "The ledger
  could not be read"); a row opens its
  job's Money view. It shows rows, never the count that waits. A row owed
  both ways is two rows, keyed by the row and its way.
- **Work search**: a `SearchSource` on the module (`borders.ts`, kind
  `money`), over `searchMoney`; `work.money.search` is the same on the wire.
- **Digest**: a receipt the phone or a thread left waiting is
  `ctx.tell({kind: 'money.confirm', …})` with no `by`, done when it is filed
  or dropped. `tells` rides beside the module until the digest declares it.

## Who may ask (`index.ts` `admit`)

A thread's own call reaches its own job's reads and no write. A remote key
reaches a job only when it could have named its Money folder itself
(`ctx.reaches`), and a call that names no job answers for the jobs it
reaches. A code workspace has no money.

## What is proven

- Unit tests beside each file on a stand-in Work service (`testing.ts`),
  and `real.test.ts` on the service's own sheet host.
- `bun run script:e2e-money` (`scripts/e2e-money.ts`): a real host and
  Work service in one process with no window, the host's own tools, every
  call over the host's socket.

## Known limits

- A write of more than one step is made safe against a stop in the middle
  by a note and a Ref (above). Two windows stay: a file copied and the
  host stopped before the note names it (one stray file, linked by no
  row), and a ledger with no Ref column and a row with no file (nothing to
  find it by). A plain entry from the form carries no key.
- A book renamed in Files while rows wait in it as suggestions opens with
  none under its new name, and a receipt renamed while its row still waits
  keeps its old name in that waiting cell: the sheet service keeps a file's
  suggestions by its path, and a waiting suggestion cannot be amended from
  outside (asked of sheets in SEAMS.md).
- The weekly review's own line for Money prints only a side above zero and
  drops `problem` (the review pillar's `words.ts`; asked in SEAMS.md).
- Books written by builds of 2026-11-23 before the mileage formula was
  rounded keep `=miles*rate` in their Value cells; nothing rewrites them.
- An append reads the first empty row and writes it with nothing between,
  under Money's own lock; the sheet's editor does not take that lock, so a
  row he begins in the same instant could be written over. The service
  offers no append and no base revision for cells.
- A receipt in a form the reader cannot open (WebP, GIF, BMP) is filed by
  hand: the fields open empty beside its picture.
- A cell cannot open a file: the receipt opens from the Money view.
- Send… cannot attach the PDF to the mail (above).
- The view's row says no fact: the count that waits is not drawn in the
  column.
