# Work: mail

Milestone 23 of the Work plan. A linked Work workspace's Mail view is
LifeOS's own mail client (work-kit/mail, milestone 22) filtered to the
workspace's sector; a draft an agent makes opens beside its thread as a
mail item, in the same composer; its rewrites wait in the draft to take or
leave; and Send is the host's, never the window's. [work.md](work.md) says
how a pillar is mounted, [work-canvas.md](work-canvas.md) how a kind sits
in the pane, [work-outbox.md](work-outbox.md) how the hold sends, and
[work-lifeos.md](work-lifeos.md) how the host and the screens reach LifeOS.
The look is the round-two prototype `mail.html` ("The thread drafts").

## Files

| Part | Where |
|---|---|
| The wire (`work.mail.send`) | `src/shared/contract-work-mail.ts` |
| The press, a draft opened beside its thread, the preamble line | `src/main/server/work/mail/index.ts` |
| The outgoing HTML rules | `src/shared/work/mailOutgoing.ts` (the host sends through them; the Outbox draws through them) |
| The mark of a press that already waited | `src/main/server/work/mail/waited.ts` |
| The live proof (not shipped) | `src/main/server/work/mail/proof/live.ts` |
| The client with Send through the host | `src/renderer/src/work/mail/client.ts` |
| TempCode's `MailKit` (toast with its countdown, faces, Save to Downloads, Print, who drafted a mail) | `src/renderer/src/work/mail/kit.tsx` |
| Settings, Work, Mail | `MailSettingsSection.tsx` (work-kit's `MailSettings` on the host's whole session) |
| The page policy and LifeOS's address | `src/shared/pagePolicy.ts` |
| Save to Downloads (main) | `src/main/downloads.ts` |
| The preview page, its scenes and the reader's proof (not shipped) | `src/renderer/src/work/mail/preview/`, `scripts/mail-preview.ts` |
| The Mail view: the list beside the reader, the edge between them, where it stood | `MailView.tsx`, `view.ts` |
| The mail kind: a draft beside its thread, a waiting rewrite | `MailCanvas.tsx`, `canvas.ts`, `proposal.ts` |
| A held mail in the Outbox | `MailAct.tsx`, `act.ts`, `model.ts` |
| Type steps and the menu wash | `mail.css` |
| Waiting on: the nudge press, the workspace's days and routine, dropped nudges, `mail_waiting` | `src/main/server/work/mail/waiting.ts` |
| Waiting on in the workspace's settings | `WaitingSection.tsx` (and `WaitingSection.preview.tsx`) |

## Send

The composer is LifeOS's, unchanged. Its Send (`useOutboxActions().send`)
is wrapped by `sendThroughHost`: the draft is saved as he sees it
(`compose.save` on the window's session), then the window asks the host
`work.mail.send {id, seen, sendAt?}` (approve; a model caller is refused).
The host reads the row as LifeOS holds it now (`compose:get`, as the owner)
and refuses it when it no longer says what the composer saved (`seen`: who
it goes to, the subject, the words, the HTML and the files, each attachment
by storage id and name and a forward's parts as `part:<id>`; "The draft
changed after you pressed Send…"). A `seen` with no HTML or no files (an
older client) is refused for a row that has either, so nothing goes unseen:

- **A draft one of this host's threads made** (`origin.app` tempcode,
  `origin.host` this host) goes through the hold: the mail module calls the
  Outbox's own `work.outbox.send {ref, rev}` with the row's edit time as
  `rev`, so the run-once claim, the Sent record and the linked task
  (`ctx.links.completeFor`, with the thread link) are the hold's. Such a
  draft goes now or not at all: a `sendAt` is refused.
- **A draft another host's thread made** is refused: send it from that host.
- **Anything else is his own mail** and goes as his `compose:send` with
  `cause: 'press'`, at `sendAt` when he chose a time.

