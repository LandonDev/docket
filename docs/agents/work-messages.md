# Work: Messages, chat beside Mail

The `messages` pillar (milestone 56, plan-80VsimogREJv): his chat (Slack,
Discord, iMessage, Teams) as LifeOS holds it, in a Messages view beside
Mail. LifeOS keeps the conversations (`chats`), their unread mark, their
files and the replies' queue; TempCode reads no chat service. The window
reads lists and conversations straight from LifeOS on its sector session
and writes only the read mark there; every send goes through the host.

## LifeOS (its `docs/BRIEF.md`, "Conversations")

One `chats` row for the stored messages that share a source, an account and
a channel, stamped by `rawMessages.insertRaw` as each chat message is stored
and restamped when its source's sector moves; `chatFiles` rows for a
message's pictures and files. Unread is `unreadOf` in `@lifeos/shared`:
someone wrote to him (a direct message, a mention or a reply), or he marked
it unread, after he last read it here, after Slack says he read it there and
after his own last message in it. The functions the pillar calls, each
through LifeOS's own sector fence:

| Function | Who calls it |
|---|---|
| `chats:list {sector, filter?, paginationOpts}`, `chats:get {id}`, `chats:messages {chatId, paginationOpts}`, `chats:unread {sector}`, `chats:search {sector, text, limit?}`, `chats:markRead`, `chats:markUnread`, `chats:requestFiles {messageId}` | the window, on the sector's session |
| `chats:get`, `chats:search`, `chats:unanswered {sector}`, `chats:unread`, `chats:find {sector?, text}`, `chats:reply {chatId, replyTo?, text}`, `chats:file {id}`, `chats:requestFiles`, `replies:undo`, `replies:retry`, `sources:list` | the host, as the owner |

`chats:get` answers `route`: `{can: true}` or `{can: false, why}` with
LifeOS's sentence ("LifeOS can't reply in Discord yet", "Your Mac isn't
running LifeOS"). LifeOS's worker fetches a file's bytes only once a client
asks (`requestFiles`), for Slack and Discord, and reads Slack's own read
mark every two minutes.

## Names and rules (src/shared/work/messages.ts)

`CHAT_SOURCES`, `SOURCE_NAME`, `SOURCE_APP`, `CHAT_ROUTES` (which sources LifeOS can send
to: Slack and iMessage; Discord and Teams are Copy), `OWN_REPLY_HELD`
(false: his own Send goes on his press), `AGENT_CHAT_SECTORS` (the sectors
whose chat a thread may read), `staleOf` (the one rule the view's sync line
and Connections share), `serviceState`, `syncWhen`, `syncLine`, `fileMarkers`, `replyWhere`,
`firstWords`, and the shapes LifeOS answers (`ChatRow`, `ChatDetail`,
`ChatMessage`, `ChatHit`, `ChatWaiting`, `ChatDraft`, `ChatRoute`).

## The wire (src/shared/contract-work-messages.ts)

| Method | Cap | What |
|---|---|---|
| `work.messages.send {workspaceId, chatId, replyTo?, text}` | approve, no thread | his own reply: `chats:reply` as the owner → `{id}` (LifeOS's outbox row); with `OWN_REPLY_HELD` a held `chat.reply` with no thread, and `id` is the held item's |
| `work.messages.undo {workspaceId, chatId, id}`, `retry {…}` | approve, no thread | `replies:undo` → `{text}`, `replies:retry` → `{}`; refused unless the conversation is the workspace's and the reply is one of its newest hundred messages' |
| `work.messages.search {workspaceId, query, limit?}` | read | `chats:search` → `{hits}` |
| `work.messages.unanswered {workspaceId}` | read | `chats:unanswered` → `{rows: ChatWaiting[]}` (Today) |
| `work.messages.unread {workspaceId}` | read | `chats:unread` → `{unread, newest?}` |
| `work.messages.drafts {workspaceId, chatId?}` | read | the copy-only drafts threads left |
| `work.messages.dropDraft {workspaceId, id}` | operate, no thread | drops one |

The push `{push: 'work.messages', workspaceId, unread, drafts?}` follows a
workspace's unread count (once a change) and its drafts (`drafts` is how
many wait).

## The fence

