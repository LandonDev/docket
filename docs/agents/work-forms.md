# Work: forms

A form in a Work thread's canvas: questions, then the answers people send
from a public page. Milestone 36 built it; the approved page is
`.temp-code/prototypes/work-workspaces-2/form.html` (its pick, "Questions,
then Responses"), and docs/DESIGN.md "Form" holds the look.

## What a form is

- **A row behind a canvas item.** The item's source is `{ at: 'thread' }`;
  the form lives in `work_forms` (forms/store.ts), keyed by the item id: the
  title, the line under it and the questions (`FormBody`), the state
  (`draft`, `open`, `closed`), the mode, the agent's waiting changes, the
  public id, the held publish and the responses sheet. `rev` moves on every
  change to the form itself.
- **Questions** are `short`, `long`, `choice`, `dropdown` or `section` (a
  heading that takes no answer), each with an id that never changes, a label,
  `required`, and options for a choice or a dropdown. At most 100 questions
  and 50 options each.
- **Answers live in a sheet.** On the first publish the host makes one: a
  LifeOS sheet in the workspace's sector when this host serves LifeOS's
  sheets, else a `.tcsheet` under `<userData>/work-forms/<itemId>/`. Row 1
  is the header: column A is `Submitted` (the host's local time,
  `2026-11-19 14:06`), then one column per question in the order they were
  first published. A question added later gets a new column at the end; a
  removed question keeps its column. The canvas reads the answers back from
  the sheet (`work.forms.responses`, at most the 2,000 newest).

## Publishing is held

Publishing shares a link anyone can answer, so it is an outward act:

- `form_publish` (a thread) and `work.forms.publish` (the canvas) hold a
  `form.publish` act through `ctx.held.create` with `{itemId, title, rev,
  questions}`. It takes no grant: every one waits for the owner's press.
  Away releases none.
- The press is `work.outbox.send` on the held row; the canvas's Publish is
  that press (it holds the act, then sends it). It runs `publish`
  (forms/forms.ts): a form whose `rev` moved since it was held is not
  published (the row reads stale and he publishes again), else the sheet is
  made on the first publish, the header written, a public id given
  (`randomBytes(12)`, base64url, 16 characters) and the page goes live.
- Once a form is published, an agent's change always waits for his Accept,
  whatever the mode, so nothing reaches the public page without him. Before
  that, the mode decides ("Agent suggests", the default, or "Agent writes").
  His own edits go live at once.
- **His close and reopen are not held**: they stop or restart answers on
  his own form (`work.forms.close {itemId, open}`). An agent's close
  (`form_close` with `open: false`) runs at once; its reopen shares the link
  again, so it is held as `form.publish` like the first. Answers already in
  stay. A held publish carries the form in words (`content`: the
  description, each question with its kind and options), which the Outbox
  shows.

## The page

The Work service serves it (`service/routes/form.ts`; the route list is in
[work-service.md](work-service.md)):

| Request | Answer |
|---|---|
| `GET /f/<publicId>` | the page, `out/hosted/form/index.html` with the hosted CSP |
| `GET /f/<publicId>/form` | `{title, description, questions, open}` |
| `POST /f/<publicId>` | `{answers: {<question id>: text}}` as JSON → 201, or 400 naming the question, 410 closed, 413, 415, 429 |

- The service opens no database. Main writes what it serves into the
  service's own folder: `<userData>/work-service/forms/<publicId>.json`
  (`writeCopy`, written whole and renamed into place) at publish, at every
  change the owner makes to a published form, at close and reopen, and again
  for every published form when Work turns on. The route reads it on every
  request, so a close stops answers on the next one. A thread's deletion
  removes it.
- An answer is checked against the questions (required ones present, a
  choice one of its options, 500 characters for a short answer and 5,000 for
  a long one; anything else is dropped), then written as the next row of the
  sheet through the service's sheet host in process (`hostOf(ctx).cells`),
  then noted in `forms/<publicId>.answers.jsonl` (row and time only), whose
  length is the row count. Answers to one form are written one after
  another.
- Each caller may send one form ten answers in ten minutes, counted by the
  tunnel's `CF-Connecting-IP`, and a form takes at most 600 in ten minutes in
  all. A body is at most 64 KiB.
- The page (`src/hosted/form/`) is plain DOM with no framework: it builds
  every word with `textContent`, sends no cookies, and draws the canvas's
  Questions half as a filler sees it in both themes.
- **The link.** `linkOf` (forms/forms.ts): `https://tempcode.landonhale.com/f/<id>`
  on the box's installed host, the one behind the tunnel; the service's local
  address on any other host or an isolated instance;
  `TEMP_CODE_WORK_PUBLIC_ORIGIN` overrides both (a proof's quick tunnel).
  The tunnel rule for `/f/` is written but not applied (the owner's step,
  [work-service.md](work-service.md) "The tunnel").

## The canvas

`src/renderer/src/work/forms/`: the kind's body is its own chunk
(`FormCanvas.tsx`); `canvas.ts` rides the canvas chunk.

- **The bar**: the mode, then Questions and Responses as a 24px segmented
  switch, then at the end the stepper while changes wait, Publish while it is
  a draft, else the live link in accent with Copy and Close form. A closed
  form draws one line under the bar ("Closed 12:00 PM") with Reopen.
- **Questions** is the form as a filler sees it. The title, the line under
  it and every question are edited where they stand (a click shows the
  label as a field, the options as fields, and a row with the type, Required
  and Delete); edits are saved half a second after the last keystroke with
  the rev he edited. An agent's waiting change is tinted where it would land:
  an added question with `add-bg`, a removed one with `del-bg`, a changed
  label struck and rewritten, a choice's dropped and added options. A form
  with three or more sections gets a jump list from 640px of canvas.
- **Responses** is one summary line, the bars of the form's first choice or
  dropdown (`chart-neutral`), and a flat table, newest first, the time last.
  Picked rows feed Ask, which takes them to the thread as text. It is read
  every 10 s while shown, and only when the sheet's rev moved.
- More holds "Open responses as a sheet".

## The tools

- `form_create {title, description?, questions}`: makes the form and opens
  it in the pane.
- `form_read {item}`: the questions with their ids, its state and link, what
  waits, and the newest 50 answers; the sheet's place for `sheet_read`.
- `form_edit {item, changes: [{op: add|change|remove, …}], reason?}`: a
  suggestion once published or in "Agent suggests", else written with the
  written line.
- `form_publish {item}`: holds the publish.
- `form_close {item, open}`: closes or reopens.

## Methods

`work.forms.{open, save, review, mode, publish, close, responses}` and the
`work.forms` push (`src/shared/contract-work-forms.ts`). Every method but
`open` and `responses` is the owner's: a thread's call is refused. Each is
carried on a relayed lane (`FORMS_RELAY` is empty: work.md "The relay").

## Known limits

- The page is reachable from outside only on the host behind the tunnel,
  and only once the owner applies the rule.
- The row counter assumes nobody else writes rows into the responses sheet:
  rows the owner inserts or sorts there can be written over by the next
  answer.
- Reading a portal or a PDF into a form is not built: those fills stay in
  the browser (M37) and PDF (M33) canvases, which show each value's source.
- The phone draws the form through the web (`phone: 'web'`); nothing
  native is built.