**Undo for a held draft is a wait in the window.** The hold has no queue to
pull a mail back from, so for a draft that goes through it the composer
(work-kit, `kit.holdsSend`) saves the draft as he sees it, shows "Sending
to …" with a bar and Undo for the undo time from Mail's settings, and only
when that time runs out calls `work.mail.send {…, waited: true}`, with
`seen` as he pressed on it. Nothing has gone while it waits: Undo cancels
the timer, and a window that closes takes the timer with it, so the draft
stays held. That second call saves nothing (`client.ts`): what he pressed
on is only compared, so an edit made while it waited is never written
over, and the host refuses the send because the row no longer says what he
saw. `waited` marks the draft inside that one call into the hold
(`waited.ts`: an `AsyncLocalStorage` scope round the call, so only the act
that runs in this call's own claim can take the mark, once), and the
hold's `mail.send` passes `immediate: true` to `compose:send` only for an
owner's press that carries it, so LifeOS does not queue the mail a second
time. A press from the Outbox page, a grant's send and the phone's run in
calls of their own, find no mark whoever wins the claim, and keep LifeOS's
queue and its Undo; LifeOS takes `immediate` only with `cause: 'press'`
named, and makes a grant's send wait the undo time whatever time it names.
A held draft has no Send later.

**One wait a draft.** A second Send on the same draft, or the draft opened
again in the composer, ends the wait it had (work-kit `held-send.ts`), so
the Undo he sees stops the only timer there is. **Retry** on a failed mail
one of this host's threads made goes through the host too (`work.mail.send`
on the row as the thread's foot showed it), where the hold queues it again;
one that may already have gone asks first. And the host calls a held mail
sent only once LifeOS has it on its way: the hold answers an item it had
already settled as it stands, so a draft left behind by an earlier send is
refused with words, never reported as sent.

**What goes is the row he was shown, to the edit.** A held mail's payload
carries LifeOS's `editedAt` as read with the item. The hold's `mail.send`
refuses (stale) a row whose edit time has moved since, and names that time
to `compose:send` and `compose:retry`, which compare it again in the
write's own transaction ("this mail changed since it was shown"); his own
mail's send names it too.

Either way LifeOS records the send as his, from this host's device session
(`sentFrom` is the session's client; a minted proof session reads "from a
minted sign-in"). A thread's key never sends: `send_mail` is refused by
LifeOS for a draft-only key.

## The outgoing rules

`outgoingHtml` is LifeOS's worker rule set (`apps/worker/src/gmail/body.ts`,
`sanitizeHtml(html, { outgoing: true })`) on the host: an allow-list that
writes out only what it read and kept. Scripts, event handlers,
`javascript:`/`data:` URLs, forms, frames, objects, `<base>`, `<meta>` and
comments go; styles, tables, `http`/`https`/`mailto`/`tel` links and
`http`/`https`/`cid` images stay. Both send roads run it (the hold's
`mail.send` in `outbox/lifeosHeld.ts` as well), because Outlook mail's
HTML goes from the `outbox` row into Outlook's `HTMLBody` as it is, and a
draft can carry an identity's raw signature. LifeOS desktop's own sends do
not pass through here (milestone 28).

## A draft beside its thread

The host watches `outboxHeld:held {host}` and opens each new draft of one
of its Work threads once, as a `mail` item in the pane of the thread's root
(`work_mail_opened` keeps that it did: a closed item stays closed). The
body reads LifeOS through the thread's workspace's sector (a Work Chat's
through the whole session) and mounts `Mailbox` pinned to the draft's mail
thread with only its pane drawn: the mail it answers, the composer rising
from its foot. A new mail with no thread fills the pane.

While an agent's rewrite waits (`outbox.proposed`, written by
`update_mail_draft`), the composer closes and the draft shows the rewrite
as words taken and put in (`proposalDiff`, work-kit's `diffWords`, the
review tints). The kind bar's stepper takes or leaves it through
`compose.settleProposal`; then the composer opens again on what was
decided. LifeOS refuses a take once the draft changed after the proposal.

