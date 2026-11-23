# Meeting prep and follow-up

Prep keeps one page per LifeOS event in a Work workspace linked to a sector. The host reads the event, attendees, newest mail with each person, open tasks, files and the previous meeting in the series. Page reads write nothing. All event reads and writes check the workspace’s sector before using the host’s LifeOS connection.

## Host methods

| Method | Capability | What it does |
| --- | --- | --- |
| `work.prep.page` | read | Reads the page, its state and its revision |
| `work.prep.upcoming` | read | Lists up to 31 days of timed meetings with other people in linked workspaces on this host |
| `work.prep.people` | operate | Keeps the added people for the meeting series |
| `work.prep.brief` | operate | Starts a Work thread with the meeting’s facts and an event link |
| `work.prep.notes` | operate | Keeps the owner’s trimmed notes. Empty text clears them |
| `work.prep.followUp` | operate | Starts a linked Work thread once the owner has kept notes |
| `work.prep.decide` | approve | Accepts or rejects named proposed tasks. Reports any filings LifeOS refused |
| `work.prep.ahead` | read, admin to set | Reads or changes the workspace’s Prepare-ahead switch |

A thread cannot call the owner’s write methods. The brief and follow-up methods return the same thread for 20 minutes after it starts if it has yet to write. A page survives its threads and goes with its workspace. Each page write pushes `work.prep` with the workspace ID, event ID and revision.

## Work tools

Linked Work threads get `prep_read`, `prep_write`, `prep_today` and `prep_follow_up`. The event tools take an event ID or use the newest event linked to the thread. `prep_write` replaces the brief and can add people and web links. `prep_follow_up` replaces the outcome and proposes tasks. It keeps filed tasks and any prior rejection matched by title. Suggestion IDs stay unique across rewrites. The stored outcome can hold up to 20 tasks, including filed tasks carried forward.

An administrator can turn on Prepare ahead outside Purdue. The switch saves one routine for 7 a.m. daily in the selected time zone or the host’s time zone. Turning it off pauses the routine. Turning it back on resumes it with its saved schedule. Its thread uses `prep_today` to find up to eight meetings in its workspace that start within 16 hours and have other people and no brief. The switch makes no grant.

## The owner’s press

A task waits for an acceptance before the host files it in LifeOS in the workspace’s sector. The page row and suggestion ID form the key so a retry can recover the same task. The host records a result in the follow-up thread if it still exists.

The follow-up prompt asks for one draft through `draft_mail`. The meeting’s page shows waiting drafts from the follow-up thread in its own sector, plus drafts with no sector set. Sending, editing and discarding happen in the Outbox. Prep declares no act kind.

The host code lives in `src/main/server/work/prep/`. The wire is `src/shared/contract-work-prep.ts`.
