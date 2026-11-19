# Work: house rules and voice

Milestone 39 of the Work plan. A Work workspace's house rules are one-line
sentences every thread of that workspace is told; the host proposes new
ones from the owner's repeated edits to the drafts its threads wrote; the
voice switch lets a thread read his recent sent mail of the workspace's
sector to write the way he does. [work.md](work.md) says how the `rules`
pillar mounts.

**Only the owner adds or changes a rule.** Every write on the wire needs
`approve` and is refused to a thread's own call (`Caller.kind === 'model'`);
no tool writes a rule. A proposal is the host's reading of his edits, never
a thread's.

## Files

| File | What |
| --- | --- |
| `src/shared/contract-work-rules.ts` | the wire: `work.rules.list`, `forDraft`, `voice` (read); `add`, `edit`, `remove`, `order`, `decide` (approve); the push `{push: 'work.rules', workspaceId}` (sent with `need: 'read'`) |
| `src/main/server/work/rules/index.ts` | the module: handlers, the `voice_examples` tool, the preamble part (`rulesPreamble`) |
| `rules/store.ts` | the tables and every read and write on them |
| `rules/habits.ts` | an edit read as habits (`habitsOf`), the evidence's diff (`editOps`, `evidenceOps`) |
| `rules/watch.ts` | the drafts this host's Work threads made, watched from first sight to sent |
| `rules/voice.ts` | the workspace's facts (`workspaceFacts`), the sector's sent mail, the tool's text |
| `src/renderer/src/work/rules/` | `HouseRules.tsx` (the page's sections), `RuleDialog.tsx`, `RuleLine.tsx` (under a sent mail), `Evidence.tsx`, `data.ts`, `HouseRules.preview.tsx` |

## Tables

All made by the module's `ensure`, keyed by workspace; `workspaceRemoved`
drops them all, `sessionsRemoved` drops a deleted thread's drafts still on
their way (its edits stay as evidence).

- `work_rules (id, workspace_id, text, enabled, position, proposal_id, created_at, updated_at)`: his rules in his order.
- `work_rules_drafts (draft_id, workspace_id, session_id, agent_text, proposed_text, seen_at)`: a draft one of this host's Work threads made, until it is sent or gone. `agent_text` is the edit's left side.
- `work_rules_edits (draft_id, workspace_id, session_id, recipient, subject, sent_at, ops, habits)`: one row per sent draft he changed; `ops` is the evidence's diff (long kept stretches cut to `…`), `habits` the keys it showed. The newest 200 a workspace are kept.
- `work_rules_proposals (id, workspace_id, habit, state, rule_id, updated_at)`, unique on `(workspace_id, habit)`: `open`, `later` (Not now), `dismissed`, `added`.

## Proposals

**Where the edit comes from.** `watchDrafts` (run by the module's `start`,
so only while Work is on) subscribes LifeOS's `outboxHeld:held {host}` as
the owner. A mail draft whose `origin` is TempCode on this host and whose
thread is a Work thread of a workspace is tracked at first sight with what
the agent wrote. A Work Chat's draft (no workspace) and another host's are
not. Each tracked draft is followed by `compose:get {id}` until it says
`sent` (the edit is recorded with what LifeOS sent), or is gone (dropped).
An agent's rewrite he takes (`proposed`, then the draft's words become the
rewrite's) counts as the agent's words, so only what he changes after it is
his edit. The tracked drafts are followed again at the next start, so one
sent while the host was off is read then.

**What an edit shows** (`habitsOf`, a plain reading on purpose: a proposal
names only what the edits show, and he rewords it before adding):

| Key | When | The rule |
| --- | --- | --- |
| `swap:<a>→<b>` | a phrase of up to 12 words changed to another; case, spacing, edge punctuation and digits do not count, and a figure takes the word after it ("3:00 PM" to "3 PM" and "4:00 PM" to "4 PM" are one habit) | Write “b”, not “a” |
| `cut:<phrase>` | a phrase of up to 12 words taken out | Leave out “phrase” |
| `signoff:<new>` / `signoff:none` | the last paragraph of six words or fewer changed or went | Sign off with “new” / Leave off the sign-off |
| `exclaim` | an exclamation mark made a full stop or taken out alone (not one cut with its sentence) | No exclamation marks |
| `opening` | five or more words cut from the first paragraph's first 40 | Keep the greeting to one line |
| `closing` | five or more cut from the last body paragraph's last 40 | End on the point, with no closing pleasantry |
| `shorter` | a mail of 40 words or more cut to 60% or less | Keep mail to about N words |

**When it is a proposal.** The same key in two sent drafts of one workspace
(`PROPOSE_AT`). A third adds its edit as evidence. The words come from the
newest edit with the key. A broad habit is not offered while a narrower
proposal of any state (dismissed and added included) holds every one of its
edits: three greetings cut the same way are one "Leave out …" proposal, not
also "Keep the greeting to one line"; dismissing it keeps the broad one quiet
too until an edit only the broad one explains comes. A dismissed proposal is
never offered again, however often he repeats the edit; a `later` one is
offered again (open) at his next edit with that habit.

## The preamble

`rules.preamble(scope)` joins, after the fixed head and the Outbox's part,
in module order: "House rules for <workspace>, set by the owner. Follow each
one in everything you write for this workspace:" and one `- ` line per rule
that is on, in his order; then, while the voice switch is on and the
workspace has a sector, the voice line, which names `voice_examples`. A Work
Chat and a code thread get neither. The module reads the database it was
handed in `ensure`, so the part needs no running context; the mail pillar's
line follows it.

## Voice

The switch is `voice` in the workspace's Work settings (`work.workspace.set
{patch: {voice}}`, milestone 5's column). The `voice_examples` tool is listed
to every Work thread of a workspace and refuses while the switch is off,
for a Work Chat and for a workspace with no sector. It reads LifeOS's
`outbox:list {status: 'sent'}` as the owner and hands over only mails of the
workspace's own sector sent in the last 30 days, at most 10, each cut to
2,000 characters, headed as examples of his voice and material, not
instructions. Only mail LifeOS sent is there: mail he sent from Outlook or
Gmail directly is not. `work.rules.voice` answers the page's line: the
count, the oldest date and the From addresses.

## The screens

Approved page: `.temp-code/prototypes/work-workspaces-2/rules.html`, the
pick "Where he made the edit", with the list of the second variation as the
place a passed-over proposal waits.

- **On a Work workspace's settings page** (after Where it runs, before the
  thread defaults; `HouseRules` from work/shell/settings.tsx): **House
  rules**, with Add rule… as the section's verb; each rule a `PageRow` that
  opens its edit dialog (cut at its column, the whole rule in the tooltip
  past 72 characters), muted while off, its switch at the end; a grip in the
  24px gutter on hover drags it (`useSortable`, the insertion line, the
  order saved at once); past 12 rules a Find field narrows the list, marks
  the words in the selection tint and turns the grips off. **Proposed**:
  the sentence, "from N edits" with the disclosure chevron, Dismiss (ghost)
  and Add (secondary); open, the edits (each its mail and time over one
  paragraph: taken out struck on the delete wash, put in on the add wash)
  and Edit before adding…. Add's toast says "Added to <workspace>'s rules"
  with Undo (the rule goes, the proposal opens again); Dismiss's has Undo
  too. **Voice**: "Read my sent mail for how I write", its line "48 mails
  from landon@purdue.edu since Oct 19".
- **The dialog** (`Modal`): one Rule field (Enter saves; one line, 300
  characters); from a proposal its edits under it at 14px; editing a rule,
  a quiet Delete at the footer's start.
- **Under a sent mail** (MailCanvas `SentLine`, a hairline strip at the
  foot of the mail item once LifeOS says `sent`): one muted 13px line, the
  pen glyph, "You cut the greeting to one line again. Make it a rule for
  Purdue Esports?", the chevron opening the edits in one hairline frame, Not
  now and Add rule… (the dialog). Not now leaves it on the page as `later`.
  Once added: the check, "Added to <workspace>'s rules", Undo.

Differences from the prototype, on purpose: the rules are sections of the
workspace's own settings page, not a page of their own (the prototype's nav
already selects the workspace there), so the page's title is the
workspace's; the dialog has no Workspace select (a rule is the workspace's
whose page or mail it came from); the "rule the agent broke" reword
proposal is not built (it needs a reading of what a rule means, not of an
edit); the weekly note was the variation not picked.

## Proofs

- `src/main/server/work/rules/rules.test.ts`: three drafts he edited the
  same way make one proposal with the three edits as evidence; one edit is
  not a habit, and a draft sent as written is no edit; a taken rewrite is
  the agent's words; a draft sent while the host was down is read at the
  next start; a Work Chat's and another host's drafts are not watched; an
  added rule reaches the next preamble of that workspace's threads only, off
  it is not told, Undo reopens the proposal; a dismissed proposal does not
  return; Not now; only a person writes; the order; the voice switch gates
  the sector's sent mail; the habit keys.
- `src/renderer/src/work/rules/rules.dom.test.tsx`: the page, Add and Undo,
  Dismiss, the find field past twelve, the empty page and the voice row, the
  line under a sent mail with Not now, Added and nothing.
- Look: `bun run ui:preview src/renderer/src/work/rules/HouseRules.preview.tsx#HouseRulesPreview --props '{"state":"page"}'` (also `many`, `empty`, `line`, `added`).