Once the draft is sent, a hairline strip at the item's foot (`SentLine`)
shows the house rule his edit proposes, when it repeats one he made before
([work-rules.md](work-rules.md) "The screens"); with no proposal it draws
nothing.

## The Mail view

`Mailbox` under `MailClientProvider` and TempCode's `MailKit`, on the
workspace's session narrowed to its sector, so it lists that sector's mail
and no other. The frame draws no 40px header over it (`ownHead` on the
view's def; the region keeps the name "Mail", and takes the focus the
heading would, and the sign-in keeps the header): the mailbox
menu (Inbox, Needs me, Waiting on, Unread, Drafts, Scheduled, Sent,
Snoozed, Archive, Trash, then Mail settings), Filter, New mail and search are the list's own
head, inside work-kit, and Start thread is in the reader's More (a `mail`
chip, `{at: 'lifeos', table: 'mailThreads', id}`; the first send links the
thread to the mail). Which mailbox, which mail was open and the composer
stay per workspace while the window lives (`MailPage`).

A sender, and each known person in a message's Details, opens their page
in People when the address is one of the sector's people (work-kit's
`MailKit.openPerson`; [work-people.md](work-people.md)). People's Write
opens a new mail here through the kit's `onMailto` (`work/mail/mailto.ts`).
The face Mail draws is `work/mail/face.tsx`, which People draws too.

The list is 296px beside the reader and its edge takes a drag from 260 to
480px, kept for the app (`tc.mail.listWidth`). A view too narrow for the
kept width draws the list at its width less the reader's 360px, and the
kept width comes back with the room; the edge is a separator on
its own tab stop, 16px an arrow key, and a double press puts it back. At
and under 640px of view the list and the open mail take turns (`narrow`):
the reader's toolbar leads with the way back, and the keys move a row
without opening it until Enter.

Keys, selection, bulk acts with one Undo, search operators, Snooze, Delete
and Trash, Report spam, Unsubscribe and the invitation card are work-kit's
(its mail README); an invitation is answered by LifeOS's own calendar act
on his press (`calendarOps:save`, then `send` with `cause: 'press'`), the
road the Agenda view's New event takes. "Mention in a thread", in a row's
menu and a message's, puts the mail's chip in the composer of the thread
this window has open (the composer's own `@` finds a mail by subject and
sender through `mail:search`: lifeos/mentions.ts); with no thread open the
item is not drawn. A sent mail chip opens this view on its mail
(`openWorkView {view: 'mail', mail}`).

**Faces.** Whoever a mail is from or to shows a face by address (work-kit's
`SenderFace`): the picture LifeOS holds (`mail:faces`, one index for the
client: a person's picture in People, his own, a Google contact's, all
fetched by LifeOS's worker), else a glyph for a mailing list or a shared
mailbox, else initials. The kit's `Face` (kit.tsx) draws all three. The
page's policy lets no picture load from the web, so a stored picture is
read from LifeOS as bytes and drawn from a blob (`useFacePicture`), kept
for the session by its address in the store: a face seen once is there
from the first frame, and one that fails falls back to initials.

TempCode's kit: toasts through its own stack (Undo where the write has
one; `z` takes back the last such act while its toast still could), a link
from a mail opened outside only as http, https, mailto or tel, initials
faces, a sector mark by name and never a bare row dot (the
screens hold one sector), its key hints, its theme. A draft a thread wrote
is named in two parts ("Drafted in", then the thread's title, which the
composer draws a step stronger). A send inside its undo time is a toast
with the words over a track that empties across exactly that time, and
Undo. `mail.css` sets the
shared screens on TempCode's scale (subject 16/24, rows and fields 13/20,
labels 12/16) and the menus' highlight to the muted fill through
work-kit's `--ui-wash` (`HOST_WASH` in `work-kit/ui/host-rules`); it finds
work-kit's pop-ups, which draw in a portal outside the view, by the
`data-work-kit` attribute work-kit sets on each (never by a class), and
gives a menu Mail draws (`data-mail-menu`) TempCode's 28px menu row and a
settings dialog (`data-mail-dialog`) TempCode's quiet 28px Close. Snooze's
dialog is new with this Mail, so its date picker shows the chosen day and
today in both themes (`[data-mail-snooze]` gives the `--calendar-*` names
the values light gives them); the picker's older home, Send later, keeps
what `index.css` gives it in dark (appearance.md "Dark is held" lists the
edit that flips it).

