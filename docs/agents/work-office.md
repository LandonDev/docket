# Work: the Office tools

Milestones 28 and 29 of the Work plan (architecture §9.2, §10; the sheet research
`reports/nJLC5WoplSWf.md` §4 and its `excel-as-the-truth-paths` file). One
tool set lets agents use the Office files and the Outlook the owner has open,
carried out on the host that has the apps. A workbook that lives in Excel
opens in the sheet canvas with Excel as its truth. [work.md](work.md) says
how the `office` pillar is mounted; [work-sheets.md](work-sheets.md) covers
the sheet canvas.

## Files

| File | What |
|---|---|
| `src/shared/contract-work-office.ts` | the wire: `work.office.status` (read), `read` (read), `write` (operate), `switch` (operate); the add-in's `addin.pair` (operate), `addin.list` (read), `addin.remove` (operate) |
| `office/carrier.ts` | `OfficeCarrier`, the one interface every carrier fills: workbooks and ranges, documents, decks, Outlook mail and calendar, `open` |
| `office/osa.ts` | one osascript run (`runOsa`), and osascript's errors in words (`osaError`: -1743 refused, -1744 needs his click, -600 not open, -1728 no such item) |
| `office/mac.ts` | the Mac carrier: one JXA script per verb (`SCRIPTS`), arguments as one JSON string, the answer JSON |
| `office/com/carrier.ts` | the Windows carrier: one request per verb to `tc-office.exe` over stdio, its refusals as `OfficeError`s, Excel's change events (`changes`) |
| `office/com/helper.ts` | the helper compiled on the host by Windows' own `csc.exe` into the temp dir, and started in a Job Object |
| `office/com/source.ts` | the helper's C# as a string, generated from `native/tc-office-win/TcOffice.cs` by `scripts/gen-tc-office-source.ts` |
| `native/tc-office-win/` | `TcOffice.cs` (the helper), `RecordedCom.cs` (the recorded COM surface, tests only), `build-in-rig.sh` |
| `office/fake.ts` | `FakeOffice`, an Office in memory that logs every call: the recorded carrier for the box's tests |
| `office/excel.ts` | `ExcelHelper`: Excel as the truth behind a grid |
| `office/grid.ts` | what the sheets pillar asks for an item whose source is `{at: 'microsoft', app: 'excel'}` |
| `office/tools.ts` | the tool set, and how a call reaches the host that has Office |
| `office/held.ts` | the held acts `office.mail.send` and `office.calendar.op`, and `cleanMailHtml` |
| `office/route.ts` | `OutlookRoute`: LifeOS's Outlook-account mail and calendar acts, carried by this host's Outlook |
| `office/index.ts` | the module: tables, wire, tools, acts, the Excel trigger source, the route's start |
| `addins/office/` | the add-in itself: `manifest.xml`, `taskpane.html`, `taskpane.js` (its screen), `core.js` (what it does), the icons as base64 |
| `office/addin/keys.ts` | `AddinKeys`: the pairing code and each add-in's key (only its hash is kept) |
| `office/addin/hub.ts` | `AddinHub`: main's end of the relay, the add-ins on it and the calls made to them |
| `office/addin/carrier.ts` | `withAddin(desktop, hub)`: the add-in as a carrier ahead of the desktop one |
| `office/addin/web.ts` | Office on the web in a window of our own, for the switch |
| `office/addin/index.ts` | the link's start, `work.office.addin.*`, and which tool calls run here |
| `office/addin/fakeOfficeJs.ts` | `FakeExcelHost`: a stub Office.js for the proofs |
| `service/routes/office.ts` | the relay, `wss …/w/office`, and the add-in's files at `GET …/w/addin/*` |

