# Work: Messages, chat beside Mail

The `messages` pillar (milestone 55, plan-80VsimogREJv): his chat (Slack,
Discord, iMessage, Teams) as LifeOS holds it, in a Messages view beside
Mail. LifeOS keeps the conversations (`chats`), their unread mark and the
replies' queue; TempCode reads no chat service. This file is the host's
side; the view's account is added beside it by the screens' build.

## Names and rules (src/shared/work/messages.ts)

`CHAT_SOURCES`, `SOURCE_NAME`, `CHAT_ROUTES` (which sources LifeOS can send
to: Slack and iMessage; Discord and Teams are Copy), `OWN_REPLY_HELD`
(false: his own Send goes on his press), `AGENT_CHAT_SECTORS` (the sectors
whose chat a thread may read), `staleOf` (the one rule the view's sync line
and Connections share), `syncWhen`, `syncLine`, `fileMarkers`, `replyWhere`,
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
| `mentions.ts`, `tell.ts` | `@` and the digest's tells |
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
- **Connections.** One row a chat source of a sector a Work workspace of
  this host links, group "Chat", `shared`, its `sector`: error → broken in
  its redacted words; idle with an error → needs you; silent past
  `CHAT_SILENT_MS` (Slack and Discord 15 minutes, iMessage and Teams 36
  hours) → broken "No sync since Nov 3"; else working. Disabled sources,
  mail sources and unlinked sectors have none.
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
  `ctx.tell?.({kind: 'messages.new', workspaceId, title: 'Dana Lee wrote in
  Slack', detail, open: {view: 'messages', workspaceId, at: chatId}, key:
  'messages:<chatId>'})`, once, and taken back with `ctx.tell.done(key)`
  when it leaves the list. `WorkCtx.tell` and the module's `tells` are the
  digest's build: until they are on master the call is typed in `tell.ts`
  and does nothing, and the module lists no `tells`. `search: [source]`
  waits the same way for the one search's `SearchSource`.

## The view (src/renderer/src/work/messages/)

| File | What |
| --- | --- |
| `view.ts` | The row and its view: after Mail (`order` 0.5), `readsLifeos`, `ownHead`, the chunk `work-messages-view`. In the first paint: an icon, the chunk and `facts.ts`. |
| `facts.ts` | The row's fact: `chats:unread {sector}` on the column's session, "3" or nothing. |
| `data.ts` | The one seam, `MessagesData`: `useChats(filter)`, `useUnread()`, `useChat(id)`, `useMessages(id)`, `useSources()`, `useSearch(text)`, `useDrafted()`, `useNow()`, `markRead`, `markUnread`. `WAITING` answers while the session opens. |
| `live.ts` | The seam from LifeOS on the workspace's sector session: `chats:list` (100 more as he nears the end), `chats:get`, `chats:messages` (50 more as he scrolls up; one live query each, grown, the smaller answer kept on screen while the bigger comes), `chats:unread`, `chats:search`, `sources:list` kept to the chat kinds of this sector, `chats:markRead` and `chats:markUnread`. |
| `fixtures.ts` | The seam from a made-up studio, Starboard, with switches: `loading`, `empty`, `noSource`, `stale`, `drafted`, and `manyChats`/`manyMessages` for the speed proof. |
| `page.ts` | Per workspace, while the window lives: the open conversation, the filter, the search; outside React, the list's scroll, each conversation's place and what he typed in it. |
| `model.ts` | Pure rules: `rowTime`, `dayWords`, `rowLine`, `chatFact`, `newSince`, `wantsRead`, `blocksOf` (runs inside five minutes, days, "New"), `linkParts` and `opensOutside` (http, https, mailto), `markWords`, `aroundMatch`, and `threadRows`. |
| `MessagesView.tsx` | The frame (`ListFrame`, Mail's: 296px, 260 to 480, `tc.messages.listWidth`), the narrow rule at 640px, `MessagesScreen` for the preview. |
| `ChatList.tsx`, `Conversation.tsx`, `Message.tsx` | The list, the conversation, one message. |
| `messages.css` | The 14/22 step and the one motion: a message arriving at the foot. |
| `quick.ts` | The empty list of one-press answers. |

The look is docs/DESIGN.md "The Messages view".

- **Windowing.** The list's rows are one height, so `useWindowed`
  (work-kit/mail/lib/window, Mail's) draws only those near the window. The
  conversation's blocks are measured: `RowLayout` (lib/transcriptWindow.ts)
  counts offsets up from the foot, and the scroller is `flex-col-reverse`,
  so it opens at its foot with no script, a new message at the foot keeps
  him there, and an older page added at the top moves nothing he sees; a
  block that changes size under his place shifts the window by `anchorShift`.
- **Unread.** LifeOS's mark (`ChatRow.unread`). Opening a conversation marks
  it read when it is unread or someone wrote since he last saw it
  (`wantsRead`); so does a message that arrives while it is open and the
  window is in front, or his coming back to the window. "New" is fixed as it
  opens (`newSince`): over the first message from someone else since his
  mark, the service's own or his own last word, and only for one he has
  opened before or that is unread.
- **Thread verbs.** Start thread and Mention in a thread need the chip kind
  `chat`, which lands with the host build; until then `threadRows` answers
  none and no verb is drawn.
- **Not yet.** The composer and the held reply, pictures and files (the
  place is marked in `Message.tsx`), Open in an app and Copy link on a row's
  menu (a row carries no link; the conversation's More has them), and a
  conversation opened from elsewhere (`OpenWorkView.chat`).

Proof: `bun run ui:preview src/renderer/src/work/messages/MessagesView.preview.tsx#MessagesPreview --props '{"scene":"open-direct","width":1280}'`;
tests `model.test.ts` and `MessagesView.dom.test.tsx`.

## Proofs

`messages/messages.test.ts` (the fence on each read, health's rows, the
push), `held.test.ts` (held, Away, once on two presses, no thread's press,
no grant, stale and not sent), `tools.test.ts` (who is offered chat, the
read tool's fence, the draft row, his presses), `mentions.test.ts` (`@`,
the chip's line, the tells). Nothing here has run against the live LifeOS.
