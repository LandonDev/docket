# Templates per job

A new document, sheet or deck starts from one of his own. Each Work workspace has a shelf: his templates for that job, our starters for that job, and a group that follows him across jobs. Pillar `templates` (plan `.temp-code/plan-jcTUPnk4t-9Y.md`, round 3's row 5; landing note `.temp-code/plans/landed/R3-templates.md`).

Its folders: `src/main/server/work/templates/`, `src/renderer/src/work/templates/`, `src/shared/work/templates.ts`, `src/shared/contract-work-templates.ts`, `resources/work-templates/`, `scripts/build-work-templates.ts`. Another pillar may import two files: `templates/api.ts` on the host and the renderer's `templates/open.ts`.

## What a template is

A template is an ordinary file of a kind. Editing one is opening its file, and it gains every editor feature as that lands.

| Group on the shelf | Where the files are | Who may change them |
|---|---|---|
| The job's own | `<workspace folder>/Templates/`, top level only | him, in the shelf or in Files |
| All jobs | `<userData>/work-templates/shared/` on the workspace's host | him, in the shelf |
| Starters | `resources/work-templates/<sector>/` and `/any/`, shipped read-only | nobody; Hide per workspace, "Edit a copy" makes his own |

- Forms: `docx`, `xlsx`, `pptx`, `tcdoc`, `tcsheet` (`TEMPLATE_FORMS`, `templateFormOf`). The kind is the form's: document, sheet or deck.
- The name is the file's name without its extension. The id is `job:<file name>`, `all:<file name>` or `starter:<sector>/<slug>`; a starter's slug is `starterSlug(name)`, so its file is `<sector>/<Name>.<ext>` and its key `<sector>/<slug>` (`unify/invoice`, `any/meeting-notes`).
- A workspace's sector (`workspaces.sector`) picks its starters. A workspace with no sector gets `any` alone.
- The groups for all jobs do not sync between hosts: each host keeps its own.
- A dot file, Office's lock file (`~$…`), a folder and a file of any other kind are not templates.

## The shelf (`shelf.ts`, `store.ts`)

`shelfOf(ctx, workspaceId)` reads the three folders at every ask, one `stat` a file. There is no watcher. `work_templates_index (path, size, mtime, fields)` keeps each file's fields, so a file is opened only when its size or time changed; a row whose file left its folder is dropped at the next read. `work_templates_hidden (workspace_id, starter)` keeps the starters he hid in a workspace; `workspaceRemoved` drops them.

The shelf's order: the job's own by name, the job's starters, all jobs' own, then the starters for every job. The window draws two groups from it: the workspace's name (his own and the sector's starters) and "All jobs" (`where: 'all'` and `starter:any/…`).

`startersRoot()` is `resources/work-templates` under `appRoot()`: the checkout in a dev tree, the build's folder on the box, the app's own folder in a packed app (the app is packed with `asar: false`, so the files are plain files there). `TEMP_CODE_WORK_TEMPLATES` names another folder; a test uses `setStartersRoot`.

`resolveTemplate(ctx, workspaceId, ref)` takes an id, a starter's key, or a name. By name it looks in the job's own, then all jobs', then the job's starters, then every job's; names match without case. So a template he saved as "Meeting notes" takes ours' place for every caller. A starter he hid is still found by a caller that names it. A starter of another sector is found by its id or key (Money in a job with no sector asks for `unify/invoice`).

`registerStarterTemplates(kind, entries)` puts an editor's own starter files in the All jobs group. It is the file's own state, so a pillar may call it when it loads, before or after this module starts. One with the name of one of ours takes ours' place and its key, and is shown once.

## Fields (`src/shared/work/templates.ts`)

A field is `{{Client}}` typed in the file's text: two braces, a name of 1 to 40 letters, digits and spaces, two braces. Names match without case, and outer spaces do not count (`fieldKey`).

| Field | Filled with | Asked |
|---|---|---|
| `{{Date}}` | the caller's day in the long form ("November 23, 2026"); in a sheet, a cell that holds only `{{Date}}` and wears a date format becomes a true date and keeps that format | never |
| `{{Name}}` | the setting `work.ownerName` | never |
| `{{Job}}` | the workspace's name | never |
| any other name | what he types, or what a caller passes | in the dialog, in the file's order, each name once |

