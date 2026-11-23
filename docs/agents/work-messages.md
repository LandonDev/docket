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

## Proofs

`messages/messages.test.ts` (the fence on each read, health's rows, the
push), `held.test.ts` (held, Away, once on two presses, no thread's press,
no grant, stale and not sent), `tools.test.ts` (who is offered chat, the
read tool's fence, the draft row, his presses), `mentions.test.ts` (`@`,
the chip's line, the tells). Nothing here has run against the live LifeOS.