The host reads LifeOS with the owner's client, which reads every sector, so
every read is fenced by hand (`messages/lifeos.ts`): `workSector` refuses a
code workspace and a Work workspace with no sector; LifeOS is asked for that
sector alone; every row it answers is checked again (`row.sector ===
sector`), and a conversation named by id is read with `chats:get` and
answered as if it did not exist when its sector differs (`chatIn`).

## The module (src/main/server/work/messages/)

| File | What |
|---|---|
| `index.ts` | `ensure` (`work_messages_drafts`), `handle`, `tools`, `acts`, `mentions`, `preamble`, `start`, the workspace hooks, `health` |
| `lifeos.ts` | the fenced reads, `refusalWords` (LifeOS's ConvexError as its words) |
| `replies.ts` | his presses and the drafts |
| `held.ts` | the held kind `chat.reply` |
| `tools.ts` | `messages_read`, `messages_draft_reply`, the preamble line |
| `health.ts` | Connections' rows |
| `watch.ts` | the live subscriptions while Work is on |
| `mentions.ts`, `tell.ts`, `search.ts` | `@`, the digest's tells, the one search's sources |
| `file.ts` | the chat file fetcher |
| `fakeChats.ts`, `testRig.ts` | LifeOS's chat in memory and the rig, for the tests |

- **Tables.** `work_messages_drafts (id, workspace_id, chat_id, session_id,
  text, at)`, indexed on (workspace_id, chat_id). A draft outlives its
  thread and goes with its workspace (`workspaceRemoved`).
- **The hold.** `chat.reply`, `store: 'host'`, no matcher (so no grant can
  cover one; `held.ts` names the two lines that would add `{chatId}`),
  payload `{chatId, replyTo?, source, chat, to?, text}` (1 to 4000), an
  Outbox edit changes `text` alone. Words "Reply in Slack to Dana Lee:
  “first words”", verb Send. On the press it reads `chats:get` again: gone,
  or in another sector than the item's → stale; a Copy source or a route
  that says no → not sent in LifeOS's sentence; else `chats:reply` →
  "Sent to Dana Lee in Slack", ref `{at: 'lifeos', table: 'outbox', id}`; a
  refusal of `chats:reply` is not sent in its words, any other fault may
  have gone. No way back. It earns nothing (`wordsOf` keeps `{chatId,
  text}`; no `targetOf` or `earnedOf`).
- **Tools**, listed to a Work thread whose sector is in
  `AGENT_CHAT_SECTORS`: `messages_read {chat?, query?, before?, limit?}`
  (read only; the list, a conversation oldest to newest as plain lines with
  times and file names, or a search; marks nothing read) and
  `messages_draft_reply {chat, text, reply_to?}` (a Slack or iMessage
  conversation → a held `chat.reply`, whatever LifeOS's route says now; a
  Discord or Teams one → a draft row, a push and "Saved as a draft in the
  conversation: nothing can send to Discord from here, the owner will copy
  it."). The preamble line: "Chat: read this job's conversations with
  messages_read. To answer one, use messages_draft_reply: the reply waits
  for the owner's press. You never send chat."
- **Connections.** One row a chat service, account and sector that a Work
  workspace of this host links, group "Chat", `shared`, its `sector`
  (`foldAccounts`: LifeOS keeps a row a Discord channel, and the page says
  "Discord" once; a chat source with no sector is life's, as LifeOS has it):
  any row in error → broken in its redacted words; stopped with a reason →
  needs you; its freshest row silent past `CHAT_SILENT_MS` (Slack and
  Discord 15 minutes, iMessage and Teams 36 hours) → broken "No sync since
  Nov 3"; else working. Disabled sources, mail sources and unlinked sectors
  have none. The view's sync line judges a service the same way
  (`serviceState`).
- **Live.** `start` keeps one `chats:unread` and one `chats:unanswered` a
  linked Work workspace, following workspaces made and deleted.

## Threads and the digest

- The chip kind `chat` ("conversation"), ref `{at: 'lifeos', table:
  'chats', id}`, label "Dana Lee in Slack"; the model reads "About this
  conversation: Dana Lee in Slack (LifeOS chats <id>)". `@` finds
  conversations by name with `chats:find`, kept to the thread's reach.
  `typedWords` (work/threads.ts) knows the chip's head, so a message's
  words quoted under it never count as words he typed.
- A conversation that newly waits on him is told to the digest with
  `ctx.tell({kind: 'messages.new', workspaceId, title: 'Dana Lee wrote in
  Slack', detail, open: {view: 'messages', workspaceId, at: chatId}, key:
  'messages:<chatId>'})`, once, and taken back with `ctx.tell.done(key)`
  when it leaves the list (`tell.ts`; the module lists `tells: [{kind:
  'messages.new', group: 'people', name: 'New messages'}]`). It says no
  `by`: the digest's rule decides whether it interrupts. `open.at` is the
  conversation's id: `openWorkView({workspaceId, view: 'messages', chat})`.
- **The one search** (`search.ts`): two sources on the module, `message`
  (a job's messages that hold the words, `chats:search`) and `chat` (its
  conversations by name, `chats:find`), each job in reach asked by its own
  sector. A hit opens the view (`{to: 'view', view: 'messages', with:
  {chat, message?}}`) and carries the conversation's chip.
- **Today** (`src/renderer/src/work/messages/today.ts`, one line in
  `TODAY_SOURCES`): the section Messages (order 45), rows keyed
  `chat:<chatId>` from `work.messages.unanswered` in every job, asked again
  on the `work.messages` push; a row opens its conversation and offers Mark
  read.
- A sent conversation chip, a search hit and a tell open the view through
  `OpenWorkView.chat` and `message` (lib/workSwitch.ts).

## Files

A chat's picture or file is a canvas item on the mail arm of
`CanvasSource` with one field more: `{at: 'mail', from: 'chat', threadId:
<chatId>, messageId, partId: <chatFiles id>, name, contentType?, size?}`.
Every kind that opens a fetched file opens this one unchanged; only the
fetcher differs: `canvas/fetch.ts` picks it by `source.from ?? 'mail'`.
`messages/file.ts` reads `chats:file` as the owner, refuses a file whose
conversation is outside the pane's sector (or whose row names another
conversation or message than the item does), asks `chats:requestFiles` for
one not stored and waits up to two minutes, fails in LifeOS's words ("Slack
needs the files permission. Reinstall the app."), then streams the bytes
into the item's own folder. The pane is `messagesPaneOf(workspaceId)`
(`msgpane_<id>`), a pane owner as the Mail view's is (`paneWorkspace`,
`PANE_PREFIXES`). Read only, Download, Save to workspace and Keep as
document are the canvas's, as for a mail's file. iMessage and Teams hand no
files: there a file is the plain line LifeOS stored.

## The view (src/renderer/src/work/messages/)

| File | What |
| --- | --- |
| `view.ts` | The row and its view: after Mail (`order` 0.5), `readsLifeos`, `ownHead`, the chunk `work-messages-view`. In the first paint: an icon, the chunk and `facts.ts`. |
| `facts.ts` | The row's fact: `chats:unread {sector}` on the column's session, "3" or nothing. |
| `data.ts` | The one seam, `MessagesData`. Reads: `useChats(filter)`, `useUnread()`, `useChat(id)`, `useMessages(id)`, `useSources()`, `useSearch(text)`, `useDrafted()`, `useDrafts(chatId)` (`ThreadDraft`: a held reply or a copy-only draft, its thread), `useNow()`, `fileVerb(file)`. Writes: `markRead`, `markUnread`, `send`, `undo` (answers the words), `retry`, `sendDraft(draft, text)`, `dropDraft`, `requestFiles(messageId)`, `openFile(chatId, message, file)`. `WAITING` answers while the session opens. |
| `live.ts` | The seam from LifeOS on the workspace's sector session (`chats:list`, `get`, `messages`, `unread`, `search`, `sources:list` kept to this sector's chat kinds, `markRead`, `markUnread`, `requestFiles`), each list one live query grown in place, the smaller answer kept on screen while the bigger comes; his replies through the host (`work.messages.send`, `undo`, `retry`, `drafts`, `dropDraft`, a refusal in its own words); a thread's held reply from the Outbox's own list (`outbox/store.ts`: `useOutbox`, `editItem` then `sendItem`, `discardItem`); copy-only drafts read once a workspace and again on the `work.messages` push. |
| `files.ts` | `viewKind` (the canvas kind `kindForFile` names, when the canvas fetches it), `fileVerb`, `chatFileSource` (the mail arm with `from: 'chat'`). |
| `threads.ts` | `chatChip` ("Dana Lee in Slack", a message's words as `quote`), `threadRows` (Start thread; Mention in a thread only while one is open), `linkRows` (Open in the app, Copy link), `mention`, `StartThreadProvider`. |
| `fixtures.ts`, `pictures.fixtures.ts` | The seam from a made-up studio, Starboard, kept in memory (a reply lands as his own message, an undo takes it away, a pressed draft goes), with switches: `loading`, `empty`, `noSource`, `stale`, `drafted`, `drafts`, `routes`, `refuse`, and `manyChats`/`manyMessages` for the speed proof; two made-up pictures as `data:` addresses. |
| `page.ts` | Per workspace, while the window lives: the open conversation, the filter, the search, what he typed in each conversation (live: Undo writes back into it), a message asked for (`wantMessage`), whose words the field holds (`keepTyped(…, from)`) and its revision (`typedRev`), the pending press (`keepPress`), what became of a draft before the Outbox's list says so (`markDraft`: settled or failed), the visit's "New", its place (`visitPlaceOf`) and his held unread mark (`markUnreadHeld`), the way back to the list (`returnTo`, `peekReturn`, `takeReturn`); outside React, the list's scroll and each conversation's place. |
| `model.ts` | Pure rules: `rowTime`, `dayWords`, `rowLine`, `chatFact`, `newSince`, `wantsRead`, `blocksOf` (runs inside five minutes, days, "New"), `estimateOf`, `isPicture`, `pictureBox` (360 by 270), `linkParts` and `opensOutside` (http, https, mailto), `markWords`, `aroundMatch`. |
| `MessagesView.tsx` | The frame (`ListFrame`, Mail's: 296px, 260 to 480, `tc.messages.listWidth`), the narrow rule at 640px (one tree in both layouts: under it the list or the pane is hidden, never remounted), the conversation in a `CanvasSeat` on `messagesPaneOf` (toggle "Messages"), `useOpened` (`OpenWorkView.chat` and `.message`, taken once), `MessagesScreen` for the preview. |
| `ChatList.tsx`, `Conversation.tsx`, `Message.tsx`, `Composer.tsx` | The list, the conversation, one message (its reply state, pictures and files), the composer. |
| `act.ts`, `ChatReplyAct.tsx` | The Outbox's view of a held `chat.reply`: To, In ("Slack, Starboard Games"), the message it answers as one quoted line, the words exactly. |
| `messages.css` | The 14/22 step and the one motion: a message arriving at the foot. |
| `quick.ts` | The empty list of one-press answers. |

The look is docs/DESIGN.md "The Messages view".

- **One reader.** The list and the pane keep their places in one tree at
  every width (`ListFrame` with `narrow`): under 640px the list is hidden
  (the `hidden` attribute) while a conversation is open, and the pane while
  none is, so crossing the line remounts nothing; his place in the column, a
  Send on its way, his words and the keys stay where they were. The hidden
  list takes the keys back as it shows again, not as it mounts. A remount
  that cannot be helped (Retry) opens where he stood this visit, reading
  older pages to hold that row, ahead of "New". At the toolbar's seam the
  column fades over 12px (the app's edge fade, a `mask-image`), so a line cut
  by the scroll's top edge never shows as a sliver.
- **Windowing.** The list's rows are one height, so `useWindowed`
  (work-kit/mail/lib/window, Mail's) draws only those near the window. The
  conversation's blocks are measured: `RowLayout` (lib/transcriptWindow.ts)
  counts offsets up from the foot, and the scroller is `flex-col-reverse`,
  so it opens at its foot with no script, a new message at the foot keeps
  him there, and an older page added at the top moves nothing he sees; a
  block that changes size under his place shifts the window by `anchorShift`.
  One ResizeObserver watches the viewport and every drawn block, as the
  transcript watches its rows: a size that changes with no draw of the column
  (a picture falling to its failure line, a sash drag rewrapping the words)
  draws it again, and that draw's measure moves the offsets and holds his place.
- **Unread.** LifeOS's mark (`ChatRow.unread`). Opening a conversation marks
  it read when it is unread or someone wrote since he last saw it
  (`wantsRead`); so does a message that arrives while it is open and the
  window is in front, or his coming back to the window. His own Mark unread
  on the open conversation holds from the command itself (`markUnreadHeld`,
  let go if LifeOS refuses the write), kept with the visit in page.ts: nothing marks the conversation read again
  until a newer message from someone else comes or the visit ends. The read
  mark waits until the column has placed him (on a wanted message, or where
  it opens once that lookup ends without it) and needs a ready page, so a
  conversation whose messages did not come is not marked read. "New" is read from the first answer and kept for the
  visit in page.ts (`visitSince`), so a Retry or a remount finds the same
  line; leaving the conversation ends the visit (`newSince`): over the first message from someone else since his mark, the
  service's own or his own last word, and only for one he has opened before
  or that is unread. When it lies above the first page the column reads older
  pages until it holds it (at most twenty) and opens there.
- **The composer.** Send when the source is LifeOS's (`CHAT_ROUTES`) and the
  route says yes; else Copy, Open in the app beside it, LifeOS's `route.why`
  above (for a Copy source whose route says yes, "LifeOS can't reply in
  Discord yet"). The route chooses the button: a held draft where it says no
  is copied, LifeOS's reason on the draft's line, and it and its id stay
  until the route returns. A thread's held reply wins over a copy-only draft; either
  fills an empty field once and never writes over his words. Send acts on
  whose words the field holds: the draft's (or his edit of them) press the
  held item, saving an edit to it first (`work.outbox.edit`) and pressing
  with the `rev` it now has, anything but sent or sending refused in the
  Outbox's words; his own go as his own reply (`send`, never the draft's
  `replyTo`) and the draft keeps waiting, its line offering Use draft, which
  puts the draft's words before his. Whose words they are is kept beside them
  in page.ts (`keepTyped(…, from)`), so leaving and coming back, a Retry or
  the 640px crossing find a draft still a draft; a draft gone meanwhile
  leaves its words as his own. Send empties the field at the press; the
  pressed words (and the held draft's id when a draft was pressed) wait in
  page.ts as the pending press (`keepPress`) until LifeOS answers, and while
  it is pending Return and the button do nothing more for that conversation
  on any mount, so nothing goes twice and sent words never sit in the field.
  On a refusal the pressed words come back before whatever he typed since, a
  line between, with the draft's id when a draft was pressed, and the
  refusal shows. A held draft pressed or discarded here is marked settled in
  page.ts (`markDraft`) and left out of the drafts (`useWaitingDrafts`,
  drafts.ts) until the Outbox's own list drops it, so its line, Use draft
  and a fill of an empty field never come back for the round trip, on any
  mount. A held reply whose press failed stays in the Outbox (Send again,
  Check whether it went first there): the composer's line (`role="status"`)
  says "Not sent." when the outcome is known, or "May have gone." with the
  Outbox's own "Check whether it went first" when it is not (`outcomeUnknown`,
  carried on the draft and on the rejected press as `unknown`), then the
  thread's name in ink, the reason muted 10px after it, the route's reason
  while the button is Copy, and Open in Outbox, which opens that very item
  (`wantOutboxItem(<host>:<ref.at>:<ref.id>)`) in whichever tab holds it, its
  tip the whole line. The line wraps rather than cutting its reasons. A
  status region always mounted in the composer (`data-press-status`) speaks
  the word and the thread as they appear. The last press from this composer
  that failed or may have gone owns the line over any other draft waiting
  (`keepFailedPress`), until he opens it in the Outbox or the Outbox's list
  no longer holds it failed. Its words never come into the field, and the
  row wears no "a draft waits" mark for it. A held press refused with the
  item still held (a revision conflict) leaves its words with the item,
  offered by Use draft; whatever the field holds then (a reply his Undo put
  back, words typed since) stays his own, untouched, and the refusal shows
  above the draft's line rather than in its place. Whose words the field holds is answered once, against every draft
  still waiting (`fieldOrigin`, drafts.ts: held, copy-only, failed, or his
  own), for the line, Send and the cleanup alike: a failure from elsewhere
  empties the field only if it still holds the item's own words, and an edit
  he was making stays as his own words. A draft already waiting when the
  field held other words never fills it later; only a draft that arrives
  does. Every step that awaits (Send, Discard, Copy's cleanup, Undo and the
  save inside it) takes the field as pressed before it awaits
  (`fieldAsPressed`: words, origin, revision) and judges by it after
  (`stillPressed`): Discard and the cleanup after Copy empty the field only
  if its revision (`typedRev`, moved by every edit) still stands. A refusal is kept with the conversation (`page.ts`) until he
  types or sends again. His own reply shows from LifeOS's row: `queued` is
  "Sending" with Undo, `sending` "Sending", `failed` "Not sent." with the
  reason and Retry. Undone words are his own and never take a draft's id,
  judged when the Undo settles: into an empty field, else before his own
  words, a line between; where the field then holds a held draft's words,
  they are saved to the item first when they differ from its own
  (`saveDraft`, the Outbox's edit), and again if he went on editing them
  while the save went, then the field takes his words and the draft waits
  behind Use draft; words that became his own meanwhile stay behind his.
- **Threads.** Start thread is the toolbar's 28px button and a row on the
  row's and a message's menus; a message's chip carries its words as
  `quote`. Mention in a thread puts the chip in the thread open in the window
  (`addContextChip`) and says so in a toast with Open.
- **The ways in.** `OpenWorkView.chat` opens the conversation; with
  `message`, the column reads older pages until it holds it (at most twenty),
  brings it into view with 96px of air over it, and marks it with the muted
  fill for 1.2 seconds, which then fades over `--dur-slow` (at once under
  reduced motion). A hit in the view's own search opens its message so; the
  count of older pages starts afresh for each message asked for.
- **Keys.** The list is one tab stop: the arrows move its active row (beside
  the conversation they open it; under 640px Enter does, and opening puts the
  keys on Back, which gives them back to the row he left, or the one now in
  its place when reading it took it off an Unread list, or Clear filter when
  none is left, or in a search the hit he opened); Shift+F10 or the
  menu key opens the active row's menu; until a row is active and drawn the
  list wears the focus ring. When the row the keys stand on leaves the list
  (read, under Unread), the row now at its index becomes the active row,
  marked and named (`aria-activedescendant`), so Enter and the menu key act
  on a row he sees. Beside the conversation, Down from there opens that row
  itself (the active row that is not the open one), so going down an Unread
  list with the arrows reads every conversation in turn; Up steps as ever;
  under 640px Down moves from it. When the last one leaves, the keys go to
  Clear filter.
  Clear filter leaves the keys on the whole list's first row; Clear search
  hands them to the search field. No control that goes by its own action or
  a change of layout drops the keys to the page: widening past 640px with
  Back focused hands them to the list holding the conversation's row, found
  by its id whatever the detail is doing (else the composer's field, else
  the pane's Retry, else the search field), and "2 new" hands them to the
  column as it goes. Search hits are one list the same way; a search
  keeps its last hits on screen while the next words are asked (bones only
  before the first answer), and a hit's line is measured so the word it
  found always shows: measured in its own font on a canvas
  (`measureText`, widths kept by words), the words through the match are
  never cut when they fit; else what leads up to and through the match gets
  about two thirds of the line, so words follow it, starting at a word where
  one starts there, else mid-run (a URL's match shows too), and "…" stands
  only where words were cut, never before a match at the very start; where nothing can measure text it
  counts characters (`aroundMatch`). New words, ×, Escape and Clear search
  drop the way back (one clear for them all). Back under
  640px is taken by the first answer that shows, once: hits put the keys on the hit he left (or the one
  now in its place), brought into view; no hits on Clear search; a failure
  on its Retry, the way back kept for the search Retry brings. Later answers,
  as he types, take nothing. In the column the
  arrows move from message to message and the menu key opens one's menu; a
  message's ⋯ is no tab stop. The log says nothing of itself (`aria-live
  off`), so an older page drawn on the way up is not read out; what arrives
  at the foot is said once in a polite status.
- **Failures.** Each failure line (the list, a search, a conversation, its
  messages) has Retry, which mounts the failing reads again, so LifeOS is
  asked afresh; the seam needs no verb for it. Sources that did not load make
  an empty list say it did not load. A conversation that fails keeps its
  toolbar, so the way back stays under 640px.
- **Pictures and files.** A message's `listed` files are asked for as it
  mounts (the column draws only what is near the window), once a window's
  life while the ask is on its way or taken; an ask LifeOS did not take says
  so on each file with Try again. A stored picture's bytes are read with
  `loadBytes` into a blob address, never put in the page as a web address,
  one read an address at a time, at most 120 held (the oldest no drawn
  picture uses released, read again when drawn again); a picture never grows
  wider than its message, its height from its proportions; one whose bytes
  did not come or do not draw says so in a file's failure line, with Try
  again and Open in the app. A file LifeOS lists but has not stored yet
  (`listed`, `wanted`) is its own chip, pending: a spinner in its tile, the
  name muted, `aria-busy`, and a picture in the same state is its skeleton,
  `aria-busy`; a press asks the conversation to open it (`wantFile`, by
  message and file id in page.ts), which settles once, wherever the message
  has scrolled: it opens the file when it is stored, or lets the ask go when
  the file fails. Leaving the conversation drops the asks. No toast for a
  file that is merely on its way. A file a canvas kind shows opens in the view's own pane
  (`openItem(env, messagesPaneOf(ws), {kind, source: chatFileSource(…)})`,
  the host fetching it as the owner); any other is saved to Downloads once
  stored. `fileMarkers` takes the folded names out of the words once the
  files are listed.
- **The Outbox.** A held reply's quote is read from the newest page, else by
  its id (`rawMessages:get {id}`) on the item's own sector; a line of bones
  holds its place until LifeOS answers. A reply that names its message is
  read by id also when the page did not load; "The message it answers is no
  longer here" only when LifeOS answers that it is absent, "could not be
  read" with Retry when that read failed, or at once, whatever the page is
  doing, when the conversation's own read failed and the reply names no
  message. Retry keeps the keys: the quote's slot (`data-quote-slot`) holds
  its place through every state and takes them when Retry held them. A
  parent with no words says "A picture or file". The quote is "Writer: words", cut where its
  line ends; in a direct chat the writer is left out only when it is the
  recipient, so his own words still say "You:".
- **Not yet.** One-press answers (`QUICK_ANSWERS` is empty).

Proof: `bun run ui:preview src/renderer/src/work/messages/MessagesView.preview.tsx#MessagesPreview --props '{"scene":"open-direct","width":1280}'`
(scenes are listed in the file); tests `model.test.ts`, `MessagesView.dom.test.tsx`, `Composer.dom.test.tsx`,
`ChatReplyAct.dom.test.tsx`, `ways.dom.test.tsx`, `files.dom.test.tsx`, `open.dom.test.tsx`, `cold.dom.test.tsx`,
`council.dom.test.tsx`, `council2.dom.test.tsx`.

## Proving it

`bun scripts/messages-preview.ts` runs the view in a real Chromium with no
app, no host and no sign-in: it bundles
`src/renderer/src/work/messages/preview/page.tsx`, compiles the renderer's
own stylesheet and serves both under the app's page policy
(`scripts/lib/previewSite.ts`). `--shots <dir>` shoots every scene, dark and
light, at 1280 and 640. `--speed` (run it pinned: `taskset -c 0-3`) times
first paint of 2,000 conversations beside twelve and of 5,000 messages
beside an everyday conversation, then scrolls hard through each and fails on
any task over 50ms. `--live <token file> --sector cosmic` is the one live
read: the view's own screens on LifeOS itself as a sign-in narrowed to one
sector; it prints counts and keeps no picture, since what is on the page is
his chat.

## Proofs

`messages/messages.test.ts` (the fence on each read, health's rows and the
fold, the push), `held.test.ts` (held, Away, once on two presses, no
thread's press, no grant, stale and not sent), `tools.test.ts` (who is
offered chat, the read tool's fence, the draft row, his presses),
`mentions.test.ts` (`@`, the chip's line, the tells), `search.test.ts`,
`file.test.ts` (the fetcher's fence, ask and wait, its failures, picked for
a chat's file and never a mail's), `src/shared/work/messages.test.ts`
(stale, the sync line, folded file names). What has run against the live
LifeOS, and what has not, is `.temp-code/plans/landed/R3-messages.md`.
