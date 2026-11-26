# Away from computer: threads finish without the person

- The state is the person's, one copy per host, and has two switches: Code
  threads and Work threads, each on or off by itself (none, Code only, Work
  only, both). It is `{ enabled, code, work, at, by }` and the stretch's
  tally of decisions per thread in the settings table (`away`,
  `away:decided`; src/main/server/away.ts `AwayService`, src/shared/away.ts).
  `enabled` is true only while both kinds are away: it is what a window, a
  phone or a peer one release behind reads. `away.get` (read), `away.set`
  (approve: `{ code?, work? }` sets each kind named and leaves the other;
  `{ enabled }` alone, an older client's, sets both), `away.apply` (admin,
  the peer leg) and the `away` push (src/shared/contract-away.ts). A row an
  older build wrote, or an older peer's state, has `enabled` alone and reads
  as both kinds at that value: a host that was away is away for both, off is
  off for both. Each kind keeps its own stamp (`codeAt`, `workAt`) and a
  peer's state merges kind by kind, newest wins (`mergeAway`), so a flip of
  one kind on one host never brings back a stale value of the other. The
  tally's stretch runs while any kind is away: the first kind on starts it,
  the last one off ends it. No home host: the Mac sends a
  flip to every link, applies the box's push when newer and never sends it
  back, and link-up settles both ways, newest wins
  (remote/awaySync.ts; docs/box.md "Away from computer: one state on every
  host"). Only a person turns it off.
- **Each thread by its own kind.** A thread's kind is its row's scope
  (`sessions.scope`, stamped once at create: a Work workspace's thread, a
  Work Chat and anything a Work thread starts are `work`; every other thread
  is Code; `awayKindOf` in src/shared/away.ts). Everything below asks "is
  THIS thread away", its kind's switch alone: `SessionRegistry.awayFor`
  (sessions.ts), `awayNow(session)` (orchestration.ts, the spawn's
  mechanics), the Mac bridge by the calling box thread's `scope`
  (macBridge.ts `awayOn(thread)`, macJobs.ts, macComputer.ts `st.kind`), the
  computer session tier per thread (`SessionScheduler` `awayOn(threadId)`),
  and a Work scope's `away` (work/scope.ts: the Work switch). A flip tells
  only threads of the kind that changed, and answers only that kind's
  waiting cards (`awayChanged(kinds)` on the registry and the Mac bridge).
  Away for Code never makes a Work thread's ask go unasked, nor the reverse.
- Readers with no thread in hand take "both must be on", the reading that
  never answers for him where one kind still asks: `awayFor` of an id this
  host holds no row for; `MacComputer.awayFor` of a key with no call yet; a
  Mac card that names no kind at the flip. An old client's `away.get` reads
  `enabled`, the same "both". The return toast and the review read the
  stretch: they come when the last kind turns off.
- The words (src/main/server/awayPrompts.ts): `AWAY_MECHANICS` rides every
  prompt beside the steer rule (claude's system prompt through
  `mechanicsFor`, other harnesses' first message through threads.ts), with
  the `<away state="on">` block while away is on at spawn. The registry
  keeps what each live harness was told (`awayToldAs`): a flip whispers the
  block into every running or waiting turn (`awayChanged`), every other
  thread catches up ahead of its next turn (`takeNotices`: a send, the turn
  pass, a reports wake), so on and off again while idle tells it nothing.
  A master's report gathers its batch's decisions.
- The host backs the prompt up (sessions.ts `interceptAway`,
  `requestApproval`, in the emit path): while away, a question is answered
  with `AWAY_QUESTION_REPLY` as each question's typed answer and every
  approval is ALLOWED (since 2026-11-10; before, every one was denied):
  tool cards in safe and edits, the add-on and skill cards (`addon_add`
  too: the host stands in for the admin), every computer card and the
  session step's card (Run now). One kind is still denied: a computer act
  the model flagged `pay` or `subscribe` (`awayVerdict`,
  `AWAY_DENIED_KINDS` in src/shared/away.ts, read off the call's own
  `confirm`, never a card's input; computer/run.ts raises that card with
  `ApprovalRequest.awayDenies`), with `AWAY_APPROVAL_REPLY`. An allow
  remembers nothing (no bridge rule, no Skip). The request's row, its
  `waiting` and its resolved row are never written, so nothing reads Needs
  you and the notifier stays quiet; a driver with no resolver yet gets the
  card as usual after one retry. Turning away on answers the cards already
  waiting the same way (`Store.unresolvedRequests`, the newest rows only;
  the registry keeps each pending card's `awayDenies`). The Mac decides
  its own calls by its own Away state: a bridge read (secret paths too),
  command, job or write that would ask is allowed at once, quiet, and
  marked on its reply (`ctx.markAway` → `peer.reply { away: true }`,
  `PeerCalls.call`'s `onAway`), its prompts waiting at the flip decided by
  `MacBridge.awayChanged`; a box thread's computer call is allowed and
  says `away` in its answer, or refused with `MAC_AWAY_REFUSAL` when it
  spends money. The box writes the row (macTools.ts `awayAware`,
  computer/bridge.ts), and words a Mac on the older build's refusal
  (`MAC_AWAY_REFUSAL_LEGACY`) as a skipped row. Each of these, and each
  `note_decision` call (an app tool on every thread, `app.noteDecision`
  over the codex bridge; the same decision again in one away stretch
  answers "already noted" and writes no second row, `awayNotice`), is one
  `notice` of kind `away`
  (`away: { kind: decision | question | allowed | approval, text }`;
  `approval` is a denial, "Skipped while away", `allowed` "Allowed while
  away", drawn with the open lock) that counts toward the tally.
- The app: the rail foot's Away row above Settings (chrome/AwayRow.tsx, a
  switch on lib/away.ts, its track from components/ui/switch-track.ts). Its
  press flips the kind of the place the window is on (Code in a code place,
  Work in a Work place, lib/placeScheme.ts `onPlaceKind`), its track shows
  that kind, and its label names the kinds away in words ("Away for Code",
  "Away for Work", "Away for both", or "Away" while none is: the switch
  keeps the name "Away from computer", cut at the rail's default width). Its context menu (right-click, the menu key) holds "Code
  threads" and "Work threads" with their ticks, then Both and Off. While no
  host has Work on, the row is Code's alone and has no menu: nothing sets
  Work by implication, since a Work thread keeps its scope when Work goes
  off. A flip names only the kinds it changes (`setAway`), so a window that
  missed another's flip never sets the other kind back; `enabled` rides
  along for an older host and a current one reads it only when no kind is
  named (`flipKinds`). `setAway` answers whether the host saved the flip;
  a refusal puts the row back with the toast "Couldn't change Away", which
  `{ quiet: true }` leaves to a page that shows its own line. Every Mac call a Work thread makes says `scope:
  'work'`, its background jobs' too (macTools.ts). Threads → Away for Code Threads and Away for
  Work Threads (checkbox rows, `MenuState.checked`; the Work row is
  `workOnly`), the away notice line folded into the run, and on the way
  back one toast "Decided without you in N threads" with Review
  (chrome/AwayReturn.tsx, AwayReviewDialog in the dialogs chunk). The phone
  has Away for Code and Away for Work in its host menu, each with its
  tally by the thread's scope (`AwayKinds`, `away.set {code}` or
  `{work}`); a host one release behind gets one switch that sets both
  (`{enabled}`). Its stretch runs while any kind is on.
- Proof: `bun run script:e2e-away` (a haiku thread asks a question while
  away and finishes without a card; a safe-mode haiku thread's Bash write
  is allowed with no card; a flip off reaches a running turn); unit tests
  away, awaySync, sessions-away, macBridge, macBridgeWrite, macJobs,
  macTools, peerCalls, macComputer, computer/bridge, approval, schedule,
  the drivers' allows and denials, AwayRow.dom, AwayReturn.dom; by kind,
  each direction: away (four states, migration, the old wire),
  sessions-away "Away by kind", macBridge, macComputer, schedule, lib/away,
  nativeMenuState, menuTree. The window proof: `bun scripts/e2e-away-by-kind.ts`
  (.temp-code/plans/landed/F-away-by-kind.md).
- **A Work thread** (docs/agents/work-outbox.md) decides and carries on,
  and nothing it does leaves. `awayVerdict(ask, scope)` (src/shared/away.ts)
  answers by the scope of the thread that asks: a code thread as above; a
  Work thread's `addon_add` and `addon_remove` cards are denied
  (`awayAllows` in sessions.ts, at `requestApproval`, `interceptAway` and
  the flip's `answerWaitingCards`), its computer act the host reads as
  outward or the model flagged is held for the owner's press and asks no
  card, and text into a password field is denied. Away never releases a
  held act and never makes a grant: neither is a card. Away, by whichever
  kind is on, never answers an Outbox request (a thread's `outbox_request`,
  docs/agents/work-outbox.md "A thread asks for his press"): it is his
  press, not a card, so `interceptAway`, `answerWaitingCards` and
  `awayVerdict` never see it, and it stays open until he answers it or its
  day runs out. On the Mac bridge a
  Work thread's command on its floor (`workFloor`: the always-ask list,
  save an `osascript` that drives only local apps) stays a prompt, under
  Away and at the flip (`workMustAsk`, `awayKeeps`).