## Pictures, and what the page may reach

A mail frame never touches the network (work-kit's `prepareMail`: every
outside address is taken out of a body, and the frame's own policy is
`default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:`, in a
sandbox with no scripts and no popups). Nothing a sender writes passes for
the reader's own: a body loses its `data-` attributes and the reader's
class names, a style block cannot close itself, a picture's bytes go only
into a picture. The
reader loads a picture as bytes and hands the frame a blob: an inline part
from LifeOS's file store, a web picture from the copy LifeOS's worker
fetched (`mail:requestPictures`, `mail:pictures`), so no sender's server
ever sees this machine. A stored body over 100 KB is read the same way.

So the page must be able to FETCH from LifeOS, and nothing more.
`withLifeosConnect` (`src/shared/pagePolicy.ts`) writes the LifeOS address
this host resolved (`lifeosAddress`: the owner's own, or
`TEMP_CODE_LIFEOS_URL` for an isolated instance) into `connect-src` of the
page's policy meta, for all three ways the page is served: the app scheme's
handler (`src/main/appScheme.ts`), the dev server (`electron.vite.config.ts`,
serve only) and the remote UI (`src/main/server/remote/ui.ts`). `img-src` is
never widened: `pagePolicy.test.ts` fails if it ever holds `https:`, because
that would let any transcript or page load a picture from anywhere. The
remote page's rewrite takes only a plain host from the request.

A file saved from a mail goes to Downloads under its own name, made safe
(`safeFileName`: no separators, no control characters, none of the marks
that turn a name round; a long name is cut from its stem, so its extension
stays), and a name already there gets a number ("name (1).pdf"). A part the
mail gave no name is named for its type by work-kit (`fileName`:
"attachment.pdf", "picture.png"). The window reads the bytes from LifeOS's
store and main writes them: the file's address in the store is never handed
to the browser, which would save it under the store's key.

## Attachments

A file of a mail opens where TempCode shows such a file, beside the mail;
anything else is saved to Downloads as before. work-kit's reader draws the
chips and asks TempCode's kit (`MailFile`: the store address, the name and
type, the mail thread, the message and the part):

