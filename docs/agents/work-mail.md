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

**Undo for a held draft is a wait in the window.** The hold has no queue to
pull a mail back from, so for a draft that goes through it the composer
(work-kit, `kit.holdsSend`) saves the draft as he sees it, shows "Sending
to …" with a bar and Undo for the undo time from Mail's settings, and only
when that time runs out calls `work.mail.send {…, waited: true}`, with
`seen` as he pressed on it. Nothing has gone while it waits: Undo cancels
the timer, and a window that closes takes the timer with it, so the draft
stays held. `waited` marks the draft for that one call into the hold
(`waited.ts`), and the hold's `mail.send` passes `immediate: true` to
`compose:send` only for an owner's press that carries the mark, so LifeOS
does not queue the mail a second time. Nothing on the Outbox's own wire
carries it: a send from the Outbox page, by a grant or from the phone keeps
LifeOS's queue and its Undo, and LifeOS refuses `immediate` with `cause:
'grant'`. A held draft has no Send later.

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

## Pictures, and what the page may reach

A mail frame never touches the network (work-kit's `prepareMail`: every
outside address is taken out of a body, and the frame's own policy is
`default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:`). The
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
that would let any transcript or page load a picture from anywhere.

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
and a real click inside a mail reach the page); `--policy <index.html>`
runs it under another app's policy (LifeOS desktop's). `--shots <dir>`
writes the review shots: every scene in `preview/scenes.ts`, dark and
light, at 1280 and 640 wide. The box's sans is DejaVu, so the shots use
Selawik as the stand-in for the system face.

The live proof against LifeOS:

`env -u ELECTRON_RUN_AS_NODE bun src/main/server/work/mail/proof/live.ts <0600 token file> <shots dir>`
from the worktree after `electron-vite build`, with a token minted by
`sudo lifeos-deploy run <lifeos checkout> auth:mint '{"ownerId":"landon","name":"<name>"}'`.
Without `M23_SEND=1` it stops before Send and discards the draft. It
retires every key it made and signs out; the token is spent after one run.