Tables: `work_office_undo` (the helper's undo log), `work_office_addin_keys`
(paired add-ins: name, app, the key's sha256, when made and last seen), `work_office_journal`
(the route's sends not yet acked), `work_office_sources` (the LifeOS source
id per Outlook address). Suggestions over a workbook use the sheets pillar's
`work_sheets_suggestions` under `excel:<key>`.

## Carriers

A carrier is what drives the apps: the Mac's osascript, COM on Windows
(M44), our Office add-in, and Outlook on the web on the box (M38).
`index.ts` picks `withAddin(macCarrier())` on darwin, `withAddin(comCarrier())`
on win32, `withAddin(owaCarrier())` on Linux where a Chromium is, and
`withAddin(null)` elsewhere (`setCarrier` in tests): a file open with our
add-in goes through the add-in, anything else to the desktop carrier. A host
with only the add-in reports `carrier: 'addin'`; Windows reports `com`, the
box `owa`.

A carrier may also offer `changes(fn)`: the app itself tells of a change to
a sheet (Windows' Excel does). The module hands those to
`ExcelHelper.heard`, as it does the add-in's, and `stop()`, called when the
module stops. Two `OfficeError` codes came with Windows: `busy` (the app
turned a step away for now, a dialog open or a cell in edit: that step was
not done, and the agent may try again) and `refused` (the app would not make
what was asked, a mail or an invitation, before anything was sent). The
route takes both as plain refusals, so a LifeOS row fails in words. A
calendar op that ends unclear once Outlook was asked to send stays
journaled and is acked as done, as a mail is.

**The Mac.** Each verb is one JXA script run by `/usr/bin/osascript -l
JavaScript -`. A range is one Apple Event each way, never one per cell. The
names come from the apps' own dictionaries (`sdef`), checked against Excel
16.102 and Outlook 16.115 on the owner's Mac. Word and PowerPoint were not
installed there; their scripts follow the published dictionaries and are
unproven. A verb on an app that is not running answers "not open". It never
starts the app unseen. The one exception is `open`, the switch (`open -a
"Microsoft Excel" <path>`, or `ms-excel:ofe|u|<url>`).

macOS charges osascript's Apple Events to TempCode, so the Automation prompt
reads "TempCode wants to control Microsoft Excel", once per app. The
packaged app carries `NSAppleEventsUsageDescription` (electron-builder.yml)
and the `com.apple.security.automation.apple-events` entitlement
(build/entitlements.mac.plist): without them, under the hardened runtime,
macOS refuses its Apple Events (-1743) without asking, and every Office call
answers "TempCode may not control …".

`apps()` reports each app as installed, running and allowed. macOS will not
say whether an app is allowed without asking, so `allowed` is what the last
call found, and `unknown` before any call.

**Windows** (`com/`, milestone 44). Every verb is one request to
`tc-office.exe`, a small helper that drives Excel, Word, PowerPoint and
classic Outlook by COM in his own session: one JSON object per line each
way (`{id, verb, args}` in; `{id, ok, value}` or `{id, ok: false, error:
{code, message, hresult}}` out; `{event: 'ready'}` once, and from Excel
`{event: 'changed', book, sheet, address}` and `{event: 'remote', book}`). No PowerShell runs. The
helper is C# 5 (`native/tc-office-win/TcOffice.cs`), carried in the server as
a string and compiled on first use by the `csc.exe` every Windows has (.NET
Framework 4), into `%TEMP%\tempcode-office-<hash>.exe`, as the job helper is
(procTree.ts). It is spawned hidden with `adoptTree`, so it ends with the
app; it also exits when its stdin closes. One helper serves the app's life;
one that stops is started again on the next call, and one that does not
answer within two minutes (Office on a modal dialog) is stopped and
replaced. A send waits up to thirty minutes, since Outlook may be showing
him a prompt; past that it says to look in Sent before sending again (the
Outbox lets him press a failed act again). The carrier sends one request at
a time, as the helper runs them, so a call's time starts when it is taken
up. Its calls and Excel's events run on one STA thread with a message loop;
stdin is read beside it. After each request it lets go of every app but an
Excel whose events are wanted, so an app he closes ends; an app kept alive
hidden by something else (`Visible` false, or Outlook with no window) is
not his, and answers "not open".

- **It drives only what he started.** It attaches with `GetActiveObject` and
  checks the process first, as LifeOS's `outlook.ps1` does, so a verb on an
  app that is not open answers "not open" (an app run as administrator while
  TempCode is not answers the same, in other words). A proxy left by an app
  that quit is dropped and the next call attaches afresh. The one exception
  is `open`, the switch: an open file's window is activated and brought
  forward (Windows may refuse a background process the foreground: the
  window is then active in its app, not in front); a file not open starts
  the app from App Paths with it, and a URL goes to `ms-<app>:ofe|u|<url>`.
- **Busy.** An OLE message filter retries an app's "retry later" for ten
  seconds; past that COM's RPC_E_CALL_REJECTED (0x80010001) or
  RPC_E_SERVERCALL_RETRYLATER (0x8001010A) answers `busy`. Outlook's object
  model guard (E_ABORT, 0x80004004) answers `not-allowed`.
- **Excel.** A range is one call each way: `Value` (a date comes as ISO
  text in UTC, as the Mac gives it, and goes back as a date; an error cell as
  its text, `#DIV/0!`), `Formula2` (or `Formula` on an Excel without it), and
  `NumberFormat`, read by row and then by cell where the cells differ (COM
  answers null for those). A date in a block with formulas goes in as its
  serial, so a date-formatted cell stays a date. Excel's `SheetChange` reaches `changes` with its
  range for his own typing; the helper drops the events its own writes
  raise. A co-author's edits raise no `SheetChange` (Microsoft: "the default
  behavior of not firing change events"); Excel says it merged them by the
  workbook's `AfterRemoteChange`, which names no range, so it reaches
  `changes` with sheet '' and the module reads every watched block again
  (`ExcelHelper.pass`). The helper hooks it on each workbook it reaches
  while listening. It reads each event's interface and dispid from the
  object's own class info (`IProvideClassInfo`), with `SheetChange`'s from
  Excel's type library (AppEvents, 0x61c) should that fail. The safety pass
  still runs for formatting.
- **Word and PowerPoint.** Word's text is `Content.Text`; a find and replace
  walks `Find.Execute` and sets each hit's text (Word's own replace takes at
  most 255 characters), with Track Changes as the tool asks and put back
  after. PowerPoint replaces with `TextRange.Replace`, which keeps each run's
  formatting. His last Find dialog's settings are cleared first, a `^` is
  found as itself, and the window shows the final text with no markup while
  it runs, so no tracked deletion is found again.
- **Outlook**, as `outlook.ps1` does it: addresses by `PR_SMTP_ADDRESS` and
  `PR_SENDER_SMTP_ADDRESS`, then the Exchange user, then the address itself;
  lists sorted and stopped (no date filter for mail); a reply or forward
  puts our HTML just inside the body, above Outlook's quoted original; the
  account by `SendUsingAccount`. Every recipient must resolve before a send,
  or it is refused with their names. Whatever fails before `Send` answers
  `refused` (nothing went); `Send` itself turned away answers `busy` or
  `not-allowed`, and anything else from it is `failed` with "it may have
  gone". An invitation is sent before it is saved (Send saves it), so one
  Outlook turns away leaves no meeting behind. Events are sorted,
  recurrences expanded, then restricted to the window. `eventByUid` matches
  `GlobalAppointmentID` in hex with the occurrence date taken out, or the
  `vCal-Uid` an invitation made elsewhere carries in it. An occurrence of a
  series is answered as the series (its EntryID is the master's). A send
  answers no id.
- New Outlook (`olk.exe`) has no COM: only classic Outlook is reached.

**Outlook on the web** (`owa/`, milestone 38). Mail and calendar only:
Excel, Word and PowerPoint answer "not on the box". The carrier keeps its
own tab of Outlook on the web in the box's browser
([work-browser.md](work-browser.md) "The box's browser"), hidden from the
agents' browser tools (`RESERVED_TARGETS`). It calls the page's own
`/owa/service.svc?action=<Action>` from inside the page (`page.ts`), signed
with the headers the page itself last sent there (its bearer token and
canary, read off its own requests), so his session never leaves the
browser; a 401 or 440 reopens the page once, then asks for a sign-in. The
bodies are Exchange's operations as JSON (`ews.ts`): `CreateItem` with a
`Message` (HTML body, `SendAndSaveCopy` to Sent, `SaveOnly` for a draft),
`ReplyToItem` and `ForwardItem`, a `CalendarItem` with
`SendMeetingInvitations`, `AcceptItem`, `DeclineItem` and
`TentativelyAcceptItem`; `FindItem` over a folder or a `CalendarPageView`
(with `calendar:UID`, so `eventByUid` matches exactly); `GetItem` for a
mail's text or HTML; `GetOwaUserConfiguration` for who is signed in. A
refusal Exchange answers is a plain refusal (`not-allowed`, or `not-found`),
so the route fails its row; anything unclear stays journaled. Who is signed
in is kept in `<userData>/work-browser/box/owa.json`, so the route's minute
beat never starts the browser; while none is known and the profile's
cookies hold a Microsoft sign-in, `apps()` asks the page at most once an
hour. Logins come as the browser's do ([work-browser.md](work-browser.md)
"Logins"). `TEMP_CODE_OWA_URL` points the page at a stand-in.

## The add-in

Our own Office.js task pane add-in for Excel, Word and PowerPoint, on the
Mac, on Windows and on the web (the research's Part B, path B). It is plain
script with no build: the Work service serves `addins/office/` at
`/w/addin/<file>` (`office/addin/assets.ts` builds the files in), and the
manifest names `https://tempcode.landonhale.com/w/addin/taskpane.html`.
Office's web views may not reach this machine's loopback (Chromium's Local
Network Access), so the add-in connects out to the public address, through
the tunnel, to `wss://tempcode.landonhale.com/w/office`. **Whichever host the
tunnel points at holds the add-ins**, which is the box today: the Mac's own
Excel with the add-in is reached through the box.

**The relay** (`service/routes/office.ts`) judges nothing. Main connects to
`/w/office/host` with the service's secret, from this machine only (a
request carrying `CF-Connecting-IP` came through the tunnel and is refused).
An add-in's first message, within 5 s and under 4 KiB, is `hello` with its
key or `pair` with a code; the relay hands it to main (`open`), and passes
nothing more until main answers `admit` or `refuse`. A caller holds four
sockets that have not been let in, 32 in all, and 64 add-ins may be in. The
relay's own sockets take 8 MiB from an add-in and 64 MiB from main; a call
whose arguments pass 4 MiB is refused with "write it in parts". When a new
link from main replaces the old one, the old one's add-ins are closed and
say hello again. With main away it
answers 503 at the upgrade; when main's link goes, every add-in closes 4503.
The add-in's files are served without `X-Frame-Options` and with a
`frame-ancestors` list of Office on the web's hosts, so Office can frame the
pane.

**Pairing** (`addin/keys.ts`). Settings → Work, Where it runs, has an Office
add-in row per host. Pair… shows an 8-letter code (no 0, O, 1, I or L) for
five minutes; one code at a time and one pairing per code. A caller (by its
address, the tunnel's `CF-Connecting-IP`) gets five wrong tries a code, so a
stranger cannot spend his; after a thousand wrong tries in all the code
dies. The pane takes the code once and gets a key of its own (`tca_` and 32
random bytes), which it keeps in the pane's `localStorage`, never in the
workbook. The host keeps only the key's sha256. Each paired add-in is a row
under it ("Excel on the web", connected or when it last was) with Remove,
which closes it at once (4403) and puts its pane back to asking for a code.
Only the owner pairs: an agent's call is refused.

**What it carries** (`addin/core.js`, `addin/carrier.ts`). On the open file:
`excel.workbook` (its sheets and used ranges), `excel.read` (values,
formulas and number formats of a range), `excel.write` (a grid: a string
starting `=` is a formula, null empties the cell), `word.read` and
`word.edit` (with Track Changes on when the tool asks), `slides.read` and
`slides.replace`. Mail and calendar are never the add-in's. The file's key
is `Office.context.document.url`, which is a path or a URL as the Mac's
scripts name it. A call goes to the newest add-in with that file open; with
none, to the desktop carrier; with neither, it says to open the file with
the add-in.

**Changes by range.** The add-in listens to `worksheets.onChanged` and sends
each change's sheet and address, dropping its own writes (`triggerSource:
'ThisLocalAddin'`). The hub hands it to `ExcelHelper.heard(book, sheet,
range)`, which reads again at once the watched blocks the range touches; the
15 s safety pass still runs for formatting and row moves. Suggestions stay
under `excelStore(book)`, one set whichever carrier wrote.

**Where a tool runs** (`addinTools`, `carriedHere`). On a host with a
desktop carrier every call runs here, as before. On a host with only the
add-in, a call runs here when it names a file an add-in has open, and
`office_files` while any add-in is connected (it then lists only those
files); every other call goes to the workspace's desktop host as if this
host had no Office. So with the add-in closed, the tools fall back to the
Mac's scripts.

**Office on the web for the switch** (`addin/web.ts`). Where no desktop app
is installed, the switch opens a file by URL (OneDrive, SharePoint, Teams)
in a window of our own: one `WebContentsView` filling a `BrowserWindow`, a
session apart (`persist:microsoft`), sandboxed with no Node, permissions
refused but clipboard writes, and `Electron/` dropped from the user agent so
Microsoft's sign-in offers passkeys. It opens only a file on Microsoft's own
https sites. Once open the page may go anywhere over https, since a school's
or company's sign-in passes through its own site, and with no address bar
the window's title always ends with the site it is on. A new window that is
not Microsoft's opens in his browser. A headless host says it has no
screen.

**Sideloading.** Excel for the web (personal account): office.com → Excel →
open a workbook → Home → Add-ins → More Settings → Upload My Add-in → the
manifest (`addins/office/manifest.xml`, or download it from
`https://tempcode.landonhale.com/w/addin/manifest.xml`). The browser keeps
it in local storage: clearing the cache or changing browser means uploading
again. Excel on the Mac: copy the manifest to
`~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/` (make `wef`
if it is missing), restart Excel, then Home → Add-ins → TempCode. A tenant
that hides Upload My Add-in, or a Mac with `OfficeWebAddinDisableAllCatalogs`
set, simply does not get this carrier. The pane opens per workbook; it is
not loaded on open.

## The tools

One set for Claude, Codex and Muse (architecture §10):

| Tool | Does | Held |
|---|---|---|
| `office_files` | apps, open workbooks (sheets, used sizes), documents, decks, each with its `key` (a path, or a URL for a file in OneDrive, SharePoint or Teams) | no |
| `office_range_read` | values, formulas and the block's `hash` | no |
| `office_range_write` | a block, with `base` the hash read; stale answers `conflict` and writes nothing; answers a `writeId` | no; the rule below |
| `office_range_undo` | puts back one of its writes, only while the cells hold what it wrote | no |
| `office_doc_read`, `office_doc_edit` | paragraphs; insert at start or end, or find and replace | no; the rule below |
| `office_slides_read`, `office_slides_replace` | each slide's text; replace text | no; the rule below |
| `office_mail_list`, `office_mail_read` | Outlook's inbox, sent or drafts | no |
| `office_mail_draft` | a draft left in Outlook's Drafts; nothing is sent | no |
| `office_mail_send` | send, reply (`replyTo`: to that mail's sender, read when the act is made, so the card and a grant judge the address Outlook uses), forward (`forward`), HTML body, cleaned when held; `outlookAdds` names the mail Outlook puts under a reply or forward, and an edit keeps the account, the mail answered, a reply's recipients and the subject (`keepOfficeMail`) | **yes**: `office.mail.send` |
| `office_calendar_list` | events by start | no |
| `office_calendar_create` | with nobody invited, a hold on his own calendar, made at once | with `attendees`, **yes**: `office.calendar.op` |
| `office_calendar_answer` | accept, decline, tentative | **yes**: `office.calendar.op` |

**The rule for a file others can open.** A file named by a URL, or one in a
folder synced from OneDrive or SharePoint (`~/Library/CloudStorage/`, a
`OneDrive` folder), is shared.
On a shared file, a change he asked for in so many words is written: the
tool carries `because: "asked"` and a `quote`, and the host finds the quote
in his own messages (`ctx.threads.ownerSaid`). Otherwise the change waits
for him (`judgeWrite`, `shared/work/because.ts`). On a workbook it waits as
suggestions; in Word, as a tracked change. PowerPoint keeps no suggestions,
so the tool refuses and says so. On his own files every write is direct.

**Where a tool runs.** On the host that has a carrier, the tool runs there.
Elsewhere (the box), it goes to the first host in the workspace's
`mayUseDesktop` ("May use this Mac") through
`ctx.peer(host).call('office', 'read' | 'write', {tool, args, asked?, by?})`.
That host runs the same tool through `work.office.read` (only a tool that
changes nothing) or `work.office.write`, under its bridge policy for the
caller (peer.ts: `read` lets only reads through). The calling host checks
the owner's words and sends the result as `asked`; the far host takes it
from there. A remote caller reaches a file by path only where
`ctx.reaches` lets it (the listener's fence). A file named by a URL always
passes.

## What is held

`office.mail.send` and `office.calendar.op` are host-store act kinds
(`held.ts`, registered through `WorkModule.acts`). A tool only ever calls
`ctx.held.create`; Outlook is called in the kind's `execute`, which the
Outbox runs once, after his press or a grant he made from one of these. A
send that comes over the peer link is held on the host that has Outlook,
with no thread (`sessionId: null`), and is pressed there. Each act carries
its `host` and refuses to run anywhere else. A mail grant fits when the
account matches and every recipient is named, or sits in a named domain. It
never fits a mail with no recipients.
Calendar acts take no grant. The payload's HTML goes through
`cleanMailHtml` (no script, style, frame, object, form, base, meta or link
element, no `on…` handler, no `javascript:` link) before it reaches Outlook.

## LifeOS mail through Outlook

`route.ts` makes this host one of the machines LifeOS's local route sends
through (M22 section 4, M24 section 8). It starts only while LifeOS is
connected and Outlook is installed (checked every 5 minutes):

- **beat**, every minute: each Outlook address once through
  `sources:register` (channel `outlook-local:<host id>`), then
  `sources:heartbeat`.
- **pump**, every 20 seconds: `outbox:localDue {host}`, then for each row
  `localClaim`, a journal row, `sendMail` from the row's account (HTML
  through `cleanMailHtml`; plain text as HTML when there is none), then
  `localSent` with Outlook's id, or `localFailed` with the reason. Then
  `calendarOps:localDue {accounts}`: `create` makes the event and sends the
  invitation; `accept`, `decline` and `tentative` find the event by its
  calendar UID (`eventByUid`) and answer it; `update`, `propose` and
  `cancel` fail with "do it in Outlook".
- **the journal.** A row is journaled before Outlook is called and cleared
  after LifeOS's ack. Each pass first acks what is still in it: a lost ack
  becomes a late ack, never a second send. A row still journaled is never
  handed to Outlook again, even if LifeOS offers it. Only a plain refusal
  (not installed, not allowed, not open, no such account) fails a row; a
  timeout or an unclear end stays journaled and is acked as sent. The Purdue
  PC's sender works the same way.
- **two machines on one account.** The box (Outlook on the web) and the Mac
  may both report one address. `localClaim` is atomic, and since milestone
  38 LifeOS records the claimer (`outbox.claimedBy`): a row a named host
  claimed is settled, and seen in flight, by that host alone.

## Excel behind the grid

`ExcelHelper` (excel.ts) holds each watched block's cells and hash
(work-kit's `hashCells`: formula, else value):

- **A write** reads the cells again first (the safety re-read). With a
  `base` that no longer matches, it answers `conflict` and writes nothing.
  Otherwise it logs what the cells held to `work_office_undo` (the newest
  100 per workbook), writes the block in one call, and reads it back: Excel
  types what it is given, so its copy is the truth. Writes, undos and the
  safety pass's re-reads run one at a time per workbook, so the pass never
  takes the helper's own write for someone else's.
- **Single cells** (`writeCells`, used by the grid, accepted suggestions and
  `SheetSource.write`) are written alone, or as one block only when they
  fill it, so the cells between are never written back as a read gave them.
  A date read from Excel comes back as ISO text and is written back as a
  date. Across sheets or cells it is not all-or-nothing: a cell that
  changed between the check and its own write stops there with
  `conflict`.
- **Undo** puts the old contents back only while the cells still hash to
  what the write left. Excel's own undo does not cover scripted writes.
- **The safety pass** (every 15 s while anything is watched) reads each
  watched block again. AppleScript reports no changes, so on the Mac this
  pass is the main loop. Someone else's change arrives as a re-read block
  (`by: 'excel'`). A changed cell turns its pending suggestion `conflict`.
  A block whose rows moved by one to ten (a row inserted in Teams;
  `shiftOf`) orphans every suggestion on the workbook. The helper's own
  writes reach watchers as `by: 'tempcode'`.
- `source(book)` is the workbook as work-kit's `SheetSource`, with
  `formulas: 'store'`. Sheets are named by their tab names.

**In the sheet canvas.** `heldOf` (sheets/held.ts) maps a source `{at:
'microsoft', app: 'excel'}` to `{at: 'excel'}`, and the sheets pillar asks
`grid.ts`:

- `load` gets a Univer snapshot read from Excel. Each sheet's id is its tab
  name, and a big sheet loads only as far as one read reaches (50,000
  cells).
- Someone else's change heard on the safety pass, and every write this host
  makes to the workbook wherever it lands, moves the workbook's `rev`. Each
  canvas item is told once (one listener per item) through `announce`, and
  `since` answers `reload`: Excel gives cells, not mutations. An edit that
  meets a change the pass has not seen yet moves the rev too, so the grid
  reloads rather than retrying.
- `edit` writes the grid's cell contents through the helper and refuses
  formatting and rows or columns, as for an opened package. The view says
  `store: 'package'`, so the canvas treats it the same way, with `reach`
  offering the switch to Excel.
- Accepting a suggestion writes it only while its cell holds what the agent
  saw.
- History, compare and restore say Excel keeps them.
- The switch brings Excel forward (`work.sheets.switch`).
- Only the host that has Excel serves the item.

**The trigger source.** For a routine's `file` trigger on an Excel source,
the pillar fires when the safety pass hears someone else's change.

## Testing

On the box, everything runs against `FakeOffice`. The add-in's proof
(`addin/addin.test.ts`) runs the relay route on a real listener, main's link
to it, and `addins/office/core.js` itself in a node sandbox against
`FakeExcelHost`, a stub Office.js in the shapes Microsoft documents, over
real sockets: pairing, every refusal, a range read and write, a stale
write's conflict, a change heard within a second, the fall back to the
desktop carrier, and a removed key. `AddinRow.dom.test.tsx` covers the
Settings row. That covers the tools,
the held acts (`tools.test.ts`: every verb that sends answers a held act,
and Outlook sends nothing), the helper (`excel.test.ts`), the canvas path
(`grid.test.ts`), the route with a LifeOS in memory (`route.test.ts`) and
the wire (`index.test.ts`). `mac.test.ts` runs each JXA script in a node
sandbox against stand-ins for Excel's and Outlook's objects, and the carrier
against a recorded osascript. `owa/owa.test.ts` runs the Outlook on the web carrier
through the box's real Chromium against a stand-in in Outlook's shapes
(`owa/fixture.ts`: its page signs its first call with a bearer token and the
canary, its `service.svc` checks every `__type` and answers as Exchange
does): who is signed in, a formatted send read back from Sent, the route end
to end, booking, an invitation by UID and its answer, a session that ends.

Windows: `com/carrier.test.ts` runs the carrier's wire against a stand-in
helper (each verb's request, refusals and busy codes, the allowed state, a
helper that cannot start, stops, hangs or never says ready, Excel's events
area by area and the watch after a restart); `com/helper.test.ts` holds the
string to the C# file and the compile to Windows' csc. `com/rig.test.ts` is
the tool set's contract on Windows, opt in: the real `tc-office.exe` built
in the rig with the recorded COM surface (`RecordedCom.cs`: Excel, Word,
PowerPoint and Outlook in Microsoft's documented shapes, with their quirks:
1-based blocks, a single cell as a scalar, null formats over mixed cells,
error cells as Int32, an unknown member, a closed app, a busy app, the
guard, SheetChange, AfterRemoteChange), driven over the rig's SSH by the real carrier, tools,
held acts and Excel helper: reads and writes, a stale write's conflict,
suggestions on a shared workbook, an older Excel, a typed change heard at
once and never our own, a co-author's merge heard by its workbook, busy, not open and not installed, the switch,
tracked changes in Word, slide text, mail listed and read, every send verb
held with nothing sent, a formatted send and a reply through execute, a
draft, an invitation, an answer by UID with a comment, the guard; and the
shipped `tc-office.exe` on a Windows with no Office. Run it with
`native/tc-office-win/build-in-rig.sh m44`, then `TC_OFFICE_RIG=m44
NODE_ENV=test bunx vitest run src/main/server/work/office/com/rig.test.ts`.
Through sshd it needs Git Bash's pipes between (`cat | helper | cat`): sshd
hands a program one synchronous handle for stdin and stdout, and a read
waiting on it holds every write back. Node gives the helper two pipes.

## Not proven

**Windows**: nothing has run against real Office on Windows (the rig has
none, by the owner's choice). The recorded surface follows Microsoft's
documentation, not a recording of real Office. Unproven: the COM member
names and argument shapes against real Excel, Word, PowerPoint and Outlook
(the checklist in landed/M44.md runs them); `ComEventsHelper` sinking
Excel's events late-bound, the event ids read from class info, and
`AfterRemoteChange` firing for a co-author's merge; `Respond` with no dialog returning a reply to send; the guard's
answer on a PC with no antivirus (it may prompt, and the call then waits
out its two minutes); bringing a window forward from a background process;
a locked-down PC that refuses an unsigned exe in %TEMP% (AppLocker), where
the helper would have to ship signed beside the app; the helper compiled
by TempCode itself on Windows (the rig compiled it with the same command
over SSH).

**Outlook on the web**: nothing has run against his real Outlook on the web
(no agent may sign in to it). The live test is in landed/M38.md. Unproven
there: that the real page's `service.svc` takes these bodies as the stand-in
does, which headers sign a call (the carrier keeps `authorization`,
`x-owa-canary`, `x-anchormailbox` and the like off the page's own requests),
and that `FindItem` returns `calendar:UID`.

None of this has run against real Excel or Outlook. The add-in has not run
in any real Office host: its live test, with the sideload steps, is in the
plan's landed/M29.md. Also unproven for the add-in: Office.js's real
answers (the stub follows the docs), the pane's CSP and framing on Office on
the web, the public address (the tunnel's rule is the owner's step), Word
and PowerPoint, and Office on the web inside our window. The test is written out
in M28.md, "The live test". It needs his one click per app. Also unproven:

- new Outlook's answer to the legacy dictionary;
- Word and PowerPoint, which were not installed;
- a reply through the route, which does not thread under the original: the
  route sends it as a new mail with its subject;
- someone else's change outside the block watched when the workbook was
  first followed (rows added below it by a co-author): the watch is not
  widened until Work is turned off and on. The host's own writes move the
  rev wherever they land.