- **Which files open.** The canvas registry's one lookup, `kindForFile(name,
  contentType)` (work/canvas/registry.ts, shared with the drop-to-open
  thread), names the kind; the file opens when that kind reads a fetched file
  (`FETCHED_KINDS` in work/canvas/fetched.ts) and the file names its thread,
  message and part:

  | Kind | Files | How |
  |---|---|---|
  | PDF | .pdf | the fetched copy, as a file |
  | Sheet | .xlsx, .xlsm, .csv | the copy held as a workbook; edits stay in it |
  | Media | pictures and video | a copy in the version's cache |
  | Slides | .pptx | the copy, through the PDF pillar's `sourcePath` |
  | Document | .docx, .doc, .odt, .rtf, .md, .markdown, .txt | read once into a `.tcdoc` beside the copy, **read only** |
  | Meeting | audio (the meetings kind's extensions and `audio/*`) | transcribed on the host from the copy |

  Everything else is saved: an archive, and .xls and .ods, which
  `kindForFile` gives no kind (the sheet claims neither, and its host reads
  only .xlsx, .xlsm, .tcsheet and .csv; LibreOffice converts both to .xlsx,
  but nothing calls it for a sheet yet). A video is the media kind's
  (`video/*` there wins), so a meeting recorded as video plays and is not
  transcribed; drop it on a meeting to transcribe it. The chip says "View
  report.pdf" or "Download archive.zip" (`fileVerb`), and a picture goes
  the same way (`viewsPictures`), so the reader's own picture viewer is
  LifeOS desktop's alone.
- **A document is read only.** The document kind reads the attachment with
  `work.formats.import` naming the mail source and its item: the host writes
  `<name>.tcdoc` beside the fetched copy, once, and opens and closes nothing,
  so the item stays the attachment (Download in its bar). The docs pillar
  answers that document with the `view` role for every caller (docs/index.ts
  `roleOf`, `fetchedItemOfPath`): no mode, no Share, the editor not editable,
  and a Word file's tracked changes tinted in the text with no stepper, Reject
  or Accept (the document kind feeds no review on the `view` role; the host's
  `work.history.decide`, `restore` and `cut` refuse it).
  An agent reads it by its item (`doc_read`) and is refused `doc_write`,
  `doc_suggest` and `doc_comment`. **Keep as document**, in More, saves the
  attachment to the workspace (below) and imports that copy into the pane,
  where the document it becomes is his to edit and takes the attachment's
  place.
- **Read only, every kind.** Until he keeps it, a mail's file has no mode menu, no stepper, no written line and no History in its bar, whatever its kind would say (work-canvas.md "Fetched sources").
- **Save to workspace**, in the bar beside Download for an attachment in a
  workspace's pane (a thread's or the Mail view's; a Work Chat has no
  folder), copies the host's file into the workspace's folder under its own
  name, made safe and numbered as a kept upload is ("Budget (1).xlsx";
  `work.canvas.keep`, `operate`). It is not `attachment.begin {into:
  'workspace'}`: that takes bytes from the window for a thread, and a mail's
  file is already on the host and the Mail view's pane is no thread. The
  chip in the mail has no menu TempCode can add to (work-kit draws a press
  and a Save button alone), so Save to workspace is the canvas's only.
- **Where.** In a mail item beside a thread (`MailCanvas.tsx`) the file is
  another item of that thread's pane. The Mail view has no thread, so it has
  a pane of its own: the reader's half is a `CanvasSeat` on
  `mailPaneOf(workspaceId)` (src/shared/work/canvas.ts), an owner of items
  as a thread is (the store takes it only for a Work workspace of this host,
  and drops its items when the workspace goes). The file at the left, the
  mail at the right, the toggle named Mail folds the mail away; the tabs stay
  while he moves between mails. Ask there starts a thread about the
  selection, since there is no composer beside it. Both are `placedKit`
  (`files.ts`): the window's one kit with the file members for that place.
- **The bytes.** The item's source is `{at: 'mail', threadId, messageId,
  partId, name, contentType?, size?}`. The pane asks the host
  `work.canvas.fetch {itemId}` (approve, carried only while the far screen is
  unlocked); the mail pillar's fetcher (`mail/attachment.ts`) reads the mail
  as the owner with `mail:thread`, refuses a mail outside the pane's sector
  whatever LifeOS answered (a thread's reach, `ctx.mentionReach`; the Mail
  pane's by its workspace), asks `mail:requestAttachments` for a part the
  worker has not fetched and waits up to two minutes, then streams the store's
  bytes into the item's own folder (`canvas/<owner>/<item>/file/<name>`, the
  name made safe as Downloads makes it). Never into his folder, and the page
  itself still reaches only LifeOS: nothing here widens the page policy.
- **Download** in the kind's bar reads the host's copy by range
  (`work.canvas.read`) and saves it on this computer under the attachment's
  own name, as Save does.

## Waiting on

Mail he sent that no one answered. LifeOS keeps it (its `mailWaits`
table, one row a mail thread, in the thread's sector), so LifeOS desktop
shows the same list; the rows, the composer's control and the mailbox are
work-kit's (its mail README, "Waiting on").

**What counts.** A thread waits when his message is its newest, and either
he marked it at send ("Remind me if there is no reply" in the composer's
foot: tomorrow, in 3 days or in a week, calendar days, kept on the draft
as `remindDays`) or his own words, above the quoted history, end a
sentence with "?" (a "?" in a link does not count). A marked mail shows
in Waiting on when its time comes; a question after the workspace's
working days (Mon to Fri in his time zone; 3 unless set), which LifeOS
keeps per sector (`settings.mail.waitDays`). A bulk, spam or deleted
thread never waits, nor one whose recipients are all no-reply addresses
(`no-reply@`, `donotreply@`, `notifications@`, `mailer-daemon@` and the
like) or his own. His own follow-up starts the clock again; anyone else's
newer message ends the wait. No model judges any of this. A cron in LifeOS
lists each wait once its time has passed and fires `mail.waiting` on the
sector's event feed, once.

**What LifeOS holds of his mail.** Gmail: everything, since LifeOS syncs
the sent folder, so mail he sent straight from Gmail counts (by the
question rule; only LifeOS's and TempCode's composer can mark one). Outlook
(Purdue): only a reply sent through LifeOS's or TempCode's composer, which
an Outlook host sends and records (`localSent`); mail sent straight from
Outlook never reaches LifeOS, and a new Outlook mail has no thread until
someone answers, so neither counts, and the composer offers the mark on an
Outlook mail only as a reply.

**The list.** Waiting on is a mailbox after Needs me, in the Mail view's
menu: newest wait first, a row leading with whom he wrote to and ending
with how long he has waited ("6 days", then "2 weeks"). Its acts, under
the pointer and in the row's menu, are Draft a nudge, Put off (the snooze
times) and Dismiss, the last two with Undo. A dismissed wait comes back
only when he writes in the thread again. It has no Filter and no count.

**The nudge.** Draft a nudge asks the host `work.mail.nudge {workspaceId,
threadId}` (operate; a thread's own call is refused, and so is a mail of
another sector): it starts a root Work thread in the workspace, linked to
the mail, whose first message asks it to read the thread and, if no one
has answered, draft a two or three sentence follow-up in his voice as a
reply in that thread with `draft_mail`. The window shows "Starting a thread
to draft the nudge" and opens the thread. The draft is held as every draft
is: it opens beside its thread and goes only on his Send.

**The routine.** A Work workspace's settings page has a Waiting on section:
"Questions wait" (1 to 10 working days; LifeOS's value for the sector) and
"Draft nudges by themselves", off until he turns it on, since each firing
is a model run. On, it makes one ordinary routine through the routines
pillar (`work.routines.save`: "Nudge mail with no reply", a LifeOS trigger
on `mail.waiting`, never ending), kept in `work_mail_nudge_routines`; off
pauses it, so its runs stay readable in Routines; on again resumes it, and
makes a new one if he deleted it there. No grant is made: each draft it
writes is held ([work-routines.md](work-routines.md)).

**A reply drops an unsent nudge.** When someone else's message ends a wait,
LifeOS deletes, in the same write, every draft an agent made in that mail
thread after his last message (an `origin` or a `botId`) that is still a
draft: never one he wrote, never one queued or sent. It writes a line in
LifeOS's activity log ("Dropped the nudge to Dana Lee: they replied"), and
for a TempCode draft a `mailWaitDrops` row. This host subscribes to its
drops (`mailWaits:drops {host}`) and adds a Result to the thread that
drafted it ("Dropped the unsent nudge “…”: Maya Chen replied", kind
`mail.nudge.dropped`), so he sees it in the thread's Results and in the
return from Away, then acknowledges it (`mailWaits:ackDrop`).

**For agents.** `mail_waiting` (read only, listed to a Work thread with a
sector, and named in its preamble) lists the sector's due waits: the
subject, whom it went to, when, whether he asked to be reminded, and the
mail thread's id.

## Settings

Settings, Work, Mail is work-kit's `MailSettings` on the host's whole LifeOS
session (a sector's session may read mail's settings and change none): the
account a new mail goes from, who a reply goes to, the undo time, pictures
from the web (Show, Ask, Never, with the senders allowed under Ask), list
rows, mark as read, the signatures, and each account's name, sector,
signatures and notices. LifeOS keeps all of it, so LifeOS desktop reads the
same values.

## The Outbox

`mail.send`'s own view: From, To, Cc, Bcc, Subject, then the words as
plain text exactly as they go, the files, and one muted line when a
rewrite waits (it is taken or left beside the thread, never here). The
plain text is what he is asked to read, since every word that goes is in
it. One switch, "As it looks", draws the mail as it will arrive: the HTML
this host sends (`outgoingMail`: the outgoing rules on his words, then the
quote) in a mail frame on white, with no colour moved, nothing folded, and
a link's real address under it while the pointer is on the link.

## Proving it

`bun scripts/mail-preview.ts` serves Mail on dummy mail (work-kit's fixture
client and corpus) under the app's own page policy, with no app, no host
and no sign-in, and drives it in a real headless Chromium over the DevTools
protocol (`work-kit/mail/proof`). `--proof` runs the reader's proof (an
inline picture, a web picture and a CSS background paint; the mail frames
make no network request; nothing is clipped after a late load; a real key
and a real click inside a mail reach the page; a pressed link stays in the
page's hands); `--policy <index.html>`
runs it under another app's policy (LifeOS desktop's). `--shots <dir>`
writes the review shots: every scene in `preview/scenes.ts`, dark and
light, at 1280 and 640 wide. The box's sans is DejaVu, so the shots use
Selawik as the stand-in for the system face.

Waiting on's scenes are `list-waiting`, `list-waiting-hover` (its acts),
`list-waiting-empty` and `new-mail-remind` (the composer's menu); the
workspace page's section is `bun run ui:preview
src/renderer/src/work/mail/WaitingSection.preview.tsx#WaitingPreview --props
'{"state":"off"}'` (also `on`, `lifeos`, `loading`). Tests:
`mail/waiting.test.ts` on the host, `work/mail/waiting.dom.test.tsx` in the
window, and work-kit's and LifeOS's own (`mailWaits.test.ts`).

`taskset -c 0-3 bun scripts/mail-preview.ts --speed` times the list
(`preview/speed.ts`): the first paint of a mailbox of 5,000 dummy threads
beside one of 50, seven runs each, turn about, by the median, from the
moment the dummy mail exists (the budget is one frame, 16ms); then a hard
scroll with the wheel through all 5,000 once loaded, which must leave no
task over 50ms. On 2026-11-19 (load 3.9): 67.2ms for 50 and 63.5ms for
5,000, no long task, worst frame 34ms, 20 rows drawn at a time.

The live proof against LifeOS (two mails, both from his own account to his
own address): a held draft's Send is undone inside its wait and nothing
goes; sent again, it goes when the window's wait ends, on his press, and
LifeOS shows it waited once; then a designed mail with a picture from the
web is sent, comes back through Gmail and is opened in the Mail view, where
its picture must paint from a blob in a frame with no address of the web in
it. `M23_ONLY=designed` runs the second part alone.

`env -u ELECTRON_RUN_AS_NODE bun src/main/server/work/mail/proof/live.ts <0600 token file> <shots dir>`
from the worktree after `electron-vite build`, with a token minted by
`sudo lifeos-deploy run <lifeos checkout> auth:mint '{"ownerId":"landon","name":"<name>"}'`.
Without `M23_SEND=1` it stops before Send and discards the draft. It
retires every key it made and signs out; the token is spent after one run.
