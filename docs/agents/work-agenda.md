# Work: agenda and calendar

A linked Work workspace's Agenda view, the held calendar act's own view in the Outbox, and plain holds as Results (milestone 25). LifeOS's `calendarOps` are milestone 24's (`landed/M24.md`).

## The view

`src/renderer/src/work/agenda/AgendaView.tsx`, a lazy chunk from `agenda/view.ts`: the sector's next 14 days by day through the shared agenda client (`useEvents(from, to)` on `events:range` with the sector), each event at its time with where it is and when to leave. Prepare starts a thread about the event (`{kind: 'event', …, ref: {at: 'lifeos', table: 'events', id}}`).

## `calendar.op` in the Outbox

The kind is held and sent by the hold (`work/outbox/lifeosHeld.ts`): the watcher reads `calendarOps:held {host}`, and the words come from the act's kind, payload and the event's title (read once per event with `events:get`). At the press the act is read again (`calendarOps:get`): a draft or failed act goes with `calendarOps:send {id, cause}`; one edited since it was shown goes stale; one already queued, sending or done is not sent twice. Edit is `calendarOps:save` with the act's own kind and event (and, for a new Google event, the source of the same account's calendar). A grant (`CalendarOpMatcherSchema`) fits one kind on one account's one calendar: an invitation's answer, or an invite that names its people. A change, a cancel, a proposal, a series or an uninvite is always his press.

Its view (`agenda/CalendarActView.tsx`, chunk `work-calendar-act`) shows every field that goes (`opFields` in `agenda/calendarAct.ts`; a server test holds each `CalendarFieldsSchema` key to a row), then that day's calendar, every sector's, read as the owner, with the act's slot set apart.

## Plain holds

A create on his own calendar that invites no one runs at once in LifeOS (`plain: true`) and is never held. `agenda/index.ts` watches `calendarOps:list {limit: 50}` and records each one this host's live threads made as a Result of its thread, once it is `done`, once (`work_agenda_results`), and only for acts made since the host first watched.
