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
| The outgoing HTML rules | `src/main/server/work/mail/outgoing.ts` |
| The live proof (not shipped) | `src/main/server/work/mail/proof/live.ts` |
| The client with Send through the host, and TempCode's `MailKit` | `src/renderer/src/work/mail/kit.tsx` |
| The Mail view and its header (Start thread, Compose) | `MailView.tsx`, `view.ts` |
| The mail kind: a draft beside its thread, a waiting rewrite | `MailCanvas.tsx`, `canvas.ts`, `proposal.ts` |
| A held mail in the Outbox | `MailAct.tsx`, `act.ts`, `model.ts` |
| Type steps and the menu wash | `mail.css` |

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
and no other. The header carries Start thread for the open mail (a
`mail` chip, `{at: 'lifeos', table: 'mailThreads', id}`; the first send
links the thread to the mail) and Compose. Where it was, which mail was
open and the composer stay per workspace while the window lives.

TempCode's kit: toasts through its own stack (Undo where the write has
one), initials faces, a sector mark by name and never a bare row dot (the
screens hold one sector), its key hints, its theme. `mail.css` sets the
shared screens on TempCode's scale (subject 16/24, rows and fields 13/20,
labels 12/16) and the menus' highlight to the muted fill through
work-kit's `--ui-wash` (`HOST_WASH` in `work-kit/ui/host-rules`).

## The Outbox

`mail.send`'s own view: From, To, Cc, Bcc, Subject, then the words as
plain text exactly as they go, the files, and one muted line when a
rewrite waits (it is taken or left beside the thread, never here).

## Proving it

`env -u ELECTRON_RUN_AS_NODE bun src/main/server/work/mail/proof/live.ts <0600 token file> <shots dir>`
from the worktree after `electron-vite build`, with a token minted by
`sudo lifeos-deploy run <lifeos checkout> auth:mint '{"ownerId":"landon","name":"<name>"}'`.
Without `M23_SEND=1` it stops before Send and discards the draft. It
retires every key it made and signs out; the token is spent after one run.