- The window sends its own day (`today: YYYY-MM-DD`). A tool, and a caller that sends none, gets the host's own day. A caller may pass `Date`, `Name` or `Job` in `fields`; its value wins, and a `Date` given in words is written as words in a date cell too.
- A field with no value stays in the file as written (`LEAVE_UNFILLED`; flip it and the field is taken out). `{{Name}}` stays when LifeOS has not given the host his name.
- A lone `{{Date}}` cell in a format that shows no date gets the day in words: a bare number would say 46349.
- `Template.fields` holds only the fields the dialog asks for.

## The fill (`ooxml.ts`, `zip.ts`, `deckFill.ts`)

The fill always runs on a scratch copy.

| Form | Parts read | A paragraph is | Text is | Filled by |
|---|---|---|---|---|
| docx | `word/document.xml`, headers, footers, footnotes, endnotes | `w:p` | `w:t` | `fillOffice` |
| xlsx | `xl/sharedStrings.xml`, inline strings in `xl/worksheets/*.xml`, the page header and footer | `si` or `is` | `t` | `fillOffice` |
| pptx | `ppt/slides/*.xml`, in the deck's order | `a:p` | `a:t` | the slides pillar (`fillDeck`); `scanOffice` only reads a deck |

- Word and PowerPoint split a typed `{{Client}}` over runs. The scan joins the text runs of a paragraph and finds fields in the joined text. A run belongs to the innermost paragraph around it, so a text box inside a paragraph is its own.
- The Word and Excel fill writes a value into the run where its field starts and empties the rest of that field's runs. Every run stays, with its formatting. A filled run that starts or ends with a space gets `xml:space="preserve"`.
- XML is edited as text between known tags. Values are escaped, and characters XML cannot hold are dropped. In a sheet's page header an ampersand in a value is doubled, since Excel reads `&` there as a code.
- Only the parts that held a field with a value are written again. `zip.ts` copies every other part with its compressed bytes as they were, in the same order. It uses `node:zlib`; the app declares no zip library of its own.
- The fill never joins across a paragraph. A field it cannot join is left as written and named in `unfilled`. Cases seen: a field broken over two table cells, and over two paragraphs.
- A sheet's fields are listed in the cells' order, sheet by sheet, not in the shared strings' order.
- A deck: `fillDeck` reads it through `ctx.convert({ from: 'pptx', to: 'deckinfo' })`, which names slides and shapes as `slides_read` does, then sends one `text` op for each shape that holds a field (a table's cell: one `cell` op) through `pptxedit`, not strict. The edit replaces a paragraph's runs, so a filled paragraph takes its first run's look. Speaker notes are not scanned. No code of this pillar writes a `.pptx`.
- When no host can run the deck edit (no python-pptx in reach), the deck is placed as a plain copy and every field is named in `unfilled`; the host's log says why.

### Our own kinds

| Saved as a template from | Kept on the shelf as | Why |
|---|---|---|
| `.docx`, `.xlsx`, `.pptx` | a copy, as it is | nothing is lost |
| `.tcdoc` with no field (the markdown preview inside the file is scanned) | a copy, as it is | nothing is lost |
| `.tcdoc` with fields | `.docx`, through `work.formats.export` | one fill, in one place |
| `.tcsheet` that is open in a canvas item and is his own | `.xlsx`, through `work.sheets.export` | Excel is where sheets are going |
| any other `.tcsheet` | a copy, as it is | its export is by item |

`work.sheets.export` writes its file beside the sheet; the save moves that file onto the shelf, so nothing is left beside it. It is never asked for a sheet others can open. A `.tcdoc` or `.tcsheet` he moves into `Templates` by hand is listed and used as a plain copy with no fields, and its state is not opened. The `.tcdoc` to `.docx` path loses what the exporter loses today.

## Making a file (`make.ts`, `place.ts`)

One path for the shelf, Files' New, the tools and the other pillars:

1. Resolve the template.
2. Copy its file to `<userData>/work-templates/scratch/<random>/` and fill it there.
3. `lookOf(ctx, workspaceId)` (below). It answers null today.
4. Name it: the caller's `title`, else the template's name, then " - " and the first asked field that has a value ("Game report - Central at North"). `fileStem` drops what a disk refuses.
5. Place it. His own press (a window, a paired device) asks Files first: `work.files.make { workspaceId, at: into ?? the workspace's folder, kind, name, from: scratch, op }`. Files then picks the name and the place's form and asks what it must in a shared place. While Files answers "cannot make a file yet" (before its F2), and always for a thread's or another pillar's call, the file is copied into the workspace's own folder under a free name, never over another file. `into` is then taken only when it is a folder inside the workspace's own folder, made if missing; anywhere else is refused in one sentence.
6. Answer `{ source, kind, title, unfilled }`. The scratch folder is removed, also on a failure.

Opening is the caller's: the window opens the file in a Files tab; a tool calls `ctx.canvas.open`.

`ctx.peer` refuses its own host, so Files' `work.files.make` and `work.files.trash`, and the exports of formats and sheets, are called through the module's `handle` from the registry (`WORK_MODULES`), with the real caller, so Files' door judges who pressed.

A remote key makes, saves and lists only for a workspace whose folder it may reach (`ctx.reaches`).

## The wire (`src/shared/contract-work-templates.ts`)

| Method | Cap | Answers |
|---|---|---|
| `work.templates.list { workspaceId }` | read | `{ templates, hidden }` |
| `work.templates.make { workspaceId, template, into?, fields?, today?, title? }` | operate | `{ source, kind, title, unfilled }` |
| `work.templates.save { workspaceId, source, name?, everywhere? }` | operate | `Template` |
| `work.templates.rename { workspaceId, template, name }` | operate | `Template` |
| `work.templates.move { workspaceId, template, everywhere }` | operate | `Template` |
| `work.templates.remove { workspaceId, template, confirmed? }` | operate | `{ trashed?, confirm? }` |
| `work.templates.unhide { workspaceId }` | operate | `{}` |

- The push `work.templates { workspaceId | null }` follows every change; null means every workspace's shelf (a template for all jobs was saved, moved or removed).
- Every method is carried to the workspace's host, so a Mac window reaches a shelf on the box. The phone has no rows.
- **Remove.** A starter is hidden in that workspace. One of the job's own goes to Files' Trash where Files has one, and the answer's `trashed` holds the rows Put back takes. Where Files has none yet, and for a template for all jobs (it lies in the app's own data), the first call answers `{ confirm: true }` and deletes nothing; the window asks him and calls again with `confirmed: true`.
- **Save** copies. The source is never moved, renamed or written, whoever can open it. It takes a file on this host (`{ at: 'file' }`, or an Office item's `{ kind: 'path' }`).

## Tools (`tools.ts`)

Listed for a workspace's threads; a Work Chat has no shelf and gets none.

- `template_list` (read only): each template's name, kind, group and fields.
- `template_make { template, fields?, title? }`: makes the file in the workspace's own folder, opens it in the thread's canvas, answers the item id and the fields still unfilled. The folder is his and unshared, so nothing is held. It takes no folder, and no tool makes a file in a Teams or OneDrive library.
- `template_save { item, name?, everywhere? }`: puts the file of one of the thread's own canvas items on the shelf.

A play is text, so "start the game report" is a step that says so; the play's thread calls `template_make`.

## For other pillars (`api.ts`)

- `makeFromTemplate(ctx, { workspaceId, template, into?, fields?, title?, today? }, by?)` answers `{ source, kind, title, unfilled }`. Money calls it with `'unify/invoice'` or `'Invoice'`, prep with `'Meeting notes'`. A field not passed stays in the file; nothing asks. With no `by` the call is treated as a thread's: a copy into the workspace's own folder, never through Files' door as him.
- `templatesFor(ctx, workspaceId)` answers the shelf.
- `registerStarterTemplates(kind, entries)`: see "The shelf".

## The screens (`src/renderer/src/work/templates/`)

Every part is a Kobra part (`components/README.md`). One tile, one grid and one dialog serve the shelf, New and the fields.

- **The tile** (`Shelf.tsx`). A button over the whole tile: the plate, then one 13/20 line with the kind's glyph and the name, truncated. 6px of padding against a -6px margin so tiles align to the grid's edge, a 12px radius, a 5% foreground wash on hover, the focus ring inside, `scale(0.97)` while pressed. No badge, no description, no count. Starters and his own look the same; only their menus differ. The glyph turns to a `Spinner` when a make runs past 150 ms (`SPIN_AFTER_MS`); the tile does not move.
- **The plate** (`Plate`) is a small drawing of the kind in the tile's own measure, until Files' thumbnails land and take its place: a document is a heading and lines of writing, a sheet a grid with a head row, a deck a title slide. It shows no glyph, so the glyph stands once, on the name's line. The glyph is uncoloured until Files' kind tints are on master.
- **The groups** (`model.ts` `shelfGroups`): the workspace's name (his own, then the sector's starters, each by name), then "All jobs". A group with nothing is not drawn. Each is a 12px muted label over a grid: `repeat(auto-fill, minmax(148px, 1fr))` on the page, three columns in the dialog (two under 640px), gap 16px by 12px.
- **Keys**: the shelf is one tab stop. Arrows walk the tiles across both groups, Home and End jump to the ends, Return makes.
- **The Templates view** (`view.ts`, `TemplatesView.tsx`; id `templates`, order 3.6, `readsLifeos: false`, chunk `work-templates-view`). The header carries a ghost "Add…" (the system's file chooser) and, only when starters are hidden, a ⋯ with "Show hidden". Loading is skeleton tiles in the grid's shape, an error is the frame's own line with Retry, and an empty shelf is "No templates" with "Add…". A file dropped on the view becomes a template: the view takes the drop as an inner surface, so no thread starts. Add and a drop take a file of the workspace's own host; from a window on another computer one line says so.
- **A tile's menu** (right-click, or the ⋯ that shows on hover and focus; on the page only): New from this; Edit (a starter: Edit a copy, which saves it as his own and opens that); Rename…; "Use in all jobs" or "Only in <job>"; Remove (a starter: Hide). Remove of his own follows the host's answer: `{ confirm }` shows a `ConfirmDialog`, `{ trashed }` a toast "Moved to Trash" with Undo (`work.files.restore`).
- **New from a template** (`TemplateDialog.tsx`, a `Modal` of size md, chunk `work-templates`). The same two groups. The footer says "Kept in <folder>" only when `into` was given. A tile with no fields makes the file and the dialog closes. A tile with fields turns the same dialog to the fields; no second dialog opens on top. The step that arrives fades in over the fast duration, with no motion under reduced motion.
- **The fields** (`FieldsForm.tsx`). The title is the template's name. One `Field` per asked field in the file's order, the first focused; Return moves to the next and in the last makes the file. "Back" stands at the footer's start when he came from the tiles. Create is never greyed: an empty field stays in the file. While making, Create spins and the fields are read only. The host's refusal is one line under the fields, in its words.
- **Save as template** (`SaveDialog.tsx`). "Name", filled with the file's name and selected; the check row "All jobs"; when the caller knows the fields, "Asks for Client and Game." as the name's hint, else the toast "Saved to Templates" says it from the host's answer.
- **The ways in** (`open.ts`, the one renderer file another pillar may import; it loads no chunk): `openTemplates({ workspaceId, into?, intoName? })`, `saveAsTemplate({ workspaceId, source, name?, fields? })`, `openMade({ workspaceId, source })` (`work.files.open`, then the Files view; no thread). They go through `workTemplatePort` (`lib/workSwitch.ts`), which `TemplatesHost` fills while Work's shell is up; first paint carries the port alone.
- **The make** sends the window's own day (`today`).
- The pillar raises no notice. Its toasts answer his own press.

### The row

`TEMPLATES_ROW` in `src/renderer/src/work/views/registry.ts` is off, so the column draws no Templates row (`workViewRows`) and Save's toast has no "Show". A made file opens in a Files tab, and the Files row on master is still the Teams view; the row goes on with Files' new view (its F1b). Setting the constant true is the whole change, and shell.test.ts holds both states. The dialogs, the port and `open.ts` are live either way.

### Pictures

`Templates.preview.tsx` holds the preview pages (`bun run ui:preview src/renderer/src/work/templates/Templates.preview.tsx#TemplatesViewPreview`, also `TemplateDialogPreview`, `FieldsPreview`, `SavePreview`). A menu and a dialog draw in portals a preview cannot hold, so the dialogs are drawn inside the Modal's own box and the menu is held by DOM tests.

## The starters (`starters/`, `resources/work-templates/`)

Twenty-three files, checked in under `resources/work-templates/<sector>/<Name>.<form>` and packed with the app (both builder configs hold only negative globs, and none matches the folder). `starters/manifest.ts` lists them: sector, name, kind, form and the fields each asks for.

| Job | Starters (kind; fields asked) |
|---|---|
| Cosmic | Release note (document; Version) · Incident report (document; Incident) · Release checklist (sheet; Version) · Update briefing (deck; Update) |
| Hypixel | Shot list (sheet; Video) · Video brief (document; Video) · Script (document; Video) · Review deck (deck; Video) |
| Purdue | Memo (document; To, Subject) · Event run of show (document; Event) · Travel budget (sheet; Trip) · Program update (deck; Term) |
| Ref | Game report (document; Home, Away, Site) · Incident report (document; Home, Away) · Season log (sheet) |
| Unify | Invoice (sheet; Client, Invoice number), key `unify/invoice` · Proposal (document; Client, Project) · Statement of work (document; Client, Project) · Pitch deck (deck; Client) |
| Life | Trip plan (document; Trip) · Monthly budget (sheet) · Checklist (document) |
| All jobs | Meeting notes (document; Meeting), key `any/meeting-notes` |

**To make more, or change one.** Add its row to `manifest.ts`, write its fixture (`starters/docs.ts`, `sheets.ts` or `decks.ts`), then run the build by hand and check in what it wrote:

```
bun --preload ./scripts/lib/electron-stub.ts scripts/build-work-templates.ts
```

The build is never run at build time. It removes any file the manifest does not name. Documents and sheets come out the same bytes each run; a deck does not, since pptxgenjs stamps the time.

- **Documents** are block fixtures written through work-kit's `writeDocx`, then `themeDocx` (`starters/docx.ts`). The pass is needed because `writeDocx` writes the `docx` library's default styles, which hold hex colours. It writes Word's built-in styles on theme colours and theme fonts, sets 11 pt body and US Letter with inch margins, gives table rules a theme tint, hangs a check item's box, and fixes the core dates. It shrinks to the dates once `writeDocx` writes its own styles and theme (DOC3, DOC5).
- **Sheets** are written by `starters/xlsx.ts`: one fixed style sheet with Excel's named styles (Normal, Heading 1, Heading 2, Total, Input, Note, Currency, Percent), date and number formats, widths, formulas with no cached values, a frozen head, pick lists and print set-up. It is not a second sheet writer: it knows only what the starters use and imports nothing of the sheets pillar.
- **Decks** are inputs to the slides pillar's own `slides_new`, run by the build from the slides module's tool list. No code of this pillar writes a `.pptx`. A deck keeps `slides_new`'s look.

The rules every starter keeps, each held by `starters.test.ts` over the checked-in files:

- In documents and sheets, colours are theme slots with tints and automatic ink, and fonts are the theme's heading and body: no literal colour outside `theme1.xml`. So a job's look recolours all of it by swapping one part.
- No picture, logo or embedded font. One thing is let through by name: a deck's chart keeps its numbers in `ppt/embeddings/Microsoft_Excel_Worksheet.xlsx`, as pptxgenjs writes it.
- No name of an employer, school, league, game or person (a deny list, whole words, every part). Where one belongs the file says `{{Job}}`, `{{Name}}` or a named field. Sample rows are plainly made up ("Item one").
- Every field in a starter's manifest row is in its file, in that order, and no other.
- Each document reads back through work-kit's `readDocx` with the fixture's headings, each sheet through `importXlsx` with its sheet names, and each document and sheet fills with nothing left.

`starters/shelf.test.ts` holds the shelf to the manifest: each sector's workspace lists its starters and every job's, and each is found by its key.

LibreOffice draws a Word run or fill that is `auto` with a theme colour in automatic ink, so there a document's headings, rules and table heads are black with no fill; Word shows the theme's colours. Sheets show their theme colours in both.

## A job's look (`look.ts`)

`lookOf(ctx, workspaceId): JobLook | null`, with `JobLook = { theme: OfficeTheme; logo? }`. It answers null. `make.ts` asks it once, after the fill and before the file is placed. The feature that gives a job its colours, fonts and logo fills `lookOf` and writes the one swap of `theme/theme1.xml` in the scratch file. `OfficeTheme` is work-kit's (`work-kit/format/theme`).

## Proofs

- `bun scripts/proof-bun.ts scripts/proof-templates.ts`: the module as the host loads it, a dummy workspace on a real database, a stand-in thread calling the three tools on the fill's fixtures, each made file read back. With `TEMP_CODE_WORK_TOOLS_DATA` (through `heavy`) the deck is filled by the slides pillar's real edit and LibreOffice opens every filled file.
- `fixtures/make.ts` makes the fixtures: `split.docx`, `fields.xlsx`, `split.pptx`.
- `deckFill.test.ts` runs the real deck edit behind `TEMP_CODE_WORK_TOOLS_DATA`.
- `env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-templates.ts --out <dir>` (after `electron-vite build`, through `heavy`): an isolated instance of the built app with a dummy Work workspace and no LifeOS sign-in. It drives the wire through the real router and fence, a thread's tools through the bridge, and the window's part when the Templates row is on.
