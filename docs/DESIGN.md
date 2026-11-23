# Design system

This is the standard every renderer change follows. It wins every conflict
with docs/LAYOUT.md, a skill's advice, a library's default or a thread's
brief. `src/renderer/src/components/README.md` is the map from each class of
UI element to the one component that renders it.

## The look, in one paragraph

Claude desktop's transcript inside Cursor's chrome. The chrome is quiet and
dense: 13px type, one gray step between the rail, the content and a floating
layer, hairline borders, no shadows on anything docked. The transcript is
tight: 14px prose on 22px lines in a 768px column, the person's words in a
soft bubble on the right, the model's as plain text on the left, its actions
clumped into one muted 28px line per paragraph whose rows open under it in
one hairline table, 32px a row, with rules between them. Colour means something or is absent: amber when the
person is needed (and on the context meter from 85% full), red when
something failed, green for lines added, the one
blue accent for links and focus, and a thread's type on its glyph alone.
Motion is short, physical and interruptible;
nothing bounces, glows, slides in from nowhere or stays on screen when it is
done.

## The one standard

Kobra (kobra.systems) on Base UI is the component library. Every button,
field, menu, popover, dialog, sheet, tab, switch, tooltip, list row, empty
state, spinner, skeleton, question card and task list is the
component under `src/renderer/src/components/ui`, adapted once at install
to the tokens below, to `chrome/icons` and to the motion values below.
The README's table is the authority on which component renders which class
of element; nothing is rendered twice by two different things.

What this standard retired is gone: the old drawer, settings shim, rail and
composer action buttons and motion button, the four custom toast stacks
(sonner), the nine spinner builds (`Spinner`), the twenty status-to-colour
maps (`StatusMark`) and every raw button (`Button`, `ItemButton`). ReUI, BeUI
and Beautiful UI are no longer sources; their registries are gone from
components.json. `lib/motionGuard.test.ts`, `lib/colourGuard.test.ts` and
`domTitles.test.ts` keep it that way.

Hand-made and staying so: the transcript's rows and markdown pipeline, the
composer's field, the rail, the tab strip, the editor, the terminal, the
charts (`aliax/charts`, on recharts and the `--chart-1..4` tokens), and
Work's canvas shapes: the canvas pane's tab row and kind bar, the sheet
grid (its formula bar, sheet tabs and chart object), the document editor
(the tracker's block editor, shared), the mail client and the task and
agenda lists (LifeOS's, shared), the Messages view (TempCode's own, on
Mail's frame), the project screens (the tracker's,
shared), the PDF page, the slide stage, the media
viewer, the meeting view, the live browser, the form canvas, the dashboard
page, the compare and History views, the Outbox, the routines' week
grid, and a show's two windows (the slideshow and the presenter's view:
the one surface where the content, not the chrome, fills the screen).
They are built from the components above wherever they have a
button, a menu, a field or a status.

## Tokens

The token layer is the top of `src/renderer/src/index.css`. Nothing in
`src/renderer` writes a literal colour, duration or curve; a new value is a
new token, named for its use, added there first.

### Colour

Two themes, one neutral palette: dark (`:root`) and light
(`html.theme-light`). There is no hue, saturation, glass, accent or contrast
setting. Which theme a window wears is "Appearance by place" below; how the
light one is built is "The light theme".

| Token | Use | Dark | Light |
| --- | --- | --- | --- |
| `sidebar` | the rail and the title bar | oklch 0.17 | oklch(0.962 0.004 264) |
| `background` | content | oklch 0.195 | white |
| `card` | a bounded region inside content (a card, a transcript action list, the person's bubble, the composer) | oklch 0.225 | oklch(0.974 0.003 264) |
| `popover` | every floating layer: menu, popover, dialog, sheet, the editors' widgets | oklch 0.24 | white |
| `muted` | a hovered or highlighted row, a track, a key cap | oklch 0.275 | oklch(0.948 0.004 264) |
| `sidebar-group` | a group's resting fill in the chrome (a project card in the workspace column) | oklch 0.213 | oklch(0.948 0.004 264) |
| `sidebar-group-hover` | that group hovered | oklch 0.244 | oklch(0.936 0.005 264) |
| `sidebar-group-selected` | that group selected | `muted` | oklch(0.922 0.006 264) |
| `secondary` | the secondary button | oklch 0.29 | oklch(0.935 0.005 264) |
| `border` | every hairline | white 9% | rgb(15 23 42) 10% |
| `input` | a field's border, a switch's off track | white 12% | rgb(15 23 42) 18% |
| `foreground` | text that matters | oklch 0.93 | oklch(0.2 0.012 264) |
| `muted-foreground` | text that supports it | oklch 0.68 | oklch(0.46 0.014 264) |
| `faint-foreground` | text that may be missed: a line number, ghost text, a done task, a diff's context | oklch(0.56 0.006 270) | oklch(0.58 0.012 264) |
| `primary` / `primary-foreground` | the one primary button per surface, a checked box, a switch on | near-white / near-black | oklch(0.21 0.012 264) / white |
| `accent` / `accent-foreground` | focus rings, a selection's edge, the rare call to action | blue 62% / white | hsl(214 88% 44%) / white |
| `link` | a link's words, in prose, a document, a form | `accent` | hsl(214 90% 38%) |
| `warning` | the person is needed; the context meter from 85% full | amber | `#92450a` |
| `waiting` | work parked on someone else: a task that waits | orange `#fb923c` | `#b93a0c` |
| `stage-doing`, `stage-waiting`, `stage-done` | a stage of work as a mark on the project screens (a state's glyph, a meter's segment), never a word. Work in hand takes no hue, as a working thread takes none | `muted-foreground`, `waiting`, `success` | the same three |
| `destructive` / `destructive-foreground` | failed, delete; the label on a solid red button | red / white | `#b91c1c` / white |
| `success` | lines added, passed | green | `#046c4e` |
| `info` | the one informational tint | blue | `#1d4ed8` |

The tooltip is drawn inverted in both themes: `foreground` fill, `background`
text. The dim behind a dialog or a sheet is `scrim` (black at 30% dark, 18%
light). An image's edge is `image-outline`, a 1px outline at 10% (white in
dark, black in light), on a thumbnail, the lightbox, the QR code and avatars.

The status colours (`success`, `warning`, `destructive`, `info`) are text
as often as fills, so each reaches 4.5:1 as small text on `background`,
`sidebar`, `card` and a selected (`muted`) row in both themes; the light
theme's are the darker steps for that (`lib/tokenContrast.test.ts`).

The chart tokens (`--chart-1..4`, aliax/charts) colour thin marks, so each
reaches 3:1 on `background` and `card` in both themes
(`lib/tokenContrast.test.ts`). Colour follows the entity, never its rank: a
provider keeps its slot on every chart (Claude `chart-1`, Codex `chart-2`),
a model takes one of its provider's slots by its family, never by its
output rank (`chart-1` or `chart-3` for Claude: Opus and Haiku the first,
Fable and Sonnet the second; `chart-2` or `chart-4` for Codex: Sol the
first, the other lines the second; `modelSlot` in aliax/charts/palette.ts),
and a model whose slot a bigger one holds, or anything past them, folds
into Other in `muted-foreground`. One series that counts both providers
(Top projects, Tools used, Cache hit rate, the Busiest hours ramp) is the
neutral `NEUTRAL_SERIES`, the foreground mixed 60% into the page, never a
provider's colour.
Every chart and the heatmap read a hover out the same way
(`ChartTooltipContent`: the popover's fill, `rounded-xl`, 12px inset), and
their ticks are 12px.

The `sidebar-group` steps are a container's surface, never an item's: a
thread row stays bare in every list. They are opaque steps away from
`sidebar`, each at least 0.01 of OKLab L past the one before and the
selected step the farthest (`lib/sidebarGroup.test.ts`), with both inks at
4.5:1 on each (`lib/tokenContrast.test.ts`). Light's ladder runs 0.948, 0.936, 0.922: the
status colours are the darker steps that still reach 4.5:1 as text on the
selected one, the info blue among them.

### The light theme

Light is a theme of its own, not dark turned over. Its rules:

- **Ground.** Content and every floating layer are white. Chrome and the
  regions inside content step down from white: `card` 0.974, `sidebar`
  0.962, `muted` and a group 0.948, the hovered group 0.936, the selected
  one 0.922, all at hue 264, the dark theme's own. In dark a nearer surface
  is lighter; in light a floating layer is white with `shadow-overlay` and
  the hairline, and a docked one is a gray step with no shadow. A sheet's
  cells, a document, an editor and a PDF's page are white already, so a
  canvas sits in the content with no seam.
- **One declaration, two values.** A value that differs by theme is a token
  with a value in each block of index.css. A component never asks which
  theme is on: no `dark:` utility, no `.theme-light` selector outside the
  token blocks, no `useColorScheme` to pick a colour
  (`lib/colourGuard.test.ts`). The hook is for a thing that must be told in
  JS: an editor's theme, a frame's document.
- **Three inks.** `foreground`, `muted-foreground` and `faint-foreground`.
  Text is never an opacity of `foreground`: a mix that reads on dark falls
  under 3:1 on white. Opacities of `foreground` are for fills and edges.
- **Links are `link`**, never `accent`: the accent is tuned to carry white
  text and a 3:1 ring, a link to read at 4.5:1 on every surface.
- **A solid fill names its ink.** `primary`, `destructive` and `accent`
  each have a `-foreground`; nothing writes white on a status colour.
- **A picture keeps its own colours** ("Canvas tints"): paper is white in
  both themes, a video's matte is black in both.

The contrast contract, held for both themes by `lib/tokenContrast.test.ts`
from the values in index.css (the status and chart contrast tests fold into
it; `sidebarGroup` keeps the order of its steps and `typeTint` its hue
distances):

| Tier | What | Floor | On |
| --- | --- | --- | --- |
| text | `foreground`, `muted-foreground`, `link`, the four status colours, the composer's skill and mention ink, each `-foreground` on its fill, the tooltip's pair | 4.5:1 | `background`, `sidebar`, `card`, `popover`, `muted`, `secondary` and the three `sidebar-group` steps (a `-foreground` on its own fill only; skill and mention ink on `background`, `card` and `popover`, where they are typed) |
| quiet text | `faint-foreground` | 3:1 | the same surfaces |
| mark | `accent` as a ring, the type tints, `chart-1..4`, the three `chart-neutral` steps, a glyph in a status colour | 3:1 | the surfaces it is drawn on |
| edge | `border`; `input` | 1.15:1; 1.4:1 | `background`, `sidebar`, `card`; `background`, `card` |
| wash | `foreground` over each canvas tint laid on `background` and `card` | 4.5:1 | the mixed colour |
| code | every ink of the editor's two syntax themes, CodeMirror's two tables and the terminal's sixteen colours per theme; a completion kind's name; the letter on a kind's badge | 4.5:1 (a comment and a line number 3:1) | the editor's and the terminal's ground; the popover and the highlighted row; the badge's fill |

Named exceptions, each recorded in the test with its measured ratio so a
change to one is seen: the eight presence hues and their label inks (the
shared editor's, one value in both themes), the six sector dots (LifeOS's,
never the only cue: the sector's name is beside each), the runner's
coin and star, and a field's border on the rail (1.37:1 in dark).

**Dark is held.** The owner works in dark while light is built, so dark
keeps every value it had, and no commit changes how it looks.
`lib/darkHeld.test.ts` compares the dark token block and the dark code
palettes with a frozen copy (`lib/darkHeld.json`): a dark value moves only
when he asks, and that file moves with it. Where the contract finds a dark
pair under its floor, the test records it (`HELD_IN_DARK`, and
`ANSI_LIFTED` for the terminal's black and bright black) and leaves it:
white on dark's accent (2.88:1) and on its red (2.77:1), the neutral
chart's two quieter steps (2.42:1 and 1.85:1), the white letter on seven of
Monaco's completion badges, and the lowest steps of dark's text ladder.

A look that light changes and dark keeps is a token with a value per
theme, grouped in index.css under "Held in dark":

- Text. In dark, quieter text is still a mix of `foreground`, as it was: a
  ladder of tokens named for the share (`ink-35` to `ink-55`,
  `ink-muted-60`, `soft-foreground` at 70%, `near-foreground` at 80%). In
  light each is one of the three inks, which is the rule above.
- A link is the accent in dark; an agent page's link keeps its sky blue
  there (`link-color`).
- A diff's context line is dimmed in dark and steps back by ink in light;
  the Inbox diff's code is green keywords and amber type names in dark and
  the transcript's two inks in light.
- A slide's ground is the bare canvas in dark and `stage` with a 16px inset
  in light; a raster add-on mark's tile is clear in dark.
- The names work-kit reads and TempCode never defined (the date picker's
  colours, its one radius, its ring duration, its floating sheet's shadow)
  have a value in light and none in dark.
- Monaco's completion list keeps IDEA's row and badge fills in dark and
  takes the muted row and darker fills in light; the terminal keeps its
  dark theme's four values and holds a program's colours to 4.5:1 only on
  the light pane; a brand mark's colour is judged only on the light menu;
  the full editor follows the browser's system from a dark window.

Each is his to change in dark: `docs/agents/appearance.md` lists the one
edit that flips it.

What draws with its own theme takes it from the tokens or carries a table
per theme, and follows a change live:

| Surface | Source | On a change |
| --- | --- | --- |
| Monaco | Darcula and IntelliJ Light (`lib/intellijTheme.ts`), the chrome read from the tokens (`surfaces/monaco/theme.ts`), the completion kinds from `--editor-*`, a value per theme | re-themed in place |
| CodeMirror | `surfaces/editorChrome.ts`: the tokens, and a highlight table per theme (`lib/editorPalette.ts`) | compartment reconfigured |
| The terminal and Dev Console | `lib/terminalPalette.ts` and `surfaces/TerminalView.tsx`: sixteen colours per theme, the pane's own ground as xterm's background, `minimumContrastRatio` 4.5 on the light pane | theme and floor assigned |
| Transcript code | two inks (`foreground`, `muted-foreground`) by CSS variable; Mermaid's own light and dark | CSS; Mermaid redraws |
| The sheet (Univer) | the tokens, read on the grid's container (work-kit `sheet/grid/theme.ts`) | repainted |
| The document (BlockNote) | the tokens through work-kit's `--bn-*` map, the scheme passed as a prop | prop |
| Mail's frames | a designed mail on white paper in both themes; a plain one in the host's inks, set on the frame's root from outside, with a sender's colour moved only when it would not read | tokens set again, the frame kept |
| The ONLYOFFICE editor | the window's scheme when it opens | not live |
| An agent's HTML page | the frame variables in "html_render" (`src/shared/htmlRender.ts`) | posted to the frame |
| Guest, form and pairing pages, the Mac's computer banner | the viewer's system; their palettes are copies held equal to index.css by test | media query |

### Appearance by place

Settings → Appearance holds a theme for each kind of place: **Code** and
**Work**, each System, Light or Dark (`lib/appearance.ts`,
`monocode.colorScheme` and `monocode.colorScheme.work`, per device). Work
follows Code until it is set. With Work off on every host the page shows
one row, Theme.

A window wears the theme of the place selected in its rail
(`placeKind`, `lib/placeScheme.ts`): a code workspace and Chats take
Code's; a Work workspace and Work Chats take Work's. A page opened over a
place (Settings, Inbox, Outbox, Search, Notes, Accounts, Stats) keeps that
place's theme, so a glance at one never changes the window. Each window
has its own place and so its own theme.

The place changes at once, as it always has; where its theme differs, the
theme dissolves in over it: one dissolve of the whole window, `--dur-fast`
on `--ease-out`, opacity only, made by a view transition round the class
change alone. The old place never shows in the new theme. Element
transitions are off while it runs (`html.theme-switching`): a colour never
animates on its own, which smears. The dissolve takes no input: a click or
a key during it lands on the new place. Reduced motion jumps. The window's
native backing colour and its first paint at launch take the theme the
window last wore (`appearance:scheme`, kept with the window's geometry), so
nothing flashes dark behind a light window.

### Type tints

A thread's type has one colour, and only its glyph takes it: never a title,
a label, a fill or a border. `TypeGlyph` (surfaces/threads/TypeGlyph.tsx) is
the one thing that draws a type's glyph, and a menu row naming a type uses
`THREAD_MENU_ICONS`. The tints are v1.0.303's, held as literals so a status
colour's retune never moves a type.

| Token | Type | Dark | Light |
| --- | --- | --- | --- |
| `type-chat` | chat | `#60a5fa` | `#2563eb` |
| `type-planning` | plan | `#a78bfa` | `#7c3aed` |
| `type-project-plan` | project plan | planning's | planning's |
| `type-implementation` | implementation | `#34d399` | `#04875f` |
| `type-orchestration` | orchestration | `#cedd59` | `#7d6700` |
| `type-research` | research | `#22d3ee` | `#0784a3` |

Orchestration was amber at v1.0.303, the same amber as Needs you; it now
sits 31° (dark) and 44° (light) of OKLCH hue from `warning`. The rule, held
by `lib/tokenContrast.test.ts` and `lib/typeTint.test.ts`: each tint reaches
3:1 (the non-text bar) on every surface in both themes, and stands at
least 30° of OKLCH hue from `warning` and `destructive`. On the selected
group step light implementation (3.60) and research (3.45) are under 4.5:1,
which is why no text may take a type tint. A glyph is always tinted, on an active chip or
an idle one; a row's own dimming (offline, disabled) dims it with the row,
and it never brightens to mean active.

Opacities on `foreground` are the hover vocabulary: `/5` a hovered row,
`/7` a hovered ghost button, `/12` a pressed one. Status colours never fill
a surface above `/10`, with one exception: the window's Close off macOS
(chrome/WindowControls.tsx, Linux and the web /ui) fills solid
`destructive` on hover, as every Windows and Linux window's close does; the
platform's convention outranks ours there.

### Canvas tints

Work's canvas (the pane beside a thread, "The canvas pane") marks content
with these. Each is mixed from a token above, so one declaration follows
both themes, unless the table gives two values.

| Token | Use | Value |
| --- | --- | --- |
| `add-bg` | a change waiting on the person: added words, a filled cell, a suggested task | `success` 14% |
| `add-bg-soft` | a sheet's cells just after the agent wrote them | `success` 8% |
| `del-bg` | words or cells a change would remove (struck through, in `soft-foreground`) | `destructive` 12% |
| `sel-bg` | a selection the person made that an Ask or a comment will take; the current find hit, with the accent line | `accent` 22% |
| `diff-gap` | the blank that holds a missing side's place in a compare | `foreground` 4% |
| `border-strong` | a sheet's frozen-pane line | `foreground` 24% |
| `find-hit` | a find hit in a canvas that is not the current one | `foreground` 14% |
| `comment`, `comment-hot`, `comment-line` | a comment's words in a document: rest, open or hovered, and its 1.5px underline | `foreground` 8%, 14%; `muted-foreground` 50% |
| `bone` | the document editor's loading lines | `foreground` 9% dark, 7% light |
| `track` | any timeline's track | `foreground` 14% |
| `wave` | a recording's wave; the part played is `foreground` | `muted-foreground` 55% |
| `run-dot` | a routine's planned run in the week grid | `foreground` 55% |
| `stage` | the ground under a picture: an image, a PDF's sheets, a slide | `sidebar` |
| `present-bar` | the bar over a slideshow, on the deck and never on the app ("The show") | dark `popover` 94%, in both themes |
| `chart-neutral` | a form's answer bars | `foreground` 30% dark, 54% light |
| `chart-neutral-rest` | a dashboard's bars beside the current one, which is `foreground` | `foreground` 22% dark, 48% light |
| `chart-neutral-stale` | that current bar while the figures are stale | `foreground` 40% dark, 65% light |

A comment is never amber: amber means the person is needed. A change
never takes a bar or an edge; it is the tint alone. The current change
in a compare is a 1px `foreground` 40% outline, written in place, with no
token of its own.

A picture keeps its own colours in both themes: a PDF's page, a slide, a
video frame, a website. A tint laid on a picture takes the theme the
picture is in, so it reads the same in a dark app. Paper (a PDF or a
document's page drawn as one) is `paper` (white) with `paper-ink`
(`#1f2430`) and takes the light theme's values: `add-bg-paper` (light
success 16%), `del-bg-paper` (light destructive 13%), `sel-bg-paper` (light
accent 22%), `find-bg-paper` (light accent 11%) and
`find-bg-paper-current` (34%). A dark picture (a dark slide) takes the dark
theme's: `add-bg-dark-pic` (dark success 26%), `del-bg-dark-pic` (dark
destructive 22%) and `sel-bg-dark-pic` (dark accent 30%). These are
literals on purpose. A picture sits on `image-outline` and is never themed.

Presence is one hue per other person or agent in a document or a sheet:
`presence-1` to `presence-8`, the shared editor's eight cursor hues in its
order (blue `#3b82f6`, purple `#8b5cf6`, green `#22c55e`, red `#ef4444`,
orange `#f97316`, teal `#14b8a6`, yellow `#eab308`, moss `#84cc16`), one
value in both themes, so a person wears one colour in TempCode and in the
tracker. `presence-ink-1` to `presence-ink-8` set a name label's text:
white on blue, purple and red, near-black on the rest. A hue marks a caret,
a cell's 2px outline, the name label on it and the person's avatar ring,
never a fill on content, so it cannot read as a change. The agent's caret
takes a hue too, its label named for its thread.

A sector's mark is LifeOS's: one 8px dot in a 16px slot, drawn only where
sectors mix (the rail's Work rows, the Outbox's groups, a grant list, the
settings list), never a chip, a tinted name or a coloured edge. The six
hues are the dot's alone, a value per theme: cosmic oklch(0.72 0.11 285)
dark, oklch(0.6 0.12 285) light; hypixel 0.74 0.11 40, 0.64 0.12 40;
purdue 0.78 0.1 85, 0.7 0.11 85; ref 0.72 0.09 155, 0.62 0.1 155; unify
0.72 0.09 235, 0.6 0.1 235; life 0.72 0.1 350, 0.62 0.11 350. They are
`--sector-cosmic` and so on, defined with the sectors themselves. An
unlinked workspace's dot is a 1.5px `muted-foreground` ring.

A canvas chart of one series is the neutral, never a provider's
`chart-1..4`, with no legend; those come in only when a chart compares
entities (two clients, sent against paid), and colour then follows the
entity. A dashboard has no hero tiles, card grids, sparklines, rings or
rainbows.

### Type scale

| Size | Where |
| --- | --- |
| 11px | a key cap, a group label in a menu |
| 12px | secondary lines in the chrome, descriptions under a title, status words, a count in a row's status line |
| 13px | the chrome's default: rows, menus, buttons, fields, tabs, settings, an Item's title, a tooltip (regular, 20px lines); the transcript's action, thinking, notice and closing lines (20px lines in 28px rows, 32px in an open group's table) and their counts (`+46 −3`) |
| 14px | dialog and panel body text (22px lines); the transcript's prose, the person's bubble, a question's prompt and the composer's field (22px lines); a split view's header title (a board's, a plan's, a research thread's: semibold foreground over its 13px rows, its detail 12px muted 8px after it, both truncating, `ViewHeader` in surfaces/threads/SplitShell.tsx) |
| 15px | an h2 in the model's prose; a document's body (a plan, a board's plan, a report: 15/24, its h3 15/24 medium) |
| 16px | a title: a dialog's, a sheet's, a page's, an inbox item's, a note's, a report's, an agent's (semibold on 24px lines at -0.01em, one recipe, `lib/typeScaleGuard.test.ts`); an h1 in the model's prose; a document's h2 |
| 18px | a document's h1 (26px lines, -0.01em) |

Work's canvases keep this scale. A document (the shared editor, a
meeting's notes, one compare column) is 15/24 body in a 672px measure,
title 18/26 semibold, Heading 1 16/24 semibold, Heading 2 15/24 medium,
Heading 3 15/24 medium muted, tables 14/20 with a 600 head on `muted`,
inline code 14px mono on `muted`; side-by-side compare columns step down
to 14/22 with tables at 13. A form's title is 18/26 semibold, a question
14/20 medium, its description 14/22 muted, a section 16/24 semibold. A
sheet's cells are 13/20 in 28px rows, its column letters and row numbers
12px muted tabular and centred on `sidebar` in a 24px letter row, numbers
right-aligned and tabular, the formula bar 13px with a 12px reference box,
sheet tabs 12px in a 28px row. A presence label is 11px medium. A
dashboard's figure takes the title recipe (16/24 semibold, -0.01em,
tabular) and is never bigger; its label is 12px muted, a section heading
13 semibold, a question 14 medium. A meeting's turn is a 13/20 medium name,
its minute 12px muted tabular 8px after it on one baseline, its words
14/22. A media list row's time is 12/20 tabular, the transport's 13/20
tabular. Strip, tile and thumbnail numbers are 11 or 12px tabular muted.
A recording's times read m:ss under an hour and h:mm:ss from an hour up.
Shared LifeOS screens take this scale: a mail's subject and the lead task
are the 16px title, rows 13px with 12px second lines, a mail's body 14/22.
Nothing inside a PDF's page or a slide is ours: the picture keeps its own
type. work-kit's two named steps map here: `text-lead` is 15/24,
`text-sheet-title` the 16/24 title.

`text-xs` is the one class for 12px; `lib/typeScaleGuard.test.ts` refuses
the literal `text-[12px]` throughout renderer source.

Weight and colour make the hierarchy, not size jumps: a title is `font-medium`
foreground, its detail `muted-foreground` at the next size down. Code is the
mono face one size below its surroundings. Tracking: `-0.01em` from 16px
up, none below. Numbers in tables and tallies are `tabular-nums`. File headers, approval
previews and implementation tallies use changeRows' `Counts`: sans at the
line's size, 4px between values, sharing the transcript's numeric renderer: 13px
beside a 13px name (a Changes row, a board's change row, a pass row), 12px on a
12px line (a hunk). A clock
time has one form, `clockTime` (lib/duration.ts): the locale's hour and
minute, 12-hour with AM/PM where it writes it so ("Landed 12:08 PM",
"Finished 2:02 PM"), never a hand-padded "14:02"; `tabular-nums` where it
sits in a column. Where a time can be another day's (the Computer
section's group headings, its "As it was at" lines and a step's time in
its facts: the journal keeps 30 days) it names its day, `dayTime`:
"2:02 PM" today, "Mon 2:02 PM" within the week, "Nov 3, 2:02 PM" before.

### Spacing

The 4px grid. Inside a row: 8px between glyph and label, 12px horizontal
padding, rows 28px tall in menus, dense lists (search results among
them: one line each) and `RailRow` (the rail, whose workspace rows sit
4px apart on `sidebar-group`, and the settings list), 32px for the thread rows of the workspace
column's Chats and Archived folds and 28px for the rows nested under them.
A project card in that column sits on `sidebar-group`: a 20px name line, a
16px branch line 2px under it, 24px read-only thread lines, and cards sit 4px
apart. The Chats and Archived folds under the cards start 16px below them, a
new group. Every menu, context menu and
select row takes its box from `MENU_ROW` (components/ui/menu-row.ts,
exported by dropdown-menu.tsx). Between groups in a panel or page: 16px; between sections: 24px.
A panel's inset is 12px; a dialog's 20px. Never a value off the grid.

### Radius ladder

`sm` 4px a key cap, a checkbox; `md` 6px a row's hover, a small button;
`lg` 8px a button, a field, a menu row, a card inside content;
`xl` 12px a popover, a card that stands alone, the composer; `2xl` 16px a
dialog, a sheet; `full` a switch, an avatar, a pill. Nested radii are
concentric: the inner radius is the outer minus the padding.

### Shadow

`shadow-overlay` on floating layers only: a menu, a popover, a dialog, a
sheet, a toast, the find bar, the jump-to-latest button, the `/` and `@`
popover and the editors' widgets (CodeMirror's tooltip and autocomplete,
Monaco's suggest, hover and usages, each on the popover's fill, hairline and
12px radius). Docked chrome and cards have no shadow, the segmented control's
pill included; their depth is the gray step and the hairline
(`lib/depthGuard.test.ts`). A scroller cut at an edge (the file tabs, the dock
bar) fades that edge over 24px (`useOverflowEdges`) instead of a hard stop. The one exception is a raised button (`default`, `secondary`,
`destructive`): it carries its own stack, a lip, an edge and a soft drop
(`--raise-primary`, `--raise-secondary`, `--raise-destructive`, with their
`-lit` and `-lifted` steps, a value per theme), on a fill layer behind its
label (`.t-raise` in index.css). A raised button never sits inside an
`overflow-hidden` box that would clip its drop; a clip the content needs
goes on an inner span.

### Scrollbar

`--scrollbar-thumb` (foreground at 20%), `--scrollbar-thumb-hover` (32%)
and `--scrollbar-thumb-active` (40%) colour the pill; `--scrollbar-size`
(10px) is the strip; `--scrollbar-inset` (0) is the track's end margin, set
to its radius by a rounded scroller. They follow `--foreground` into the
light theme. "Scrolling" has the rule.

### Motion tokens

CSS `--dur-hover` 60ms (a button's hover fill; a menu row highlights at once), `--dur-fast`
120ms (press, every exit, every reduced-motion fade), `--dur-base` 180ms (menu and popover entrances; folds),
`--dur-slow` 240ms (dialog and panel entrances), `--dur-drawer` 300ms (a
sheet). Curves: `--ease-out` for entrances and most transitions,
`--ease-exit` for a closing overlay, `--ease-drawer` for a sheet,
`--ease-in-out` for a symmetric move. Springs live in `lib/ease.ts`:
`SPRING_LAYOUT` (the tab indicator, icon swaps) and `SPRING_GLIDE` (a
released drag, overdamped so even a flick never overshoots). A drag settles
from where it is drawn and carries the pointer's speed at release
(`releaseVelocity` in lib/drag.ts, the last 100ms of readings), and past its
bounds it follows the rubber band (`rubber`). `springEasing` turns a spring into a CSS `linear()` curve
and its settle time (`SPRING_LAYOUT_CSS`: 370ms, no overshoot), for a
transition that glides like the spring without JavaScript; the same curve
is a token, `--dur-layout` on `--ease-layout` (the folds that open on their
own), held equal to it by lib/ease.test.ts. Code that drives motion itself
(the transcript's scroll glides) reads a curve through `cubicBezier`. The
stream's reveal is `REVEAL` (a step of whole words every 100ms, each fading
in over `--dur-reveal` 400ms on `--ease-reveal`, linear). A hover-revealed
control waits `--delay-hover` 100ms before it shows. `FOLD_HOLD_MS` (600ms) is the beat a
working group stays open after its work moved on. The word morph
(`MorphText`) leaves over `--dur-swap-out` 90ms and arrives over
`--dur-base`, both on `--ease-swap` (`cubic-bezier(0.2, 0, 0, 1)`,
`EASE_SWAP`), which also glides its box's width and slides the closing
line home. Rows that land together wait `--stagger-step` (30ms, `STAGGER`)
apart.
`lib/motionGuard.test.ts` fails on any literal duration or curve outside
`lib/ease.ts` and this layer; its script and CSS allow-lists are empty.
Three things loop, each a Web Animation of `transform` alone that the
compositor runs: the spinner's 900ms turn (`SPINNER_TURN`, on the box
around the arc), the working mark (`MARK`: three dots that gather and part
every 1.6s, each segment on `--ease-breathe`) and the working words'
shimmer (`SHIMMER`: a bright band crossing the words every 3s, held off
them until 15% of the period and swept to 85% on Claude's shimmer curve).
The mark and the shimmer start at 0 on the document timeline, so a remount
picks the gesture up where it was.

### Layers

`--layer-dialog` 90, `--layer-popover` 95 (menus, popovers, selects:
above a dialog so a picker inside one is never hidden), `--layer-toast`
100, `--layer-tooltip` 110.

### Focus

One ring: index.css draws a 2px `accent` outline inset 2px on every
button, link (an `a` or anything with `role="link"`, an inline file link
in the prose among them), option, menu item and tab, unlayered so it beats a utility's
`outline-none`, and so a row in a tight list never clips it. An element it
does not name (a scroll region, a `pre`, a `div` with `tabIndex`, a checkbox
root) takes `focus-ring`, the same outline. Nothing draws a second band
(`focus-visible:ring`); a field keeps `focus-field`. `lib/focusGuard.test.ts`
holds it.

## Typography and text hierarchy

Hard rule: no bullet points in the UI. Lists of bullets in a panel, a card,
a settings page, a notice or a transcript row are a smell; the one place a
bulleted list may stay is a markdown list the model wrote in its answer.

What to do instead: a group of related facts is set apart by text hierarchy
and space, not by glyphs or separators. A status is a `StatusMark` (glyph,
word, tone) on its own line or at the end of the title line. A detail line
sits under its title in `muted-foreground` at the next size down, with 2px
between them. A secondary line sits 4px below the detail in the same muted
tone, or at the end of the row in `tabular-nums` when it is a count or a
time. Groups are 16px apart; a group that needs a name gets a short
`font-medium` heading in 12px `muted-foreground`, never a label with a
colon. Two facts on one line differ in weight and colour, never only in
the space between them: a state's word in medium weight and its tone, then
its detail in regular weight and `muted-foreground`, 4px after it (two
spans, `StatusMark`). Every line keeps one spacing rule: a glyph sits 8px
from the first word; each word, detail, count or time sits 4px from the
next, about a space; a chevron or the hover actions sit 8px after the last
value. Two texts of different sizes on one line share a baseline: a row
that pairs them aligns on baselines (`items-baseline`), or puts both on one
line height, and a clipped inline-block (`WorkingText`) aligns to the
line's top, since its own baseline is its bottom edge
(`scripts/measure-line-pairs.ts` measures both in a browser). Where one plain string is unavoidable (a tooltip, an
accessible name, a toast, a notification) it is "Word: Detail"
(`plainStatus`, src/shared/statusWords.ts). No visible text separates two
facts with a run of spaces, a middle dot, a pipe or a bullet;
`lib/spaceGuard.test.ts` fails on a run of spaces in any renderer literal.
A run of facts of one kind is one comma sentence (`Facts`,
surfaces/settings/hosts/Facts.tsx: a span each, 4px apart, the comma drawn
after all but the last), never facts set apart by space alone.

Other rules: nothing is said twice (a count in the title is not repeated in
the body); nothing is explained that the layout already shows; labels are
nouns, buttons are verbs; a chip or badge exists only when it carries a
state the row cannot otherwise show, and never beside a title.

## Status vocabulary

`StatusMark` (components/ui/status.tsx) is the only status-to-glyph, -word
and -colour map. Its baseline is its word's (the glyph's 14px box centres
itself), so a mark after a title on one line shares the title's baseline.
Every rail row, tab, strip, board row, card and the phone's rows say
exactly this:

| State | Glyph | Word | Tone |
| --- | --- | --- | --- |
| working | the spinner | Working | foreground |
| waiting | a dot in a ring | Needs you | amber |
| paused | two bars | Paused | muted |
| failed | a ring with a bang | Failed | red |
| queued | a dashed ring | Queued | muted |
| stopped | a square | Stopped | muted |
| watching | a ring | Watching | muted |
| plan-ready | a page | Plan ready | muted |
| done | a check | Done | muted |
| idle | a faint ring | Idle | muted |

Held is not Needs you. Work holds whatever would leave the machine (a
mail, a post, an invite) in the Outbox until the person sends it. Held is
plain muted: the Outbox's count in the rail is muted text, a held row in
the transcript reads "Held" then the act in the person's words ("Held
Send to events booking"), and no Outbox surface takes the amber wash or
dot. Amber stays for a question to the person and for a site in the live
browser that needs them to sign in. A failed send takes the red mark.

Working drawn under a row that already moves (`StatusMark still`) is a 6px
dot in the working tone, never a still arc: a frozen arc reads as a spinner
that hung.

The word may be followed by what the state is about, drawn as a second
span in regular weight and muted, 4px after the word: Working then
"Editing Rail.tsx", Needs you then "Approve Bash", Watching then "3
subagents", Failed then "Usage cap". The host sends the detail on its own
(`SessionMeta.statusDetail`); `activity` keeps a legacy two-space string
for old readers and is read only when the detail is absent. A watching
thread always says what it watches; a row that cannot say is a bug. A
thread idle or done whose subagents still work is watching them (Watching
then the one subagent's title, "Review the perf pass", or "3 subagents") in the transcript's closing line,
the tab, the chip and the rail alike, and the fleet header counts watching on its own. `threadStatus` (lib/threadStripModel.ts) is the one
place that decides a thread's state and its detail, the tree's overrides
included, and `ThreadStatusMark` (chrome/TabIndicator.tsx) draws it with the
round's tally 4px after the detail. A watching thread on one task names it
in the model's words (Watching then "sleep 45 seconds"); more than one is
counted (`watchPhrase`, src/shared/watch.ts). A turn a wait_for_agent holds
says what it waits on by title, Working then "Waiting on Review the perf
pass" or "Waiting on 2 subagents" (`waitLine`), on the transcript's working
line and in the host's detail alike.

The slot above the composer (surfaces/threads/WorkingStrip.tsx, reserved
at 28px so nothing moves when a turn starts or ends, inset 6px as the
composer's row is, so Stop stands over Send, its facts 4px apart as on
every line, as a banner's and the checkpoint strip's are) holds the open turn's
elapsed time and Stop, nothing else, and the held states with their
actions: Paused with Stop and Continue, Stopped with Resume (the harness is
gone), Queued with Start now; a held row's way on (Continue, Resume, Start
now) is the raised `secondary`, Stop the ghost beside it. Every Stop there
spins in place while it lands (`BusyLabel`, keeping its word), until its
request settles, the row leaves its slot or `STOP_DEADLINE_MS` (10s) passes,
so a Stop the host never acts on never spins for good; the timer's
set at its width's end (`align="end"`) so the word stands over Send; a held
row's glyph sits in the `+` button's 28px box, on `+`'s axis (the row
carries the box's 1px sides, unseen), its word 8px after that box, and its
detail, the tally and the frozen time one comma run ("Stopped The harness
is gone, 1m 35s"). The queue's grip sits in the same box, centred on its
text's first line, and the text starts 8px after it, on the field's column. What the thread does is the transcript's
working line, a pending approval or question is its card, and a watching
thread's state is the transcript's closing line (Watching then its age,
ticking every second, amber past 30 minutes, opening the Activity section; an
age a half-minute clock refreshes, a banner's or an Activity row's, is whole
minutes, `minuteAge`); nothing above the composer
repeats the working line, and no banner repeats the slot. A person's Stop
idles the thread, the slot empties and the transcript's Stopped line says
so once. A first response is said in the transcript's working line, never
above the composer: Sending from the click until the host echoes the
message, then the host's word for the wait (Starting the CLI, Initializing,
Waiting for the provider, a retry, "Waiting for the provider, 25 s"), then
Thinking (with the thought block's seconds after it, "Thinking 4s", and its
finished sentences in the reasoning column under the line once the thought
streams with words), then
the running call ("Reading format.ts", "Running the tests", "Waiting on
Review the perf pass"), and the mark alone while prose streams
(`workingPhase`). A phase stays at least 300 ms once it paints and one that
came and went inside that hold never shows; the words shimmer, and a change
morphs them (the old words lift 3px and leave, then the new ones rise from
3px below as the box glides to their width), in the row's 28px, so nothing
below it moves. The timer above the
composer counts from the click and never steps back when the host's own
start arrives.

A detail is sentence-cased when it is a sentence ("Waiting for memory",
"Approve Bash", "Landed 12:08 PM", "The harness is gone") and written as it
is when it is a name or a count ("3 subagents", "sleep 45 seconds",
"Rail.tsx"); it never ends in a full stop and never repeats the word. A
phase keeps its comma inside the detail ("Rate limited, retry 3 in 32
s"): prose punctuation within one fact, not a joiner between two. The
renderer never changes a detail's case; only a detail read from an old
host's legacy `activity` takes a capital (`legacyDetail`).

A computer action's tier is never named on screen: `COMPUTER_TIER_WORDS`
(src/shared/statusWords.ts) words it for a person, "in the background",
"to the app", "in front" (the app brought forward for a moment) or "on the screen". It is the first fact of an open step in the Computer section, and the Activity row's detail where Activity still lists the session; a held computer
step says the scheduler's words as a Queued detail. The same file holds
the rest of a step's words: how a fallback went (`COMPUTER_ROUTE_WORDS`:
"through the menu File › Save…", "by the scroll bar"), what it changed
when that is not the plain case (`COMPUTER_EFFECT_FACTS`: "nothing
changed", "on screen only, not on disk"), why it failed
(`COMPUTER_FAILURE_WORDS`: "The element was gone") and why it never ran
(`COMPUTER_REFUSAL_WORDS`: "You didn't allow it"). A step's row never
shows the service's error kind or the model's own text. A row's verb is in
the past only for a step that ran ("Clicked Save"); one that failed, was
stopped, was refused or never ran reads as what was asked ("Click Save"),
so no row says a thing was done that was not. A key combo reads in the
Mac's own marks, in its menus' order ("⌘S", "⇧⌘Return": `keyCaps` in
src/shared/computer/words.ts, the transcript's rows too); the model's
grammar (`super+s`) stays on the approval card, which quotes the call.

At rest a row draws no mark for idle and done (`marksAtRest`): a mark that
would only say "nothing is happening" is noise. Two places draw done's
check: the right panel's Agents rows, where it leads a finished agent (the
panel has no other cue for what is done, and seeing it at a glance is the
section's job), and the rail's Working section, whose rows include a thread
that finished while the window looked elsewhere until it is looked at. A tab is the glyph alone, in the type glyph's place while it
works, waits or fails (the type glyph comes back at rest), so a tab's width
never moves with its state; its hover line and the transcript's working
line say the word and the rest.

Nothing loops. Every status glyph is still except working's spinner, a
rotation and the one moving glyph. A row has one moving mark at most: a
line that depends on a row's own mark (a subagent's under its board row, a
batch thread's under its master in a project card, a spawned agent in the
transcript) draws working as the dot (`StatusMark still`), and a settled
row never moves. A master's line on a project card spins while anything in
its block works, whatever the master's own state (`MasterBlock.lead`), so a
block always moves while it works. In the transcript the one moving mark is
the working line's (`WorkingMark`, its three dots); a running row there
draws working as the dot. When a mounted mark's state changes, its glyph cross-fades in the box that
stays: the old one shrinks to a quarter and fades over `--dur-fast` while
the new one grows from a quarter on the layout spring (`glyph-in`,
`glyph-out` in components.css); never at mount, and under reduced motion
both only fade.

A thread's model at a row's end is `ModelMark` (surfaces/threads/ModelMark.tsx):
the provider's logo, the short model name and, where the row asks for it
(the master board's thread rows), the effort in the composer's words
("Opus 5.5 High", "Sol Extra high"), all 12px `muted-foreground`, the logo
6px from the name and the effort 4px after it, never joined by a dot; the
model picker's trigger (chrome/ModelPicker.tsx) keeps those spaces in every
placement, the composer's row and a dialog's alike, its chevron 8px after
the last word. In a
narrow row the title gives its width up first, down to 64px; then the name
truncates, and the effort never does. The agent detail leads its numbers line with the same `ModelLine`, then
the host and branch; queues use `effortWord` for effort names. A right
panel Agents row says its model on a line of its own under everything else (`ModelLine`): the logo,
the name, the effort and the context window ("Opus 5.5 High 1M", "Sonnet
5.5 Low 200k"), each 4px from the next, only the name truncating. The
tooltip is the uncut form ("Claude Opus 5.5, high effort, 1M context"),
the one home of what a narrow row hides; on an Agents row it is the row's
own tooltip, since the row's open control lies over the line.

While any subagent of the thread on screen is live, the title bar's end
group holds the agents cue (chrome/AgentsCue.tsx), a quiet 24px row
control: the loudest state's glyph, one 12px mark per distinct provider of
the live agents, each drawing once (Muse Code draws Meta's symbol, since
Meta publishes no Muse mark, so it and a Meta model share one; at most
four, then "+N"), and "3 agents", or "1 needs you"
in amber while one waits; the line "Agents: 1 needs you, 2 working on
Claude Code and Codex" is its tooltip and name. It keeps the one-moving-mark rule: while the thread's own
turn runs (its tab and working line spin), the cue draws working's still
dot, and it spins only while the thread watches or idles. It fades in on
`--dur-fast` `--ease-out` and leaves at once, so no dead control stays
under the pointer.

While a computer session this desktop can draw is live in the thread on
screen, the computer cue (chrome/ComputerCue.tsx) sits after the agents
cue, the same quiet 24px row control: the state's glyph (working's still
dot, since the thread's own turn spins; the amber mark while a card
waits; the dashed ring while a step is held), then "Using TextEdit"
("Using 2 apps" while sessions work in several, so the words hold as
they take turns), or "Needs you" in amber, or "Waiting for the Mac"
(plain "Waiting" for a hold that is not for the Mac). Its tooltip and name are
the plain form ("Computer use: Clicking Save in TextEdit"). A click opens
the panel on Computer and, pressed, closes it. It fades in as the agents
cue does, its words morph, and it leaves at once.

## Panels, modals, menus, popovers, sheets

The right side is one panel, one width (320px, resizable), one header, with
sections that exist only when they have content (Agents, Activity, Computer,
Changes, Notes) and a 40px header of flat icon buttons, the selected one filled, that
lists only those sections, each named on hover and by its accessible name;
its default section follows the thread's state, Agents first. An Activity row, folded, is one 28px line
of plain words (glyph, label, age, Stop); one that opens (a shell's log, a
dev server's pane) has its open control laid over it with Stop beside it,
as every row with controls of its own; a shell's command shows only in
its fold, as the first line of its output, one `CONSOLE` capped at 240px
whose first read draws skeleton lines in the same box. The panel's header
draws its segments 24px wide with no gap when they would not fit at 28px
(`sectionsCompact`: eight sections in a 260px panel).

Computer use has a section of its own, on the Mac's desktop, while a
session is live and after it as the thread's history ("The Computer
section" below). Where this desktop cannot draw the session, it is one
Activity row: the window in the app it used last ("Untitled in
TextEdit"), then the tier of its last action 4px after it in 12px muted
(`COMPUTER_TIER_WORDS`), opening in place only for a card waiting on the
Mac or a held step (`ComputerLines`).

#### The Computer section

A column on the panel's 12px inset with no card, border or header bar of
its own. The step list is the section's scroller and keeps a 64px
floor; only when more live sessions stand than a short pane holds do
the session rows and the box scroll, above it, so no Stop and no step
is out of reach.

- **A session row** (36px, one per live session, none once the turn
  settles): the `SquareMousePointer` glyph, the window in its app,
  truncating, then Go live (a ghost `xs` button, drawn only while a step
  is pinned) and Stop (the Activity row's ghost icon button; with several
  sessions each is named for its session). The session the viewport
  follows is the row right above the box, the others above it in the
  order they began, so a picture is never read as another session's;
  while its stream is live that row and the box go by the window the
  stream says it is of (the stream and the session's row are two pushes
  that land in either order). It
  stays followed while it works and for five seconds after its last call
  (`followedSession`): two sessions taking turns never swap the rows or
  the picture after every call; then the look goes to the one at work.
  The running lines keep that order too: the followed session's first.
  A line names its app with several sessions, and when its call is on
  another app than the one its session read last (the row and the
  picture stay with that one until the session reads again).
- **The viewport**: a box at the pane's width less 24px in the picture's
  shape, at most `min(400px, 45cqh)` of the section (a tall pane gives
  the window room to be read; a short one keeps its list), on the `card` fill
  with `rounded-lg`, the picture centred in it on the `image-outline`
  edge, a `Skeleton` in its shape until the first picture (and again
  when the stream moves to another window or the section follows
  another session, until that window's own first frame: the last
  picture is never shown as the new one's). A window that changes shape
  under the stream is drawn in its new shape: the box takes the frame's
  own. It shows the
  live stream (video where the host has it, else the 4 fps picture; the
  box looks the same either way, and nothing says which), or a pinned
  step's kept picture (a click opens the lightbox), or the text the model
  read in a `CONSOLE` of the box's shape, or nothing. A live picture is
  never stretched: its box is as wide as the pane and no wider than the
  frame's own pixels on this screen (`sharpOf`), on the pane's inset. A
  click on a live picture that has drawn opens its full view ("Computers",
  below); there is no button for it. While a step is pinned the box keeps its height: a
  picture of another shape sits centred inside it, and a step that kept
  nothing holds the box with its line inside ("This picture is no longer
  kept"), so stepping through rows moves nothing. One 12px muted line
  sits 4px under the box only when it has something to say: why a preview
  ended; "After all 3 steps" (or "After the steps that ran") for a
  batch's earlier step, or one that never ran, after the reason there is
  no picture where there is one ("Screen Recording was off. After all 3
  steps"); "As it was after this step" for a step pinned
  while a session is live ("Inbox in Mail, as it was after this step",
  "Inbox in Mail, after all 3 steps", where it is not the window that
  session is in now); "As it was at 2:03 PM" where the newest step
  kept nothing and an older picture of its session stands in (another
  window's is named: "Inbox in Mail, as it was at 2:03 PM"); and
  "Couldn't read the picture" with Retry when the read failed, which is
  never said as nothing kept. Under a preview that ended the kept
  picture is that session's own newest (another session's, where it has
  none, is named), a still beneath a live session's row, so its line
  always says when it was ("The window closed. As it was at 2:03 PM"), and a failed read
  sits beside the end's words with its own Retry. The
  box fades in once, when the viewport arrives; a change of face moves
  nothing.
- **A step row** is on the transcript's step grid (`STEP_LINE`,
  `GLYPH_SLOT`; 28px): a 14px glyph for the step's kind (click, type,
  key, scroll, read, look, wait, app), uncoloured, the verb muted, the
  object in foreground. A state takes the glyph's place by `SwapIcon`:
  working's still dot on the running row, the amber mark while a card
  waits, the dashed ring while held, the red mark on a failed step, the
  square on a stopped one (the person's own no, a pause and a cancel are
  stops, never the red), a dash on one that never ran, which is also
  muted whole. A row
  names its app only when the step before it was in another app. Hover
  and press are `ROW_PRESS`.
- **The running row** is one line; a batch's planned steps, one a line,
  and what a held step waits for sit under it in 12px muted, each as what
  is asked ("Click To", "Press ⌘Return": the words its rows settle into),
  and a held line or a card's question wraps whole, never truncates.
- **The open row** is the `muted` fill behind the row and what opens
  under it (8px radius, `aria-current`), with no height animation. While
  the section follows it is the newest step with an outcome: after a
  batch that failed part way, the step that failed, brought into view,
  not the last of the steps that never ran. A row's accessible name adds
  how it ended ("Click Save, failed"), since the mark is drawn. Under
  the words: a 12px line saying why, for a step that did not end well
  (red for a failed step, the one red; foreground for a stopped or
  unfinished one; muted "Not run"); a facts line (the tier's
  words, what it acted on, how it went, its time (with its day when that
  is not today, "Nov 3 2:03 PM": no comma of its own), as one comma
  sentence that wraps as text does, a long unbroken word too, the time
  kept whole, so a narrow panel never puts a short fact on a line of its
  own); and a read line
  ("46 elements" after a read row, "Read 3 changes" after an act; a
  batch's read sits on the last step that was tried) whose
  chevron trails its words and opens the text in a `CONSOLE` capped at
  240px, the acted element's lines in foreground. Opening it pins the
  row, so the text stays while more steps land; where the viewport
  already shows that text, the line says what was read and opens nothing.
- **Groups**: one turn of one session, 16px apart under a 12px medium
  muted heading, the clock time of the turn's first call. The newest group has
  no heading unless it is a subagent's, whose title says whose steps
  they are.
- **Following and pinning.** With nothing chosen the section follows the
  live end. A click or a key pins a row: the viewport shows that step's
  picture and the stream stops. The list is one tab stop: ↑ newer, ↓
  older, Home the live end, End the oldest loaded. Rows that land above a
  pinned row do not move it. Following, a list at its top stays there as
  steps land and as a call's running line starts (where the list's own
  reveal of a failed step left it counts as its top: the next call is
  followed); one the person scrolled holds the row they read from, the
  list moving on by what lands above it (the browser's scroll anchoring
  is off, so the list does this by hand, as for a pinned row), and so
  does a page of earlier steps they asked for.
- **Loading and failure**: skeleton rows in the rows' shape while the
  first read is out; one red line, "Couldn't read the steps", with Retry,
  above whatever steps are there.

The panel's other
logs (Build, the Debug console) keep the console's 20px lines. It yields to the thread, which never
goes under 360px beside it. It is a docked column, not a drawer or
a sheet, and it never animates its width: the thread takes its width at
once and the pane slides in from the edge or back out over it (the motion
table). The bottom dock holds the terminal and the dev servers
pane. Nothing else floats at the side of a thread.

A modal (`Dialog`) is for a form, a CRUD action or a decision that needs the
whole screen's attention; it never holds a list that could be a panel. A
confirm (`AlertDialog`) is for destructive, irreversible actions only, with
one title, one line and two buttons; code that must ask first awaits
`useConfirm()` (chrome/ConfirmDialog.tsx), never `window.confirm`. A
confirm never holds a checkbox: a destructive decision with options is a
form `Dialog` with its `CheckRow`s and the red verb in its footer (Delete
project with cleanup or other copies). An archive is red only while a box that
removes something from disk is ticked (worktrees, simulators, a project's
cleanup); archiving alone loses nothing, so its verb is the primary. A thread's resources are a removal
form of that kind; its dev servers live in the Activity section and the
dev servers pane, never in a dialog.
Every form or decision dialog has one shape: `Modal` (or `ModalPanel` when a parent holds it open), `ModalBody` and `DialogFooter`, whose `start` slot holds a quiet verb (Remove override, Delete) and whose children sit between Cancel and the confirm; `lib/dialogShapeGuard.test.ts` refuses a bare `DialogContent`, ui/dialog's `DialogFooter` or AlertDialog's content, header and footer outside the shells (ConfirmDialog, the pickers, the lightbox, the page viewer). A confirm's verb plays the exit too: `useConfirm()` answers at the click and drops its dialog after the exit, a `ConfirmDialog`'s `onConfirm` returns the work's promise (its rejection is the dialog's red line) and its required `onDone` runs once the exit has played, the verb spinning through it, so the caller clears its state there and never in `onConfirm`; a confirm whose work removes the thing it names (an account, a note) is held by that thing's owner, never inside the row it removes; and the first close a dialog starts wins, so a Cancel during that exit never replaces the verb. `chrome/Modal.tsx` and `chrome/ConfirmDialog.tsx` are thin shells on
`Dialog` and `AlertDialog`, and every form dialog has their one shape:
`Modal`, `ModalBody` and `DialogFooter`, 448px or wider, a hairline over
the footer, Cancel then the verb, an action of the dialog's own at the
footer's start; a field's label is `Field` over it, a choice a `FieldRow`. A sheet is for a long form or picker
that would not fit a dialog. A menu (`DropdownMenu`, `ContextMenu`) is
verbs; a popover is content (a picker, a preview, a list of accounts). A
menu's rows are `MenuRow` data rendered by `RowsMenu` (from a trigger) or
`RowsContextMenu` (one per list, at the pointer), each row a 14px glyph, a
label and the key cap of a real binding (`shortcutFor`); the window's menu
bar alone is words and keys. Menus come in one size: the row of "Spacing",
in the dropdown and the context menu alike. A thread offers the same rows on every
surface (lib/threadMenu.ts). Menus and popovers load with their first use,
out of the first paint (chrome/menuRows.tsx). A label on hover is `Tip` or
`TruncateTip`, never a `title=`. `TruncateTip` mounts no tooltip trigger
while its text fits; it checks the element and any truncating text inside
it on mount, text changes and resize. Activity labels, fleet goals, home
titles and split-view titles all use it. An Agents row's title and status
line are measured the same way (`useTruncated`) but feed the row's one
tooltip on its open control, which says what a line cuts with the model and
its role, never a tooltip of their own (surfaces/threads/fleet/AgentRow.tsx). A
popover scales from its trigger; a menu scales from its trigger; a context
menu fades at the pointer; a dialog rises 4px and fades; a sheet slides 16px
from its edge. Every one of them exits in `--dur-fast`, back a quarter of
the way it came, and keeps its direction. Under reduced motion they cross-
fade in `--dur-fast`; nothing appears in one frame.

A page (Settings, Accounts, Stats) is `Page`, `PageSection` and `PageRow`
from `components/page.tsx`: a 672px column with a 24px inset (a page that
is a table, Accounts, takes `width="table"`, 1,152px, and lays its rows as
columns from 48rem of its own container, stacked under it), one 16px
semibold title with a 12px muted line under it, sections 24px apart, each
under a 12px medium muted heading with 8px to its first row, rows 12px top
and bottom with a hairline between neighbours and never a box. The title
line holds one ghost small button, the page's verb alone ("Add…", "New
skill…"), with no icon and nothing else beside the title; any page fills it
from inside through `PageActions`, and the 28px button overhangs the title's
24px line by 2px each side. A row that opens something (its edit dialog)
takes `onOpen`: an open control named `openLabel` lies over the row, its box
hovering 8px past the words, and the switch and ⋯ at its end sit above it,
so pressing them never opens the row. A row's
control is one `Switch`, one `ChoiceSelect`, one `Input` or one `Button`;
a row whose control is a wide field (`PageRow wide`, Hosts' Public origin)
lays it on a full-width line 8px under its words once the page's content is
under 480px, its error 4px under the field and its skeleton the same, so the
words never thin to a word a line;
a loading value is a `Skeleton` in its shape, an error a red 12px line
under its row. A section loaded from a host waits for the socket to open,
asks again on every new socket until it has answered, and past 10 s says
"The host did not answer" with Retry (on the section's heading line, or at
the end of the error line itself, `PageError`'s `action`, in a section with
no title, never alone on a blank heading; lib/connection/openRead.ts; a page's
own read is `useHostRead`, lib/connection/hostRead.ts, and a store's scopes
keep the same rule: plans, rules, thread defaults); a late answer still
lands. A failure never stands in as a value: no "Not installed", "No JDK
found", Connect… or empty field the host did not say, and a field that saves
stays away until its value has loaded. A row with a second action gives it its own row or
opens a dialog: Linear's key field sits behind Connect…, and the release
notes are a row under Release, whose one button is the updater's. Switching pages does not animate.

Escape belongs to the innermost layer. A page (Settings, Notes, Inbox,
Search) closes on Escape only through `usePageEscape` (lib/pageEscape.ts):
a dialog, a confirm, a menu, a select or a popover above it takes the key
first, and a focused field lets go before the page closes (Settings puts
the field's value back, Notes and Inbox keep the text; Search's one field
is the page, so Escape there closes it).


#### Computers

Every computer being driven now, on every connected host, in one place
(`surfaces/ComputersView.tsx`, `lib/computers.ts`).

- **The rail's row**, "Computers", in the navigation group after Inbox and
  the Outbox, in every workspace. It is always there. Its trailing mark is
  the still working dot while anything is driven and the amber waiting mark
  while a session's card needs him; it never carries a count. Go →
  Computers, ⌘⇧L.
- **The page** covers the thread area as the Inbox and the Outbox do, on
  their 40px header (the `Desktop` glyph, "Computers"), with nothing at its
  end. Closing it returns
  him to the thread he left. To keep one computer in view while he works
  he pops it out: the one thing in the app that floats, because he asked
  for it.
- **The stage.** One computer has the page (`ComputersPage`, the layout
  in `lib/stageLayout.ts`). Its picture fits the room left by a 16px inset
  and the caption, both ways, in its own shape, at the top of the room and
  centred across it; it is never drawn past twice the stream's own pixels,
  so a small window stays small instead of turning to blur, and grown past
  them it is drawn at a whole number of screen pixels to each of the
  stream's (1:1, 2:1) when that costs at most a fifth of its width
  (`fitStage`). It takes the
  box's one display and is where he drives.
- **The strip.** Every other computer is a live tile beside the stage, 176
  to 240px wide, 16px from it and 16px apart: its picture, its thread's
  title (13px medium; the amber waiting mark before it while a card waits
  on him) and one 12px muted line. The strip goes under the stage, two
  across, when the page is narrower than 640px. The page never scrolls
  sideways. A strip tile has no buttons: the whole tile is one press, and
  it puts that computer on the stage. A strip tile never takes the box's
  one display: it plays video where a stream is free and the 4 fps picture
  where it is not.
- **Which one has the stage.** His press, until that computer leaves. With
  no pick, the one that has it keeps it; when the page opens with none, the
  one a card waits on, else the one that acted last. Nothing moves to the
  stage by itself while he watches. The swap is at once, with no motion:
  every tile is one element in one grid, and only its place changes, so no
  picture is made again and no stream is opened again.
- **The caption** is one row under the stage's picture, 8px under it and as
  wide as it: the thread's title (13px medium; a press closes the page and
  goes to the thread) over one 12px muted comma sentence, what it is doing
  in the step's own words, then where it runs ("Clicking Save in TextEdit,
  Landon's MacBook"). While he drives the first words are "You are
  driving", in foreground. While a card waits on him they are the card's
  question, in foreground, and where it runs follows with no comma. At the
  row's end, always shown and never behind a hover: Take over (secondary,
  only where the computer takes input from its picture: the box's browser's
  page and the Windows VM while it has its window; a Mac's or a PC's own
  window has none, and neither has the VM with no window, `pictureOnly`) and Stop
  (a quiet icon button with a tip; none on an idle page). While he drives,
  Hand back alone, the page's one primary button, with the chord that
  leaves the picture as a key cap inside it; on the Windows VM one quiet
  Keys button before it (a ghost icon button with a tip, 4px apart) opens a
  menu of the keys his own keyboard keeps: Windows key, Ctrl+Alt+Del,
  Alt+Tab; a pick gives the keyboard back to the picture. Take over gives
  the picture the keyboard as soon as it is his. No toast says the leave
  chord here: Hand back already wears it. While he drives, Escape is the
  computer's key and never closes the page. Leaving the page with nothing
  else of his showing that computer (no full window, no pop-out) hands it
  back by itself 1.5 seconds later (lib/driveHold.ts).
- **The picture** is the Computer section's viewport with no cap of its
  own (`fill`): its place sizes it. Every face it has (the live picture,
  the waiting box, the stopped line) takes one size: the stream's frame,
  else the last frame that window saw of that computer, else the VM's
  1280 by 800, through the stage's fit, so nothing moves when one gives
  way to another. While the host's link is down it is the waiting box,
  a spinner and "Reconnecting to The box", and no stream is asked for;
  "The preview stopped" and Retry are for a stream that truly ended with
  the host linked. A skeleton until the first frame; a
  click on the stage's picture opens the full window. A session this desktop
  may not draw is one muted line in the box's place, naming the machine:
  "Shown on Studio only". The browser /ui lists the tiles with no picture
  at all.
- **The Windows VM** is one tile in every state, titled by the thread that
  holds it, or "Windows VM" when no thread does (then idle: no Stop, no
  working mark). Its picture is the VM's own under its name, whichever
  thread holds it, so the tile stays one element as the holder changes and
  as it sleeps and wakes. While it is not awake its box keeps the picture's
  16:10 at the size the picture will have, so nothing moves when it comes,
  and says its state once, in the box, centred, 12px muted
  (`RestingVmPicture`): on the stage a VM asleep or going to sleep wakes by
  itself, with a spinner and "Waking the Windows VM" until the picture
  arrives; in the strip "Asleep", and his press puts it on the stage, which
  wakes it; "Not set up: Settings → Work → Windows VM" with no Take over; a
  failed wake says why, with Retry. Take over on a VM that is not awake
  wakes it and then takes over: one press. It has no Pop out or Full window
  until it has a picture.
- **Nothing driven** is the one `EmptyState`: "Nothing is being driven",
  "A browser or an app an agent is using shows here, live." No action.
- **Full window** (`FullWindow`, lib/fullWindow.ts, its own chunk): the
  stage with the rail and the header gone, over the whole window on the
  `stage` ground (the ground under a picture; `matte` is black in both
  themes and no text reads on it in light). One computer, its picture as
  large as the window allows less a 16px inset and the caption, in its
  shape and never past twice the stream's own pixels, centred both ways;
  the stage's caption under it, with Leave full window (a quiet icon button
  with a tip) after the controls. The caption fades over `--dur-base` two
  seconds after the pointer last moved and comes back when it moves, or
  with keyboard focus in it. Escape leaves when the picture does not hold
  the keyboard; a double click on the picture leaves when he does not
  drive. A click on any live picture (the stage's, the Computer section's,
  the browser canvas's) or the stage's Full window button opens it; the
  lightbox no longer shows a live picture. It is another canvas on the
  stream the place already plays, never a second stream.
- **Pop out** (`PopOut`, lib/popOut.ts, main's popOut.ts): a small
  frameless window over every app, every Space and every workspace, with
  no place in the Dock: the picture filling it and one 36px bar under it,
  which is its handle: the title (12px medium, truncating), Take over or
  Hand back (xs) and Stop where the stage has them, then Back to the page
  (the Computers glyph) and Close, quiet icon buttons with tips that open
  in its own window. It opens without taking the keyboard, at 384 by 276
  the first time and where he left it after, keeps the picture's shape as
  he drags it to a size (no smaller than 240 by 186), wears the main
  window's styles and theme and follows a change, and closes when its
  computer leaves or the main window closes. Back to the page brings the
  main window in front with that computer on the stage. The main window
  draws it, on the stream it already plays: it is never a second stream.
  The stage's caption opens it (Pop out, before Full window).
- **The Windows VM in Settings → Work** (`WinvmSection`, work/winvm/): a
  section of its own on each Work host that can have the VM (a host that
  cannot shows nothing). Its first row, "Windows", says what the machine is
  doing in a few words ("Not set up", "Asleep", "Awake", the keeper's step
  while it works) with the one press that fits, secondary: Set up, Wake or
  Sleep, spinning while the keeper works; a failure is the row's red line.
  Once set up: "Sleeps after" (15 minutes, 30 minutes, 2 hours, Never),
  "Screen size" (1280 × 800, 1920 × 1200; "Used when the VM is set up again" under it,
  since Windows keeps the size it was set up at through every sleep),
  "Restore points" (a row that opens a dialog of the points, newest first,
  each with Go back… after a confirm naming what is lost, and Delete; Save
  a point at its foot; saving and going back only while it sleeps), the
  edition with its end date, and Office. A Work workspace's own page has
  "Computer use on the Windows VM" under Where it runs, a switch shown only
  where its host has the VM set up.
- **Nothing says "live".** No mark, no frame counter, no quality menu. The
  video is never eased or blurred; ours is only the first frame's arrival
  and a tile's entry.

#### The canvas pane

Every kind's body is built on the pane's frame (the tab row, the kind's
bar, the fold, the review stepper, the selection bar and the composer's chip
row); the slides kind's PowerPoint side alone says "Not built yet". A sheet's
chart axis is 12px, not the prototype's 11px (the type scale allows 11px only
for key caps and menu labels). Around the canvas, the Outbox, Back from Away,
routines, house rules and Settings → Work are built to the rules below, but
for the routines' week grid, which is not.

A Work thread opens an item (a mail, a document, a sheet, a PDF, slides,
an image or a video, a live browser, a compare or History, a meeting, a
form, a dashboard) in the split view: the item on the left, the thread on
the right, never under 360px, one conversation toggle that folds it away
(docs/LAYOUT.md "The canvas pane"). Help inside a canvas is always the
thread; nothing answers inside the canvas.

- **A file from outside** (a drop from the desktop, Open file… in ⋯, the
  File menu's Open File…): a Work thread's or Work draft's pane takes a drop
  anywhere but the composer's box, and a Work view (Docs among them) anywhere.
  While a file is over such a place, the place it will show in draws the
  document surface's wash (`muted` 70%, 12px inside, a hairline, 8px radius,
  one 13px muted line, "Drop to open"): the canvas when the thread has items,
  else the pane. Nothing moves while a file is dragged. The composer's box
  keeps its own wash and its meaning (attach), and a surface that takes files
  itself (a document, an empty meeting, Mail's composer) keeps its own. While
  the file goes up the pane says "Opening <name>" beside the spinner, with a
  4px bar once the file is 4 MB or more and a ghost Cancel: centred in an empty
  pane, else a 36px row at the canvas's foot under the item; nothing else says
  it. A file no kind shows is one toast, "No viewer for <name>", whose one
  action is Add to the thread as a file.
- **A file opened from the Files view** is the item, not a chat: it opens
  in its viewer with the thread folded away, the conversation toggle one
  press away, and no empty composer first; opened again, it shows in the
  thread that already holds it. Before its first message the thread's half
  is its one muted line over the composer, as any thread with no rows.
  An item whose viewer fails says so on the state line with Retry
  ("Couldn't open this document", why), never a blank pane.
- **The tab row** is 36px on `sidebar`, as the title bar's strip: tabs
  28px on the strip's chip shape (6px radius, 2px apart, 6px from the
  row's ends), the kind's 14px glyph, the name, no dirty dot; the selected
  tab is `muted` with foreground text. One item alone is its glyph, its
  name as the split view's 14px semibold title and one 12px muted fact.
- **The kind's bar** is 32px on `background` (the editor's `FileHeader`
  row), 12px muted, in a fixed order: other people as 20px avatars, the
  mode ("Agent suggests" or "Agent writes", a quiet menu button), the
  kind's own tools, Download and Save to workspace (a copy of someone
  else's file: a mail's attachment), History, then the review stepper at
  the end. A kind
  with nothing to put there draws no bar. The agent suggests on what
  other people can edit and writes, with history and Undo, on what only
  the person sees; the mode says which.
- **The review stepper**: Previous, "2/6" tabular, Next, Reject (ghost),
  Accept (secondary). It is the one place to accept or reject inside the
  item; Accept all and Reject all live in ⋯, under the kind's own verbs
  on the item (Export transcript, Download recording), each row a glyph
  and a verb. The current change is
  outlined. A move counts as one change, tinted where it lands and where
  it leaves. After a direct write the stepper's slot holds the settled
  line ("Wrote 2 sections, 2:04 PM") with Undo.
- **A mail's attachment** waits for the host's copy in the document's
  bones; from a megabyte, the first line is a 4px bar with "2.1 of 8.4 MB"
  in 12px muted tabular figures beside it. A failed fetch is the kind's
  failure (`Couldn't open this PDF`, the sentence, Retry). A mail's file
  of any kind is read only until it is kept: its bar draws no mode, no
  stepper and no History, only the kind's reading tools, Download, Save to
  workspace and ⋯; a document also has no Share, and Keep as document in ⋯
  makes it his. In the Mail view
  the reader's half holds the items at the left and the mail at the right,
  the toggle a Mail glyph named Mail.
- **The state line** is one line across the surface for a source that
  cannot be reached: glyph, a medium word in its tone, a muted detail, one
  action, 32px, a hairline under it. Never a second banner.
- **The selection bar** floats over any selection in any kind, on the
  transcript's selection menu recipe (surfaces/TranscriptSelectionMenu.tsx):
  the popover fill at its 12px radius, a 4px inset and 24px ghost buttons
  at the 8px radius, so it is 32px tall. Ask comes first, with ⌘L (Ctrl+L
  off macOS), then the kind's own controls. Ask puts the selection in the
  thread's composer as a chip.
- **A chip in the composer** says what a message is about (a task, a
  mail, an event, a selection: "p. 6, clause 7.2", "0:42 to 1:05, trailer
  v3.mp4"): 24px, the `muted` fill, 6px radius, a 12px muted glyph, the
  label at 12px, a 16px remove control. The chips are a row of their own
  inside the composer's box, over the field and under any attachments, 4px
  apart, 8px from the box's edge. A chip alone can be sent. `@` offers
  Work's things in the composer's one list: each kind a group under its
  quiet label (Tasks, Mail, Agenda, Projects, People, Documents, Items,
  Outbox, Routines), a row its 14px glyph, the label, one muted fact and a
  time at the end; they lead the list in a Work thread. A pick is a chip,
  never text. The sent bubble draws its chips the same way over his words,
  4px apart and 8px above them; one that opens something takes the hover
  fill and presses to 0.96, one that does not is a label.
- **Avatars** are initials on `muted` on `image-outline`, 20px in the bar,
  24px in lists, overlapping 6px with a 2px `background` ring.
- **Share** is a 320px popover from the bar (rows 28px or more, Revoke
  shown on hover); **History** opens the item's history as a tab of its own
  ("Compare and History" below);
  Export is a dialog with one choice (the format, a `FieldRow` with its
  select; one muted line under it only when comments or suggestions stay
  behind or go with it). A file dragged over a document's surface draws a
  `muted` wash 12px inside it with a hairline and one 13px muted line
  ("Drop to open as a document"), then the spinner and the file's name
  while it opens (work/formats/Import.tsx). Open from Google… is a row of
  the frame's ⋯, above Close; its dialog is Export's shape with one choice,
  the account, and Choose files shows Google's Picker in the browser. A
  Google Doc's own verbs (Write to Google, Read again from Google, Open in
  Google) come first in its ⋯; that Google moved is said once, in a toast.

The kinds, each a hand-made body built from components/ui:

- **Mail.** The kind opens a draft; the mail it answers sits above the
  composer. A waiting rewrite replaces the composer with a read-only diff
  of the two, and the stepper in the bar takes or leaves it: the draft
  never changes until he takes it. Send goes through the Outbox's press.
- **Sheet.** A selected cell or range is the 2px `accent` outline, the one
  place the focus ring marks content; the range fills with `sel-bg`, and
  its row and column headers take `muted`. Another person's cell is their
  presence hue as a 2px outline with their name on its right edge. A
  change is one cell or one run of neighbours. Columns keep the file's
  widths and scroll; a number never clips. A sheet's chart object is plain
  bars on the neutral. A Microsoft-hosted file has a switch in the tab row
  beside ⋯ ("TempCode", "Excel"); the hosted app then fills the body edge
  to edge and our formula bar and sheet tabs go.
- **Document.** The shared block editor in a 672px measure, a 52px
  leading gutter for the block handle, a 24px glyph rail in the trailing
  gutter when 24px is free, and a margin column (24px gap, 272px card)
  from 1104px of canvas; under that the outline wins on a long document
  and the cards go under the text. The margin cards hold comments; a
  change is accepted only from the bar's stepper. The agent's words arrive by `REVEAL`. Underline and
  Strikethrough leave the selection bar under a 520px text width.
- **PDF.** Paper on `stage`, 12px between sheets, a 24px side inset (12px
  narrow), fit-width zoom from 0.5 to 1.25, a 232px margin column 16px
  off, a 76px thumbnail rail (60px narrow). Margin notes are 13/20 muted,
  foreground when picked. A citation in the thread ("p. 6, clause 7.2")
  is a link that scrolls the page and marks the clause with `sel-bg-paper`.
  A field the agent fills is a suggestion; signing is never the agent's.
- **Slides.** A 96px thumbnail in a 140px strip, a 3px tint frame at 6px
  radius round a 3px-radius slide, the stage at most 760px with a 16px
  inset, a four-column grid at 12 by 16 gaps, a 164px outline preview.
  Notes under the stage are 14/22 under a 12px medium muted "Notes". The
  TempCode and PowerPoint switch sits in the tab row, as the sheet's does.
- **Images and video.** The frame at radius 8 on `stage` with a 12px
  inset; the scrubber a 24px hit row with a 4px `track`, a 12px head and
  2 by 6 ticks in `success`; the transport 32px; list rows 32px or more on
  a 36/20/1fr grid; a side list 240px, under the body below a 600px body.
  Ask on a stretch or a region chips "start to end, file" or "Region of
  file". The transport has a Comment button that notes the frame shown,
  with no selection; an image region's selection bar has Comment, not
  Copy. Two versions compare inside the item, side by side on one
  transport, chosen by two pickers in the bar, never as a compare tab. A
  note for a shared review service is a suggestion here and a held "Post
  on …" in the thread, never a canvas button.
- **Meetings.** A 40px player row with a 24px wave; turns 8 by 12 inside,
  radius 8, 2px apart; topic rows 13 medium on 36px with 12px tabular
  times, an open topic inset 34px. Tasks found in a recording are
  suggestions at their turn; Accept files them in LifeOS. A recording
  that fails keeps its player; the empty kind offers one Choose a file.
  Once notes exist, a Notes and Transcript switch leads the body. Find
  sits after the mode, and the mode is the fixed text "Agent writes".
  An unnamed speaker's first turn says "Sounds like <name>" when a kept
  voice matches; naming a speaker offers Use and Forget this voice.
- **Live browser.** The Computer section's viewport rules in the body:
  the page as video, as wide as the body and no wider than its own pixels
  (the box's page, 2560 by 1600 pixels, is 1280 points wide on a 2× screen), on the
  body's inset; a held submit's kept picture takes the same frame, so the
  two swap without a jump. A click on the live page opens its full view.
  The 4 fps picture, shown where video is not to be had, is a copy the
  host scaled down (960 on its long edge at most): it is drawn up to its
  width in CSS pixels, not held to its own pixels as video is, or on a 2×
  screen it would be half the width the video has.
  While he drives, the page is his keyboard and wears the focus ring for
  as long as it holds it; Tab and Escape are the page's, and Ctrl+Alt
  alone (⌃⌥) sends the keyboard to Hand back. One toast says so, once a
  launch: "Press ⌃⌥ to leave the page".
  Its bar holds the host (12px foreground, a lock glyph, never a
  field), who drives (12px muted, foreground while the person drives) and
  one verb, in place of the mode. Where it runs is said once, after the
  page title in the tab row ("Landon's MacBook"). A held submit ends the
  bar in the one primary named for the act ("Submit in Arbiter") with
  Discard as a ghost, and never counts down. The agent never types a
  password.
- **Form.** Its two halves are a 24px segmented switch after the mode.
  The bar ends in the stepper while changes wait, Publish (the one
  primary) while unpublished, otherwise the live link in `accent` with
  Copy and Close form. Publish is held, since it shares the link; Close
  form and Reopen are not. Answer bars are `chart-neutral`, 8px tall,
  square at the base and 4px round at the end, the count beside them in
  muted tabular text.
- **Compare and History.** A compare is read only: its bar has no mode,
  its tab is named for the item and the versions once, in the pickers.
  Side by side is the default from 420px a side. The list's rows are
  13/20, the time 12 muted, a section heading 13 semibold with its count
  12 muted. A compared table keeps its full cell grid and filled header:
  a change is a cell, so each cell needs its edge; it is the one table
  that does not use row hairlines. A restore on a shared item becomes suggestions, and the mode
  button says so.
- **Dashboard.** Figures, one chart and flat tables. A figure opens its
  source (sheet, range, the formula in words). "As of" is said once, in
  the bar. A new block is a suggestion even on the person's own
  dashboard.

Around the canvas:

- **The Outbox** is hand-made on the split surface (the Inbox frame): a
  held act's payload (the plain-text body, the attachment pill), a verb
  bar whose split primary's menu makes a grant, grants as a sheet. A
  computer-use act names the Mac and says it "takes its screen for a
  moment", and its Sent record keeps a picture. "Sent mail cannot be taken
  back" stands in for a way back. The right panel gains Results (the
  `outbox` glyph, two groups). The page is the split view only. Send's
  toast has no Undo: the host sends on the press, and the toast says what
  happened; a press decided elsewhere says so ("Already discarded"). The
  transcript's held line opens the Outbox page. In the grants sheet, under
  each workspace's heading, a grant's line is "Made today from a held
  mail". Each kind draws its own payload view; a kind with none gets the
  generic one (a mail's headers and body, a call's arguments).
- **Back from Away** is one toast ("Decided without you in 4 threads";
  with Work on, "Held 7, decided 4 without you") that offers Review and
  stays until pressed. Review opens "Decided while you were away": one row
  per thread with its count and Open, since the host counts decisions per
  thread and keeps no choices; held items are the Outbox's.
- **Routines.** The week grid has 36px rows with hairlines, 12px muted day
  heads (today's foreground medium) and a 6px `run-dot`; past runs use the
  status marks. A trigger is always plain words ("Weekdays at 7:00 AM",
  "When Dana Lee changes it"), never a tag; a watch's row ends "until
  <day>" or "once". The status slot shows Watching, Paused, Failed or
  Working, and nothing for an idle routine. Only the list view is built;
  the week grid and "By what starts it" are not.
- **House rules** is a section of the workspace's own settings page
  (the page's title is the workspace's name), not a page of its own: a
  rule belongs to the workspace it came from, so its dialog has no
  workspace select. It is a list of one-line `PageRow`s that open, a
  `Switch` each, a grip in the 24px gutter on hover; past 12 rules a Find
  `Input` over the list, its matches in `sel-bg`, reorder off while
  filtered. A proposal row is the sentence, then "from N edits" as its
  muted line, with Dismiss (ghost `xs`) and Add (secondary `xs`): the one
  row with two buttons. An edit's evidence is one paragraph with its
  removed and added words tinted, 13px (14px in a dialog). The
  proposal line is a muted 13px line under the sent mail, in the mail
  canvas where he pressed Send ("Add rule…", "Reword…", "Not now"); after:
  "Added to <workspace>'s rules" with Undo.
- **Settings for Work.** The settings list gains a Work heading after
  Threads: the Work page, then each Work workspace led by its sector's
  dot. A grant row is the dot (on mixed lists only), the grant's name and
  "<workspace>, made <date> from a held <kind>" as its muted line, with
  Remove and no confirm. With the switch off, the Work page is the switch
  alone. A Work workspace's sector is shown, never edited. Models is one
  row that opens Thread defaults. "Where it runs" names the host new Work
  workspaces are made on (only with two or more hosts with Work on) and
  each host's conversion tools; computer use is one switch per desktop
  host on each workspace's page. A section that needs an account the person is
  signed out of shows one muted line naming the sign-in ("Sign in to
  LifeOS to …"), never disabled controls.
- **The Mail view** (work-kit's mail client, shared with LifeOS, on
  TempCode's scale; docs/agents/work-mail.md). The view has no header of
  its own: the list's 44px head is the page's. The list is 296px (260 to
  480, kept), the reader beside it; at and under 640px of view they take
  turns, and the reader's toolbar leads with the way back.
  The head holds the mailbox (13px semibold, its unread count muted) on a
  menu of all ten, then Filter and New mail as quiet 28px buttons, the
  same in every mailbox; under it the 28px search field, and one muted
  12px line when the network or an account's sync is down.
  A row is 68px (48px in two lines) at radius 6, 1px apart: a 20px gutter
  for the 6px unread dot, which gives way to a 14px tick box under the
  pointer and on every row once one is ticked; then the sender's face,
  24px, level with the first two lines in a slot every row and the
  skeleton share, so a picture never moves a word (his own face for a
  thread that is only his); the sender (600 and
  `foreground` when unread), the thread's count, and at the row's end the
  marks and the date in 12px tabular. The marks say each thing once: the
  14px circle-dot in `warning` for a thread that needs him or a draft an
  agent wrote (amber stays the one sign that he is needed), 12px glyphs
  for an invitation and for files. The second line is the subject, the
  third the first words in 12px; in two lines the first words follow the
  subject 8px on, 12px, in `faint-foreground`. Hover is `foreground` at
  5%, the open and ticked rows at 9%, at once. Under the pointer the date
  gives way to Archive, Delete and Mark read; with rows ticked the head
  becomes "3 selected" with those acts, and no row shows its own. A search
  lights the words it found, where a word starts, in `foreground` medium.
  An empty mailbox says so in one line at the column's middle, level with
  the pane's "No mail open". In Waiting on a row leads with whom he wrote
  to and its end says how long he has waited ("6 days"); under the pointer
  that gives way to Draft a nudge, Put off and Dismiss. The composer's foot
  holds "Remind me if there is no reply" as a quiet hourglass before
  Discard; once set it says the time in ink ("3 days").
  The reader's toolbar is 44px of quiet 28px buttons (Archive, Delete,
  Snooze, Needs me, More), its place in the list at the end; in Trash,
  Restore alone with its word. Its menus are the app's 28px menu rows. The mail is a 680px column: the subject
  (the 16px title), then each message under a hairline with a 28px face,
  the name at 600, the address, "to me" on its details, the time, Reply
  and its menu. A run of two or more read messages is one 40px row
  ("5 earlier messages") with two lapped 18px faces; a lone one folds to
  a row. A plain mail is 14/22 on 68ch in the app's inks, a sender's own
  colour kept and moved only when it would not read; a mail written for
  white keeps its white page at radius 8 in both themes, edge to edge.
  Quotes sit behind "Show quoted text". Held pictures are one `muted`
  strip with Show. Files are 40px chips with a 28px tile, which is the
  picture itself for a picture; two or more get "3 files, 4.1 MB" and
  Save all. An invitation is a card above the body: the date tile, when
  and where, Accept, Maybe, Decline, Open in Agenda; it leaves out a
  title the subject already says. The thread ends in the 40px "Reply to
  …" row.
  The composer is a card in the thread's flow for a reply and the pane's
  own surface, 720px at most, for a new mail: To, From and Subject rows
  with one value edge, the editor, and a foot bar with Attach, Picture,
  the formatting row, Saved, Discard and the one primary, Send. A draft a
  thread wrote opens under one line: the amber mark, "Drafted in" and the
  thread's name in medium, Open thread. Its Send has no menu and shows
  one toast, "Sending to …" over a 3px track that empties across the undo
  time, with Undo; nothing has gone until the track is empty.
  A face is one avatar everywhere in Mail (a list row at 24px, a message's
  header at 28px, a fold row and a recipient's chip at 18px): the person's
  picture where LifeOS holds one (read from LifeOS's store as bytes, never
  from the web, and kept once read so it never flashes back to initials),
  else a 14px glyph for a mailing list or a shared mailbox, else initials
  on `muted`, all inside the image outline. A picture that does not load
  gives way to the initials quietly.
  Mail's settings are flat groups of 44px rows under 13px semibold
  headings; a signature and an account open as dialogs in the one dialog
  shape (the title beside a quiet Close, a hairline over the footer), every
  control in the account dialog at one width.
- **The Messages view** (TempCode's own, src/renderer/src/work/messages/;
  docs/agents/work-messages.md). Mail's frame: no header of its own, the
  list's 44px head the page's, the list 296px (260 to 480, kept as
  `tc.messages.listWidth`) beside the conversation, and at and under 640px
  of view the two take turns, the conversation's toolbar leading with the
  way back. The head is "Messages" (13px semibold, the job's unread count
  muted after it) on a menu of All, Unread, Direct and Channels, and names
  the filter in force; under it the 28px search, then one 12px muted line
  while a source of the job is stale ("Discord last synced Nov 3, iMessage
  Nov 16"). Under 640px with a conversation open, its toolbar says its own
  source's line instead, so the fact is on screen once. A row is 48px at
  radius 6, 1px apart, in Mail's grid: the 20px gutter for the 6px unread
  dot, a 24px face (two 18px faces lapped side by side for a group, a 14px
  hash on `muted` for a channel), the name (600 and `foreground` when
  unread, muted when read) with its time at the end in 12px tabular, and
  the newest words in 12px muted, led by "You: " or the writer's first
  name. The 14px amber circle-dot before the time marks a thread's draft
  waiting there. No source chip: the source is said once, in the open
  conversation. Hover is `foreground` at 5%, the open row 9%, at once;
  under the pointer the time gives way to Mark read or Mark unread. Bones
  are eight rows in the row's grid; an empty list is one line at the
  column's middle with its true cause ("No chat is linked to Cosmic" with
  Open Connections, "No messages in Cosmic yet", "Nothing unread" with
  Clear filter). A search shows the messages that hold its words in the
  rows' place, the conversation's name and time, then who and the words
  from a little before the first match, lit in `foreground` medium.
  The conversation's toolbar is 44px over a hairline: the name 13px
  semibold (a direct chat's opens the person in People when LifeOS knows
  an address), one muted 12px fact ("Slack, CosmicGames") 8px after it on
  its baseline, and More at the end. The messages are rows, not bubbles,
  in a 680px column stacked from its foot: a run of one writer inside five
  minutes shares one head (28px face, name 600, time 12px muted), the words
  14/22 with their line breaks and http, https and mailto links in `link`;
  runs are 16px apart, messages in a run 4px. A day opens with its date,
  12px muted, centred on a hairline; "New" sits at the end of the hairline
  over the first unread message, 12px `foreground` medium. It opens over
  "New", else where he left it, else at its foot; while he is up the column
  a quiet pill at its foot says "2 new" and goes down. A Slack thread reply
  carries one 12px muted line above it: a turned arrow, the writer in
  medium and the first words of what it answers. A message that arrives at
  the foot rises 4px and fades in over `--dur-fast`; nothing else moves.
- **People** (the People view, work/people/; docs/agents/work-people.md).
  The list is the Docs list's shape: a 720px column, one 32px row a
  person, the 24px face, the name in `foreground`, the first address 4px
  after it in 12px `muted-foreground` on one baseline, when they were
  last heard from at the end, tabular. A person's page takes the Projects
  way back in the 40px header (the arrow, "People", their name muted) and
  its two quiet verbs, Write and New thread. The body leads with the 40px
  face beside the name (the 16px title recipe) and their addresses and
  numbers as one comma line in 12px muted, then the notes at 14/22; then
  each section that has something, 24px apart, under a 12px medium muted
  heading: rows of the Docs list's shape, a title, a 12px muted second
  line, a time at the end. A section with nothing is not drawn, and no
  row repeats what its heading says. An Agenda row names the people at
  an event as one muted comma line ("With …"), each name a link on hover.
- **Clashes** (work/clashes/; docs/agents/work-clashes.md). A clash is a
  fact about an event, so it sits on the event, in words, where he already
  reads it: no page, no count on the rail, no badge.
  On an Agenda row it is one more 12px line under the place, in `warning`
  (he is needed), in the words of that event's side: "Overlaps Varsity
  Basketball (Ref), 6:00 PM", "15 min short after Staff meeting (Purdue)",
  "About 15 min short…" for a drive worked out without the map; with
  several, the first and ", and 2 more". The line is a button that takes
  an underline on hover, as a With name does, and opens the Clash dialog;
  the row's menu has Show clash. An event that is over carries none. The
  line arrives with its read and nothing pulses for it. "Leave 4:35 PM"
  under the time is from where he will be: the event before when that
  ends within three hours, else the day's start.
  The Clash dialog is the `sm` Modal. Its title is the fact ("Two things
  at once", "15 minutes short", "About 15 minutes short"), the later
  event's day the 12px line under it. The body holds the two events in
  time order, 12px apart: each its title (14/22 medium), then one 12px
  muted line of its time span (tabular) and, 8px after, its job (the
  sector dot and name), then where it is (the place as the map names it;
  his calendar's own words when the point is a town's centre or a start
  standing in), each cut line whole on hover. Between the two is a
  hairline, which carries the drive in 12px muted at its middle when both
  have a point ("38 min drive, 24 mi", "About 40 min, 25 mi"). Under each
  event, 8px down, are the ways out it allows and no others, as outline
  `sm` buttons: Decline, Propose new time…, Move…, Running late…. The foot
  has "This is fine" (ghost) at its start and Close at its end.
  A way out swaps the body for its one step: the event, one 13px muted
  sentence of what goes and to whom, then Day, From and To (New event's
  fields, filled with the first quarter hour after the other event that
  the drive allows) for a proposal or a move, and a Note for a decline or
  a proposal; the foot is Back and Send (Move for a move). Send holds its
  width and spins; a toast answers the press and the dialog closes; a
  refusal stays in the step in LifeOS's words, in `destructive`. Back puts
  focus on the way it came from. Running late… opens Mail's composer in
  that job's workspace with the people on the event and one line; "This
  is fine" closes with a toast that carries Undo.
  In the Week and the Month a clashing event's block carries a 6px
  `warning` dot before its title, named "Clashes with another event";
  pressing the event opens its day's list, where the line is.
  Start places is a section of Settings → Work on the Work home host,
  after Where it runs (`StartPlacesSection`): Home, then the six jobs in
  LifeOS's order, each job's title its sector dot and name. A row's line
  is the place as the map named it; "Home" in muted text where a job has
  no start of its own; "Not set" for Home with none; "Looking up…" until
  LifeOS has placed a new address, turning by itself; the typed address
  with "Not found" as the row's red line when the map did not find it.
  Nothing on the row says whether a job's places go to the map: that
  lives in the dialog. The row opens a small dialog named for Home or the
  job: one Address field, and for a job the switch "Look up places on
  Apple Maps" with its one line, "Off, this job's event places never
  leave your machines.", and Use home at the foot's start while the job
  has a start of its own. Save stays off until something changed, spins,
  and closes; a refusal stays in the dialog. No toast: the row is the
  answer. Signed out of LifeOS the section is absent; while it reads,
  seven row bones.
- **Project screens** (the Projects view; the tracker's projects screens,
  shared with LifeOS, on TempCode's scale). The view's one 40px header
  holds the screens' bar: the view's name on the list, else the way
  back, then the controls at its end, all quiet 28px buttons (List or
  Board, New project, New thread, Share, New task). No second bar is
  drawn. The way back is one shape on every screen: a 24px ghost arrow,
  then the name of where it goes in 13px medium ("Projects", or the
  project a document was opened from), then what the screen adds beside
  it in `muted-foreground` (a task's key, "New project"). A
  row is 32px of 13px words on 20px a level, its bar the row radius
  (8px), `foreground` at 5% in hand and at 9% selected or pressed, at
  once. A project's name is the document title's recipe (18/26
  semibold, -0.01em), edited in place. A card is `background` on a `card`
  lane with a hairline (6px in a 12px lane), a stronger hairline in hand,
  and no shadow; only a row or a card being dragged lifts. The peek is a
  sheet (16px), 44% of the view's pane (560 to 960px); the work makes
  room for it on a pane of 1280px or more, and under that it lies over
  the work. A stage of work is a mark, never a word in its colour: a
  state's 14px glyph and a meter's segment in `stage-doing`,
  `stage-waiting` and `stage-done`, the rest of a meter a dotted line in
  `chart-neutral-stale`. Work in hand takes no hue (`muted-foreground`),
  as a working thread takes none: amber stays the one sign that he is
  needed, so a list of active projects does not read as a list of asks; the meter is 4px, square, with no track, and
  never moves. A count is said once: the list and the board say done of
  all beside the meter, a project's page in its tabs. A task a thread
  works on shows that thread's mark in its row, which opens the thread.
  A project's menu holds Project settings…, which opens its sheet from
  the page. A Work project's settings are a sheet with its name, state,
  rules, accounts and sharing and nothing of code; what LifeOS cannot take now is shown as
  words, never as disabled controls.
- **The guest's page** (tempcode.landonhale.com) is the same editor on the
  same tokens under one 44px line: the item's name, whose it is, what the
  guest can do, until when, and the guest's avatar. What a guest may not
  do is absent, never disabled. A project's link draws the project
  screens there on the Projects view's own measures, read only: the line
  holds the List or Board switch before the guest's facts, no way back
  to a list of projects, and no Activity. A document or sheet of the
  project opens in place with a 24px back arrow first in the line and
  its own glyph and name after it; a document is drawn as text on the
  document page's measure, with no editor.
- **Sharing a project.** Share is one of the project bar's quiet 28px
  verbs and opens the same 320px popover as a document's. The dialog has
  no Can row: a project's guest views, and a choice of one is not drawn.
  The project's settings sheet lists the same links under Sharing.

#### Work editors

What the document, the sheet and the deck share on screen. Who hears a key,
Print… and Export… are docs/agents/work-editors.md.

**The format row** (work-kit `src/format`, `FormatRow` and its parts; drawn
by each kind as the first, unscrolled row of its own body, under the kind's
bar). One row, the same in the three editors, and the one place a style is
set by hand.

- **The row** is 36px on `background` with a hairline under it and a 12px
  inset. Controls are 28px quiet buttons at the 6px radius, 2px apart, a
  14px glyph each, `muted-foreground` at rest and `foreground` under the
  pointer; a press steps the fill and scales nothing, as every ghost
  control. A toggle that is on (Bold) is the `muted` fill with foreground
  ink.
- **Groups**, in an order that never changes: his own edits (Undo, Redo);
  the style (a paragraph's, a cell's, a slide's layout); the font (family,
  size in points); the character (Bold, Italic, Underline, text colour,
  and highlight or fill); the paragraph or the cell (align, then lists and
  indent, or borders and number format); Insert; Data (the sheet's); then,
  at the row's end after at least 8px, the view switch and the way out
  (Preview, or Present). A 1 by 16px `border` rule with 4px either side
  parts two groups and parts the view switch from the way out.
- **Controls.** The style select is a quiet 132px face (148px for a deck's
  layouts), 13px foreground, a 12px muted chevron; the font select the
  same at 120px, set in the font it names. The size is a 44 by 28px field,
  13px tabular, centred, on the `input` border. A menu button is its glyph
  (or three characters, "123") and the chevron; Insert and Data are their
  word and the chevron. A colour control is its glyph over a 14 by 3px bar
  in the colour it last laid down, on the `image-outline` edge: the ink
  for a text colour's Automatic, no bar for No fill. The view switch is
  the segmented control at 28px with 12px labels; the way out is a quiet
  button, its glyph and its word.
- **The fold.** The row measures itself; nothing is a breakpoint. What
  does not fit waits in one ⋯ (28px, "More formatting") at the cell
  group's end, folding in one order for all three editors: the paragraph
  or cell group, then Data, then Insert, then the character group, the
  font group, then Redo and Undo, each group from its end. Style, Bold,
  Italic and ⋯ never fold. When everything has folded the view switch
  becomes glyphs, then the way out a glyph. A full row needs about
  1,200px of canvas; in an 864px window it shows through the text colour;
  beside a thread it is Style, Bold, Italic, ⋯, the view and the way out.
  That is by design: the Files tab is where he formats.
- **⋯** is a 224px menu of what folded, in row order, a rule between
  groups: each row its 14px glyph and its name, then its key or its value
  in 12px muted ("⌘U", "Aptos", "11"), then a 12px chevron when it opens
  more. A folded toggle shows its check in the glyph's place.
- **Layers.** Every menu and popover from the row opens 4px under its
  trigger, stays 8px inside the canvas, and when its control has folded
  opens under ⋯. Menus are the app's one size (28px rows, 12px in, 8px to
  the label); a choice of several carries its check in the glyph's place,
  so an example can sit at the row's end ("Currency", then "$1,206.96" in
  12px muted). A popover opened by a press takes focus itself, so no tip
  opens under the pointer; opened by a key, its first control does.
- **The colour picker** is one 240px popover everywhere (6px over, 12px
  sides and foot): the automatic row first (Automatic, No fill or No
  colour: a 14px swatch with a stroke through it, a check when it is the
  selection's); "Theme" in 11px, then the file's ten theme colours as 18px
  swatches at 4px radius 4px apart, and 6px under them their five tints as
  18 by 14px swatches at 3px radius 2px apart (lighter 80, 60 and 40%,
  darker 25 and 50%; a white steps darker 5 to 50%, a black lighter 50 to
  5%); "Standard" and Office's ten; then Custom, a 108 by 28px hex field
  in 12px mono with a 14px swatch inside it, taken on Return. A swatch
  wears the `image-outline` edge; the selection's own takes a 2px gap and
  a 1.5px `foreground` ring, the one under the pointer the same in
  `muted-foreground`. A swatch is the file's literal colour and is never
  themed. A theme swatch is kept as a theme colour with its tint, so the
  file's theme can change it later. A press applies and closes.
- **The font list** is a 248px popover (6px in): a 28px search field over
  a list capped at 284px, "In this document" first, then "Fonts", 28px a
  row, each family in its own face. A font TempCode cannot draw keeps its
  name with one 12px muted line under it, "Drawn as Carlito".
- **The style menu** is 200px: each style in its own look as a 22px
  sample (4px radius, 8px in, 96px at least), the current one checked,
  and one verb under a rule ("New cell style…"). No sample takes a green,
  red or blue fill: on a canvas those mean a change or a selection.
- **Alignment** is one menu button showing the current glyph. Its sheet
  holds the choice across as glyphs on the segmented track (with Justify
  in a document) and, for a cell or a text box, the choice down beside it,
  then Wrap text and Merge cells as 28px rows that say when they are on.
  It stays open, since alignment is often set both ways.
- **Keys.** A control's tip is its name and its key ("Italic ⌘I"). A key
  the app also holds (⌘B, ⌘K, ⌘P, ⌘F) is shown only where the editor has
  it. The row is one tab stop: ← → Home End move inside it, a field keeps
  the arrows until the caret stands at its edge, and a press with nothing
  to act on stays a stop.
- **What is absent.** A file he cannot edit draws no row, never a greyed
  one. A control whose change could not be saved where the file lives is
  not drawn there.

**The show** (`src/renderer/src/work/slides/show/`; the approved page is
`.temp-code/prototypes/work-editors/present.html`, "Slide and column"). A
deck presented, in two windows of their own, drawn by the main window
through a portal as the pop-out is (`src/main/present.ts`): the slideshow
the room sees, and the presenter's view. One state moves both.

- **Present** is a secondary split button at the end of the deck's bar: a
  10px play glyph and the word, which goes under 560px of bar. The press
  starts from the slide on the stage; the chevron's menu (240px or more)
  has From the start, From this slide, Presenter view, each with its key,
  and In a window on the desktop. With more than one display it ends with
  a "Slideshow on" label and a check row a display; the slideshow goes on
  the other display unless he picks. It is absent while the host has no
  picture of the file.
- **The slideshow** is the slide on `matte`, fitted to the window, and
  nothing else. Its window wears the dark theme whatever the app wears, so
  its bar keeps one look over every deck. Blank is the matte alone. After
  the last slide, "End of show" in 15/24 `muted-foreground`, centred; a deck
  that cannot be drawn says why there in the same type. A press anywhere
  on the screen is a next press: on the slide, on the black of a blank, on
  "End of show".
- **Its bar** comes for a real move of the pointer and never for a key: 40px
  tall, radius 10, 12px off the foot, centred, on `present-bar` (the dark
  popover at 94%, one value in both themes) with a `border` ring and the
  overlay shadow; 28px quiet buttons 2px apart, 4px from its ends:
  Previous, "4 / 12" (12px tabular, at least 44px wide), Next, a 1 by 16
  rule, then Slides, Blank and End. It and the pointer go together 2000ms
  after the last move (`PRESENT_IDLE_MS`), and it stays while the pointer
  rests on it or its picker is open. Slides opens the picker upward, 8px
  over the bar: a 296px `popover` panel at radius 12, every slide a 58px
  picture in the strip's 3px frame, four across with 8px gaps; the arrows
  move four ways, Return jumps, Escape closes it.
- **The presenter's view** wears the app's theme. A 40px bar (16px inset
  left, 8 right, a hairline under it): the elapsed time in the title recipe
  (16/24 semibold tabular, never bigger), which turns `warning` once he is
  past his target; the target as a 24px quiet button ("of 20:00", or "Set a
  target") whose menu has 10:00, 15:00, 20:00, 30:00 and No target; Pause
  and Restart as 24px icon buttons; a rule; the clock in 13px muted
  tabular; then, at the end, Previous, the place, Next, a rule, Blank (a
  28px toggle) and End show (secondary, small). The body has a 16px inset
  and gap: "Now" over the slide the room sees, as large as the room allows,
  and a 288px column of "Next" (with "Build 2 of 4" at its line's end when
  the next press is a build) over the next press's picture, then the notes.
  Labels are 12px medium muted, 8px over their picture; a picture is a
  slide at radius 4 on `image-outline`. A press on either picture is a
  next press. On the last slide Next is the matte with "End of show"; at
  the end it is a `muted` box, "A press closes the show". While the screen
  is blank the current slide dims to 45%.
- **The notes** are the one text in the chrome that may pass 18px: 14/22,
  16/24, 18/28, 20/30 (the start), 24/34 or 28/40 in `foreground`, set by a
  − size + stepper in the notes' 24px header and by + and −, and kept for
  the next show. With none, "None" in 13px muted.
- **The strip** at the foot is 60px on `sidebar` under a hairline, 12px
  inset: every slide a 58px picture in the 3px frame at radius 6 with its
  number 12px tabular before it, the current one on `muted` and kept in the
  middle, a hidden slide at 45%. A press jumps. G hands it the keyboard:
  the arrows then move along it and Return jumps; at every other time the
  arrows are the show's, so a thumbnail is never a Tab stop. With no
  presenter's view, G opens the slideshow's own picker.
- **Under 640px** the column stacks under the slide, the clock and the
  timer's buttons go, the next press is a 176px picture and the notes cap
  at 220px.
- **A second display leaving** closes the slideshow that was on it; the
  presenter's view goes on under one 28px line, "The slideshow's display
  was disconnected", in 12px muted. The same line says "Reconnecting to the
  deck…" while a read of the deck is asked again; the slide stays up.
- **Return and Space on a control he tabbed to** press that control; after
  a press made with the pointer the keyboard is the show's again.
- **Keys**, in either window (shared with PowerPoint and with a clicker,
  which sends PageDown, PageUp, B or a full stop, and Escape or F5):

  | Act | Keys |
  | --- | --- |
  | Next (a build first, then the next slide; after the last, the end, then the show closes) | → ↓ Space Return PageDown N, a press on the slide or on the next picture |
  | Previous (undoes a build first) | ← ↑ PageUp P Backspace |
  | First, last | Home, End |
  | That slide, hidden or not | its number, then Return |
  | The slide picker | G |
  | Black, and back | B or a full stop; a next or previous press also brings the slide back, and does nothing more |
  | End the show | Escape (which closes an open picker first), End show, End on the bar, closing either window |
  | Notes larger, smaller | + and − |
  | Start, from the deck | ⇧⌘↩ from the start, ⌘↩ from this slide, ⌥⌘↩ presenter view, F5 from the start (⇧F5 from this slide) |

  A key held with ⌘, Ctrl or Alt is the window's own. A video's transport,
  when a slide has one, is in the presenter's view only: the slideshow has
  no chrome but the bar the pointer calls.

#### Work editors: Preview

One surface for the document, the sheet and the deck (`work/formats/PreviewFrame.tsx`
over a kind's `PreviewSource`; docs/agents/work-editors.md has the contract):
"this is the file you will get", drawn by the program that will read it. It
is a state of the item, not a kind and not a dialog: its bar takes the format
row's place, the stage takes the body, and the tab row, the kind's bar and
the review stepper stay as they are. Export… in an item's ⋯, File → Export…
and ⇧⌘E open it on the format he last used for that kind; Edit, or Back on a
file he cannot edit, or Escape, puts him where he was. The editor stays
mounted under it, out of the tab order, so his caret and his place are kept;
opening puts the focus on Edit.

- **The bar** is the format row's: 36px on `background`, a hairline under
  it, a 12px inset, 28px controls at the 6px radius 2px apart, a 1 by 16px
  `border` rule with 6px either side. In order: Edit (ghost, the 16px left
  chevron and the word in 13px medium muted; its glyph alone under 440px of
  canvas); the rule; the format; the zoom; the count; and at the end the
  Page button and, 6px after it, the one primary button (small), which says
  the format's own verb: Export, Print…, Save to Google Sheets.
- **The format** is a segmented control (28px, 12px labels, the gliding
  pill) while it fits and a quiet menu button when it does not: its name, a
  12px muted chevron, and a menu whose rows are the name with the extension
  as the row's muted end fact and a tick on the one in hand. "Fits" is
  measured, the bar's room against the control's own width, never a
  breakpoint: the labels differ by kind and the type by machine.
- **The zoom** is a quiet menu in muted 13px: Fit width, Fit page, 100%,
  125%, 150%. Only for a picture with pages; gone under 440px of canvas. Fit
  width runs from 0.3 to 1.25 on the room the paper has, as the PDF kind's
  does; his place holds across a zoom.
- **The count** is 12px muted tabular, 8px either side: "Page 2 of 5", or
  "Slide 1 of 12" for a deck's own formats. It follows the scroll. None for a
  file with no pages, while it is drawn, or on a failure.
- **Paper** is the PDF kind's: `paper` on `stage` on `image-outline`, 12px
  between sheets, 16px over the first and 24px under the last, a 24px side
  inset (12px with the column folded). White in both themes: a preview shows
  the file, and the file's paper is white. The file's words can be selected
  on it. A page that could not be drawn says so on the paper in `paper-ink-2`
  with a ghost Retry. From 20 pages a thumbnail rail stands at the start:
  76px (60px under a 640px canvas), thumbnails 44 wide (52 for a slide), the
  number under each in 12px tabular muted, the page being read on `muted`; a
  press goes to that page.
- **Who drew it** is one line over the first sheet, as wide as the paper, at
  least 24px tall and 8px above it, 12/16 muted: "As LibreOffice draws it",
  "As Word draws it" (or Excel, or PowerPoint) only when that app drew it,
  "The file itself" for a PDF, "As it will print" for Print. A file that is
  its own text or files has no such line. Where the real app is in reach the
  line ends in a ghost extra-small button, "Check in Word": his press draws
  it there, the line reading the spinner and "Drawing in Word" ("Waking
  Windows" when the machine was asleep) while the paper stays and dims to 55%
  over `--dur-base`; then "As Word draws it" and no button. If the app could
  not, LibreOffice's picture stays and one toast says why ("Word is not in
  reach").
- **The column** is the PDF kind's margin column: 232px, 16px off the paper,
  in view as the pages scroll. A section's name is 12/16 medium muted with
  4px above and below, 20px after the section before it. **Page** comes
  first, for a format with pages: rows of at least 28px, the name in 13/20
  and its value as a quiet extra-small menu button at the row's end (12px, a
  12px chevron, at most 156px, hung 8px into the edge so values meet it), or
  a switch. Every kind has Paper, Orientation, Margins (Word's Normal,
  Narrow, Moderate and Wide; anything else reads Custom) and Headers and
  footers; a kind's own rows follow. A change draws the file again. **In
  this format** comes after: what the format cannot hold, one line each in
  13/20 foreground, 4px apart, counted from the item and saying what happens
  to the thing ("2 comments stay behind", "3 suggestions go as tracked
  changes", "1 footnote moves to the end"), never "not supported". With
  nothing lost there is no heading and no line, and with neither section no
  column: the paper takes the room.
- **Under 600px of canvas the column folds.** The losses become 12/16 muted
  lines under the who-drew line, over the paper. The Page rows move into a
  264px popover (8px top, 12px sides and bottom) from a 28px quiet icon
  button in the bar (the sliders glyph, named Page), shown only when the
  format has Page rows.
- **A file with no pages.** Markdown is on `background`, not `stage`: the
  text in 13/20 mono on a `card` box at the 12px radius with the hairline,
  16 by 20px inside, in a measure of at most 624px. A web page is on `stage`
  in a frame at the 8px radius on `image-outline`, at a phone's (390px), a
  tablet's (768px) or a desktop's (1280px) width from a 24px segmented switch
  where the who-drew line would be, zoomed down to fit and never up; no
  script runs in it and nothing it names is fetched. A table of plain values
  (CSV) is rows of 32px with hairlines, tabular, under a Sheet row when the
  file has more than one. Pictures are a grid, two columns and three from
  640px, 16 by 12px apart, each 16:9 at the 3px radius on `image-outline`
  with its file name in 12/16 muted. A video is its first frame at the 8px
  radius on the black matte, at most 640px, over a 32px row: Play, the time
  in 13px tabular, and its length and size in 12px muted at the end.
- **While it is drawn** the who-drew line is the spinner and "Drawing 5
  pages" (the count it had when last drawn; "Drawing the pages" the first
  time, "Drawing the file" with no pages), over two skeletons in the paper's
  shape on `card` with the hairline (16:9 for a deck). No count and no
  losses; the Page rows stay; the primary button stays live.
- **When it cannot be drawn**: one `Empty` in a 440px box at least 360px
  tall on `stage`, "Can't draw this format here", the reason and "Exporting
  still works." as its line, and Retry. The primary button stays live and
  the Page rows stay beside it; no losses are listed. A render the host no
  longer has is drawn once more with nothing said.
- **A long file** draws its first pages: the who-drew slot reads "The first
  50 pages" with a ghost extra-small "Draw all 2,084" at its end, and the
  count is of the whole ("Page 1 of 2,084").
- **After Export** the system's own save dialog is the answer and nothing
  more is said. When a kind saved the file somewhere itself, one toast says
  where: "Saved Budget.xlsx to Spring LAN".
- **Motion.** The menus, the popover and the toast are the app's. The
  format's pill glides on the layout spring. The paper dims over `--dur-base`
  on `--ease-out` while the real app draws, and not under reduced motion. A
  new picture replaces the old at once: nothing fades in.
- **Against the prototype** (`.temp-code/prototypes/work-editors/`,
  `preview.html`): the zoom gains Fit page; the rail's numbers are 12px,
  since the scale keeps 11px for key caps and menu labels; the format's fit
  is measured from the bar's room, not from its scroll width; Print has no
  printer rows, which are the system dialog's.
- **Tokens.** `paper-ink-2` (`#5b6270`: on paper, what supports the words)
  and `paper-rule` (`#c3c8cf`: a rule on paper), one value in both themes as
  `paper` and `paper-ink` have, held to 4.5:1 and to the edge floor on
  `paper` by `lib/tokenContrast.test.ts`. Nothing inside the paper, a slide
  or the web frame is ours.


## Scrolling

Every scroller is a native element with `overflow-*-auto`, and one rule in
`index.css` draws its bar on every platform: an invisible track and a 6px
pill on `--scrollbar-thumb` in a 10px strip. The pill hides at rest and
shows while the pointer is over the scroller or while it scrolls
(`lib/scrollActivity.ts` marks a scrolling element `data-scrolling` and
clears it `SCROLL_IDLE_MS` after the last scroll); Chromium cannot fade a
scrollbar, so it shows and hides at once. There is no scroll-area component.
While a scroller scrolls its children take no pointer (`data-scroll-quiet`,
cleared `SCROLL_QUIET_MS` after the last scroll, when the pointer moves or
on a press, never set while a button is held), so rows sliding under a
still pointer show no hover and start no hover transition.

A rounded scroller sets `--scrollbar-inset` to its radius
(`[--scrollbar-inset:var(--radius-xl)]` on a menu), so the pill never runs
into a clipped corner. One region has one scroller: a dialog scrolls its
body or its list, never both (the Modal body is a flex column, so a list
marked `min-h-0` shrinks under its cap first); the only nested scroller is
a bounded log or code console. A vertical list says `overflow-x-hidden`
beside `overflow-y-auto`, so a 1px overhang never raises a sideways bar; a
horizontal bar appears only where content overflows.
`lib/scrollerGuard.test.ts` checks each renderer class string and refuses
`overflow-y-auto` without `overflow-x-hidden` or `overflow-x-auto`; there
are no exceptions. A pure text region
(notes, a log, the preamble preview) takes `tabIndex={0}` and the focus
ring (`focus-ring`), so the keyboard reaches it. Where a first overflow must not shift
the content (the transcript, the pages) the scroller reserves its strip
with `scrollbar-gutter: stable`. Nothing sets `scrollbar-color` or
`scrollbar-width` but `.scrollbar-none` (tab strips scrolled by wheel):
either one makes Chromium drop the rule. Monaco and xterm draw their own
bars and take the same tokens through their themes, the same sizes through
their options and `index.css`.

## Iconography

`@renderer/chrome/icons` (Hugeicons under lucide names), 16px in rows and
buttons, 14px in dense chrome, 12px as a mark beside text, 1.5px stroke,
`currentColor`. The stroke is the icons' default (`ICON_STROKE`, held to
this line by chrome/icons.test.ts), so no call site writes 1.5; a glyph that
reads too thin takes the next size up, never a heavier stroke. No icon takes a
`strokeWidth` prop outside chrome/icons and the charts (the same test refuses one). An icon never carries meaning alone where a word fits; a
tool row in the transcript keeps its tool icon beside its humanized verb.
Two glyphs carry colour: `StatusMark`'s, for a state, and the type glyph
(`TypeGlyph`), in its type's tint ("Type tints"). Every other glyph is
uncoloured: a subagent's role glyph (`AGENT_GLYPHS`), a tool's, the host's.
The host glyph (chrome/HostGlyph.tsx) stays as it is: 12px, uncoloured, the
name on hover, drawn only with two or more hosts.
A workspace's glyph is not an icon: `WorkspaceGlyph` (chrome/WorkspaceGlyph.tsx)
draws the person's logo, the repo's icon or the mascot in the workspace's own
colour, 16px in a rail row and 14px beside text, an image on the 4px radius,
never tinted by state; it is the one drawing of it in the rail, Search,
Inbox, Notes and the folder picker.

Work's glyphs live in a second catalog, `src/renderer/src/work/icons.tsx`,
made with the chrome's own wrapper, so the stroke is the same 1.5px; it
rides Work's lazy chunks. chrome/icons.test.ts allows the deep Hugeicons
imports in those two files alone.

Provider marks may share an asset (Muse Code uses Meta's). `chrome/icons.test.ts`
checks that every `HARNESS_ICONS` entry names an asset in `assets/providers`,
every asset is used, and Meta's is present.

## Loading and empty states

A surface that waits shows a `Skeleton` in the shape of what is coming when
the wait is a load, and a `Spinner` with a word ("Loading…", "Starting…")
when it is an action. A button uses `BusyLabel` to reserve both states
at rest, and the button clicked is the one that spins (a footer's Clear or
Remove override spins itself while the confirm only waits); its spinner is hidden from assistive tech so the verb stays its
name. `lib/busyLabelGuard.test.ts` refuses a bare Spinner in Button or
AlertDialogAction children, including a primitive's render slot. An icon
button keeps its name on the button and uses an empty BusyLabel for its
busy glyph. A list with nothing in it shows one `Empty`: a title,
one line, at most one action; never an illustration or a dashed box. A
list the person narrowed (a typed filter, the filter menu) says so in that
line and offers Clear filters as its action. A
section of a settings page with nothing in it shows one muted line in a
row's place (`PageEmpty`), never `Empty`: the section's heading is already
the title. A section's failure that no row owns is one red line in the same
place (`PageError`); an error a row owns is that row's red line. A
new thread (a draft) shows the composer and nothing else, and so does a
project with no thread on screen: its draft, the composer alone, with no
chip, badge or heading for it; a thread its host holds with no rows shows
the composer under one muted line (the host's failure summary, else "No
messages yet"), never the new-thread screen; a Work thread's sits beside its
open items. Inside a picker
or menu, no match is one muted row, never `Empty`. A lazy surface falls back
to a `SurfaceSkeleton` kind, and a small section's wait is `LoadingLine`
(both in surfaces/SurfaceSkeleton.tsx, beside `EmptyState`). Text that is
being produced shimmers (`WorkingText`); nothing else does.

## Motion values

| Surface | Enter | Exit | Reduced motion |
| --- | --- | --- | --- |
| Dialog (transitions, so a close mid-open turns back from where it is; the entry is CSS `@starting-style`) | fade + scale 0.95→1 + rise 4px, `--dur-slow` `--ease-out`; a picker opened by a key (⌘P, ⌘⇧O) appears at once | fade + scale →0.98, `--dur-fast` `--ease-exit` | fade only |
| Sheet (transitions) | fade + slide 16px from its edge, `--dur-drawer` `--ease-drawer` | fade + slide 16px back by the same edge, `--dur-slow` | fade only |
| Popover, menu, select (transitions) | fade + scale 0.95→1 from the trigger, `--dur-base` | fade + scale →0.98, `--dur-fast` `--ease-exit` | fade only |
| Context menu (transitions) | fade at the pointer, `--dur-fast` | fade, `--dur-fast` | same |
| Tooltip (13px regular on 20px lines, 24px tall) | after 300ms (`TOOLTIP` in lib/ease.ts), fade + scale 0.98→1, `--dur-fast` `--ease-drawer`; neighbours in one `TooltipProvider` (a closing line's or a notice's actions, the title bar's groups, a split view's header, a rail row's hover actions) open at once within the 120ms grace, the label moving instead of reopening | fade + scale →0.98, `--dur-fast` | fade |
| Toast (sonner, on `--layer-toast`; index.css overrides its 400-500ms defaults, out-specifying its injected stylesheet) | rise and fade, `--dur-base` `--ease-out`, no height or shadow transition | fade, `--dur-fast` `--ease-exit` | fade, `--dur-fast` |
| Right panel (a toggle in place; the thread takes its width at once, so no frame lays out the transcript) | slides in from the row's right edge (`translate-x-full`→0) and fades, `--dur-slow` `--ease-out`; mounted open (a tab switch, a launch) it is just there; a section's body fades `--dur-fast` | drawn over the thread, inert: a quarter of its width back out and a fade, `--dur-fast` `--ease-exit` | fade only |
| Rail | no width animation; content fades `--dur-fast` | same | same |
| The composer's slash and @ menu (transitions; the entry is `@starting-style`; open while a `/` or `@` is typed, with nothing to pick one muted 28px row, "No matches", or "Loading…" while the project's files or the host's commands are read, or "Couldn't load commands" in red when the host gave no list, which Escape closes and the next `/` asks again) | fade + rise 4px from the box's edge, `--dur-base` `--ease-out`; a row keeps its element as the filter narrows, and the frame's height follows the list on the same transition | its last rows stay, inert, while it fades 1px back down, `--dur-fast` `--ease-exit`; typing it open again turns it back | fade only |
| Tab indicator | segmented: the pill glides on `SPRING_LAYOUT_CSS` (`TabsIndicator`); line tabs and the tab strip: instant | — | jump |
| Press, a raised button (`default`, `secondary`, `destructive`) | its fill layer scales 0.985 (0.997 × 0.985 full width) while the label stays put, `--dur-fast` | release, `--dur-hover` | none |
| Press, ghost, link, outline and every row (a rail row, an Item, a toggle, a tab, a hover action, a board row, a task list's header, a row control around the composer) | the fill steps to `foreground/12` at once; nothing scales (`ROW_PRESS` in components/ui/press.ts for a row drawn by hand, `ROW_CONTROL` in chrome/composerRow.ts for the quiet controls under and over the composer's box); a control floating on its own fill (jump to latest) lays `foreground/12` over that fill instead | back over `--dur-hover` | same |
| Hover fill (a button; a pressable row on a board or in a card at `foreground/5`, never `muted`, which means selected; a menu row and a rail row highlight at once; a raised button lightens, and secondary lifts its shadow, over `--dur-fast`). A pressed toggle is `muted` with foreground text, as `Toggle` draws it, the title bar's Panel and the agents cue included, so hovering it never looks like pressing it | `--dur-hover` | `--dur-hover` | same |
| Hover reveal (`reveal(group)` in components/ui/reveal.ts, the one recipe: a closing line's and a notice's actions, a message's Copy, a code block's and a tool output's Copy and Raw, an edit's Edit here and Show diff, an HTML page's Open, the queue's Send now, Remove and tune button, a model row's star, a dock tab's close, a Changes row's Discard and Stage over its counts and its fold's chevron over the file's icon, a hunk's Stage, the new-thread chooser's options, an Agents row's Open and Stop over its title line's end, a board row's actions over its model mark, an archived row's and a device's actions, a rail row's Pin and ⋯ over its trailing mark or, beside a workspace's state glyph, over the name's end right before it on the row's own fill, a task's chevron, an archived thread's Restore over its age) | waits `--delay-hover`, then fades in `--dur-fast`; keyboard focus (`has-focus-visible`; `row` adds focus on or anywhere in a row that takes focus itself) and an open menu show it at once, a mouse click does not hold it (focus-within never shows a reveal: lib/revealGuard.test.ts); the fade rides a wrapper, so the button keeps its own hover fill; controls over something at rest (`overlay`) take no pointer until they show: the pointer turns on with the fade, after the same wait. What they cover gives way on the same timing (`yields(group)`: the model mark, the counts, a file's icon, a workspace's diff, a listed thread's age, an Agents row's host glyph), so nothing reflows and the two cross over together: the controls keep their place at rest or lie over what yields, and nothing toggles its display on a hover (lib/revealGuard.test.ts). A control that arrives with its owner (the title bar's agents cue) fades in on a wrapper too (`FADE_IN`) | fades `--dur-fast`, at once | same |
| Fold (collapsible) | height, `--dur-slow` `--ease-out` | height, `--dur-base` | opacity |
| Fold that opens on its own (`.collapsible-auto`: the transcript's working group, the running task's steps, the title bar's shelf, a master board row's task list and its bar line) | height on the layout spring (`--dur-layout` `--ease-layout`) + opacity `--dur-base` `--ease-out` | the same, so the rows are gone before the box closes | opacity, `--dur-fast` |
| A step landing in it (`.step-land`) | fade + rise 4px, `--dur-base` `--ease-out`; only a step that lands while the fold is open, never at mount, on a hand open or when a panel unhides; steps that land in one commit wait their place in the batch, `--stagger-step` (30ms, `STAGGER`) apart, the fourth and later at three steps | none | none |
| The open table growing as rows land (`useHeightGlide`, lib/heightGlide.ts) | its height glides from where it is drawn to the rows it now holds, on the layout spring (`--dur-layout` `--ease-layout`), retargeted from the screen when another lands mid-glide; one row in and one out at the window's cap nets nothing; never at mount, on a fold, on the lone-to-table entry or a hand's decision | — | the height steps |
| The working group's rows, opening on their own (a lone call becoming a table) | glide 12px from the prose edge to the table's inset (translate), on the layout spring, while the table's frame fades in over `--dur-base` `--ease-out` (`table-frame-in`); never at mount: a settled or reopened table draws its frame at once | — | the frame fades over `--dur-fast`; nothing moves |
| The working group's window (its newest five rows) | the oldest row leaves the top as the list glides up by its measured height, `--dur-base` `--ease-out` | — | none |
| The working group's fold, and a board row's task list once its thread is done (`useFoldHold`, lib/foldHold.ts) | waits `FOLD_HOLD_MS` once the work moved on, so the last row's settle shows, then folds on `.collapsible-auto` | — | the same wait, then the fade |
| Disclosure chevron (`DISCLOSURE_CHEVRON`, components/ui/disclosure.ts: one ChevronRight turning `rotate-90`, 12px beside 12px and 13px words; a menu trigger's chevron is a still `ChevronDown`) | rotates with its fold, `--dur-base` `--ease-out`, everywhere; its line's words and the chevron lift to foreground at once, on hover and keyboard focus alike, with no fill (the Watching line's mark, detail and age among them), so the turn is the one thing that moves; nothing beside it times its own turn or colour or turns it 180° (`lib/disclosureGuard.test.ts`) | same | none |
| Icon swap (`SwapIcon`; keyed for more than two states, as a tool row's working, failed and icon; a group line's glyph when its main kind changes, a compaction's from start to its outcome, the context meter's ring and its compacting spinner, a Spawned row's bot to its provider's mark) | opacity + scale 0.25→1 on `SPRING_LAYOUT` | fade + scale →0.25, `--dur-fast` | opacity, `--dur-fast` |
| Word morph (`MorphText`: a row's verb or a group's phrase changing tense, the working line's phases, the working line becoming the closing line) | only once the old words have left: the new rise from 3px below, `--dur-base` `--ease-swap`, while the box glides from the old width to theirs (a Web Animation from its live width when cut short); never on mount or for new words under one key | the old words lift 3px and fade first, `--dur-swap-out` `--ease-swap`; never two words in one place | fade out, then in, `--dur-fast`; no glide |
| Scroll glide (jump to latest, a burst while following, a jump to a row) | `DUR.drawer` on `EASE_OUT` | — | instant |
| Park on send (prompt to top) | the transcript glides to park the prompt, `DUR.drawer` on `EASE_DRAWER`; from more than 2.5 screens away it jumps to within 2.5 screens first, as every long jump does | the parked runway retires over `DUR.base` on `EASE_OUT` | instant |
| Jump to latest button | fade + scale 0.95→1, `--dur-base` `--ease-out` | `FADE_OUT` | fade |
| Count | ticks from the shown value, `--dur-slow` `--ease-out`; a pane shown again reads the count it holds | — | none |
| Shimmer (`WorkingText`) | a masked band and a bright copy of the words (the band's `::before`) cross them in opposite directions, transform only, every 3s (`SHIMMER`); not mounted in a hidden pane or document | — | still muted text |
| Working mark (`WorkingMark`, the working line's glyph) | three 3px dots gather into one and part every 1.6s, transform only (`MARK`); enters and leaves as an icon swap does | — | the three dots at rest |
| The working line settling (only once every row of the turn has finished revealing: the mark stays till then) | the mark leaves as an icon does, the words morph into "Worked for 2m 4s" (or Stopped; "Worked" while the time is still to land, which then fills in) and slide from the glyph slot to the prose edge, 22px, `--dur-base` `--ease-swap`; the hover actions mount | — | the morph's fades; no slide |
| Spinner | the one arc turning, on the document timeline from 0 (every spinner in phase; a remount picks the turn up) | — | still |
| Lightbox | opens from the thumbnail that asked for it (its transform origin is the thumbnail's centre) and settles back toward it as the dialog does | — | fade only |
| Appshot | fade + scale 0.95→1 centred, `--dur-slow`; holds; glides into its chip, `--dur-drawer` `--ease-drawer` | — | fade in and out in place, `--dur-fast` |
| Released drag (every sash let go past its bound, the reorder drop, an Escape glide-back) | settles on `SPRING_GLIDE` from where it is drawn, carrying the pointer's speed at release | — | at once |
| A theme change (a move between a code place and a Work one whose themes differ, a choice in Settings, the system turning over; `changeScheme`, lib/placeScheme.ts) | the place changes at once; the window's picture dissolves into the new theme, opacity only, `--dur-fast` `--ease-out` (a view transition round the class change), with every element's own transition off while it runs (`html.theme-switching`); it takes no input; a second change skips the first | — | the class at once, no dissolve; the same in a hidden window and where the window has no view transitions |
| Scrollbar | shows at once on hover or scroll | hides at once, `SCROLL_IDLE_MS` (900ms) after the last scroll or when the pointer leaves | same |
| List rows (rail, tabs, fleet, attachments, the transcript's message list, the composer's queue, dragged by its grip; every reorder is `hooks/useSortable`) | none; a row being reordered follows the pointer on the list's axis from where it was grabbed while the others hold still with the insertion line, then glides into its slot (or back to its own, on Escape or a drop that changes nothing) on `SPRING_GLIDE` | none | the line alone; the drop at once |
| The transcript's message list folding to its chevron (its chevron, View → Hide Message List, ⌘⇧M) | the rows fade in and slide 4px from the chevron, `--dur-base` `--ease-out` (opacity and translate; nothing else moves) | they fade and slide 4px toward it, `--dur-fast`, then leave the tab order | fade only, `--dur-fast` |
| A queued message arriving above the composer (chrome/MessageQueue.tsx) | fade + rise 4px, `--dur-base` `--ease-out`, on a full `transform` string so the compositor runs it (motion's `y` is main-thread) | fade, `--dur-fast` | fade, `--dur-fast` |
| Transcript rows | one `--dur-fast` fade on first appearance, never replayed: a row on screen never changes its key (the echo of the person's message keeps the optimistic row's, `Block.rowKey`) | — | none |
| A question card arriving (once per question: a remount of its row replays nothing) | fade + rise 4px, `--dur-base` `--ease-out` (`@starting-style`, `QUESTION_ENTER`) | — | fade, `--dur-fast` |
| Next and Back between a card's questions | the arriving question fades in over `--dur-base` `--ease-out` while the leaving one fades out over `--dur-fast` `--ease-exit`, in place; the card's height glides to the new question's over `--dur-base` `--ease-out` (the card is the last row, below the reader's anchor, so nothing above it moves); Back slides 8px in at the actions' start | the same | the fades; the height snaps |
| A question answered | at the click, the card folds closed on `.collapsible-auto` while its one-line answers open in its place on the same fold; a refused answer opens the card again | — | opacity, `--dur-fast` |
| The working line held (a card waits, the turn is paused) | folds closed on `.collapsible-auto` with its words kept; a resume reopens the same element | the same fold | opacity, `--dur-fast` |
| The Watching line, the fleet detail's live state | each in a kept fold under the turn: opens and closes on `.collapsible-auto`, mounted once it first opens, never unmounted while on screen | the same fold | opacity, `--dur-fast` |
| A status glyph changing state (`StatusMark`) | in the box that stays: the new glyph grows from 0.25 on the layout spring (`glyph-in`) while the old shrinks out over `--dur-fast` (`glyph-out`); never at mount | — | both fade, `--dur-fast` |
| The thought on the working line (`ReasoningColumn`, components/ui/reasoning-steps.tsx) | one phase for the whole block: "Thinking" shimmers once, the block's seconds tick 4px after it on the shared second hand (the figure alone re-renders, nothing morphs); each finished sentence fades in once in the column under the line on `.stream-step` (`--dur-reveal`, opacity alone) and stays put; the column grows to its newest line on `useHeightGlide` (`--dur-base` `--ease-out`), scrolls past 192px (smooth, following the newest line unless the person scrolled up; 32px of mask at a cut edge) and folds away on `.collapsible-auto` when the thought ends | the fold | the fades and the fold's opacity; the scroll snaps |
| Streaming text | the prose: the jitter buffer (surfaces/smoothText) steps whole words every 100ms (`REVEAL.stepMs`) a lead behind the live end (100ms here, 250ms for another host's thread, grown by an underrun, never slower than the stream, every character within 1.5s), draining at the stream's end instead of snapping and revealing a row born live from its first word, holding a bare block marker, a table's header row and a table row with only its pipes until they have content; each step is one span fading in over `--dur-reveal` on `--ease-reveal` (lib/streamReveal.ts, `.stream-step`), and the settle waits for the last fade. Code is not prose: inside an open fence a line shows once its newline arrives (a line held `REVEAL.lineHoldMs`, 600ms, steps by words) and fades in as one element. A list item, a table row, a heading, a quote's line or a fence born mid-stream rises 4px over `--dur-base` `--ease-out` as it fades (`.stream-rise`), a paragraph never; a table's card fades in with its header row. A thought's sentences are no stream: each lands whole in the reasoning column under the working line | — | whole-word and whole-line steps, no fade or rise |
| A streaming code block growing | its body glides to the new line's height, `--dur-base` `--ease-out` (`useHeightGlide`), while its row's reveal is armed; settled blocks never move | — | the height steps |
| Composer send | the bubble rides with the content as the prompt parks, rising 16px and fading in, `--dur-slow` `--ease-drawer`; in follow mode it flies from the field only when it lands within 240px of it | — | fade, `--dur-fast` |
| Composer field height | snaps on a keystroke and on the clear after a send; a change of more than one line the person did not type (a paste, a restore, a quote) eases over `--dur-base` | — | snaps |
| Composer, a new thread's first send | the box keeps its width and moves into its docked place (a FLIP translate, `--dur-slow` `--ease-drawer`) | — | none |
| Pane switch | opacity, `--dur-fast`; no rise; a switch by a key (⌃Tab, ⌘1–9) at once | — | none |
| The agents cue arriving in the title bar | fade, `--dur-fast` `--ease-out` (`@starting-style`); once there, a new count morphs its words (`MorphText`) and a provider's mark that joins grows from 0.25 on `--dur-layout` `--ease-layout` | at once; a mark that leaves goes at once | the fades |
| The slot above the composer emptying | — | the outgoing row stays, inert, and fades `--dur-fast` `--ease-out`; the 28px stays | at once |
| Switch (a setting's `Switch`, the rail's Away row) | the thumb slides on its clip-path, `--dur-slow` `--ease-out`, and grows 5px toward the other side on the track's hover; the track's fill changes over `--dur-fast`; the row around the Away track never moves | the same | snaps |
| Progress bar | the indicator slides by `translateX` inside its clipped, rounded track, `--dur-slow` (a scale would squash its round ends) | — | none |
| A Computers tile arriving | fades in over `--dur-fast` (`FADE_IN`); its controls come by the hover reveal | at once | the same fade |
| The Computer section's viewport arriving | fades in over `--dur-fast` (`FADE_IN`, `@starting-style`, on its wrapper, which stays through every change of face: a pin, Go live and a step by key fade nothing) | at once | the same fade |
| A frame, or a kept picture, replacing another in the viewport | none: the old picture stays until the new one has decoded, and dims to 40% over `--dur-fast` only when that takes more than 150 ms | — | the same |
| A step landing at the top of the Computer section while it follows; a batch settling into its steps | `.step-land` (fade and rise 4px, `--dur-base`), `--stagger-step` apart; never at mount, for the first read's rows, for a page of earlier steps, while a row is pinned or on a key; the class is the landing commit's own, gone at the next landing, so a group that moves in the list never plays it again | — | none (the class's own rule) |
| A row chosen in the Computer section, its facts opening, the running row's words changing | none | none | none |
| A step's read text opening | `Collapsible` (`--dur-slow` open, `--dur-base` close) | the same | opacity |
| The computer cue arriving in the title bar | fade, `--dur-fast` `--ease-out` (`FADE_IN`); its words morph (`MorphText`) | at once | the fade |
| The agent's click on the live viewport (`CLICK_MARK`, a Web Animation on the ring alone, placed at the click's share of the picture) | scale 0.6→1 at full opacity over `--dur-base` `--ease-out`, holds `FOLD_HOLD_MS`, fades over `--dur-slow`; a new click restarts it | — | appears and fades, no scale |
| A slide or a build changing in a show | a cut to a picture already painted: the page a press shows next is painted under the one shown, and the one shown stays until the new one is whole, so nothing dips to black | — | the same |
| The slideshow's bar | on a real move of the pointer: opacity 0→1 and a rise of 4px, `--dur-base` `--ease-out` | 2000ms after the last move (`PRESENT_IDLE_MS`), with the pointer hidden at the same moment: opacity →0 and 4px back down, `--dur-base` `--ease-exit`; held while the pointer is on it or its picker is open | opacity alone |
| The slideshow's picker and the presenter's target menu (panels of their own window, so no portal) | the popover's: fade + scale 0.95→1 from the trigger's side, `--dur-base` `--ease-out` | at once | fade only |
| The Mac's computer-use banner ("The Mac's computer-use banner" below) | opacity, `--dur-base` `--ease-out` | opacity, `--dur-fast` `--ease-exit`, then the window hides | `--dur-fast` |

Rules: animate `transform` and `opacity` (and height only through the
collapsible, the question card's frame between its questions, the slash menu's frame, or `useHeightGlide` for a box whose content grows while it is read); every animation is interruptible and starts from the current
value; nothing animates on a keystroke but the menu it opens; nothing overshoots without a
gesture; every animated class carries its `motion-reduce:` guard.

### The Mac's computer-use banner

The main process's computer banner is an Operate surface: one passive,
32px pill, “TempCode is using your Mac” in 13px foreground, with a 20px
key cap in 11px type and muted “to stop” eight pixels after it while the
Escape watch works. It uses the popover fill, border hairline and full
radius, with no shadow or glow. It ignores clicks and never takes focus.
The system theme sets its colours; `BANNER_TOKENS` mirrors index.css and
its test holds them equal. The only motion is opacity: `--dur-base` on
`--ease-out` in, `--dur-fast` on `--ease-exit` out before native hide;
reduced motion uses `--dur-fast`. No position or size transition.

### The capture window

The main process's capture window (src/main/capture.ts, page
work/capture/CaptureView.tsx) is an Operate surface he opens many times a
day with one key, so it has no open or close motion: it is made hidden
once the key is held and shown already painted, and it hides the moment
Return is pressed. It is 680px wide, a fifth of the way down the display
under the pointer, as tall as its page (no height transition). The window
is the surface, on the `popover` fill of Work's theme, with the system's
corners and shadow and no card inside it: the field (14/22 on 22px lines,
16px inset, `faint-foreground` placeholder "Capture…", growing to twelve
lines), the files he added as 28px rows (the file's glyph, its name, a
ghost Remove), a red 12px line when something stops it, then a 48px row
under a hairline: the sector as a `ChoiceToggle` (Unsorted first, then the
six sectors), and at the end Start thread (secondary, its key cap in
muted ink: the one key not plain) and File (primary): a capture on
its way shows nothing, since the window is already gone and the next draft
starts empty. While LifeOS does not answer, "LifeOS is not
connected" sits muted in the red line's place and both buttons are off. A drag of
a file over it shows the drop wash of the document surface ("Drop to
add"). It wears Work's theme and follows it.

## The transcript

The target is Claude desktop's Code tab with our tool icons and humanized
names kept (the plan at .temp-code/plan-h5M-bmLmzYd4.md fixes the rows,
.temp-code/plan-zY_qkaKjrxzL.md the metrics and the motion). It is tight: a
768px column (`COLUMN_MAX_PX` in surfaces/transcriptOutlineModel.ts) inside
the scroller's 16px gutter, the composer flush with it in every placement,
the root in the sans face at 13px. Whatever sits on the column (the working
strip, the load line, the no-rows line, an orchestration's fleet header, the
transcript skeleton) takes `COLUMN_MAX_CLASS`, never a width of its own; a
test refuses the old 896px anywhere in the renderer. A line outside the
scroller (the load and no-rows lines, the footer) keeps the gutter outside
the column, `COLUMN_GUTTER_CLASS` around `columnClass()`
(threads/chatSlots.tsx), never a padding inside it, so its text starts on
the column's edge at every width.

The composer is one row in its box, as Claude's: the `+` menu (28px) at the
left, the field, Send (a 28px circle) at the right, 6px from the sides and
8px from the top and bottom, so the empty box is 46px with its hairline. The
field's first line is centred on the controls' 28px line; each further line
grows the box upward by 22px while its bottom stays, and the controls stay
on the bottom line. The rows over and under the box (the slot, the queue's
heading, the row under the box, the draft row) take the box row's 6px inset,
so their first glyph sits on `+`'s axis. Under the box, 4px below it, a 24px row holds the model
at the left and the context meter and the permission mode at the right,
ghost controls in 12px muted text; it is always there, so nothing moves on
focus, and at a narrow width it gives way in order (the meter's percent,
then the model's effort, then the mode's label, then the model's name,
leaving their glyphs). The empty thread's composer and the docked one are
one class chain.

| Element | Size / line |
| --- | --- |
| The prose, the person's bubble, a question's prompt, the composer's field | 14px / 22px |
| A line: a group's line, an action, a notice, an approval, the closing line | 13px / 20px in a 28px row, 32px in an open group's table (12px in); the glyph in a 14px slot, 8px to the words, so words start at 22px; each word, detail, count or time 4px from the next; a chevron or the hover actions 8px after the last |
| Counts (`+46 −3`, a failed tally) | the text's size (13px in a row and on the group line) `tabular-nums`; the failed mark 4px from its number |
| Code in a row's body: a command, its output, a diff | 12px / 20px mono |
| A code block in the prose | 13px / 20px mono |
| Inline code | one pixel under its text (13px in the prose), `rounded-sm bg-muted` |
| A connector chip in the composer's field (`/linear`) | the field's text, medium, its brand mark 12px 4px before the name, on inline code's `rounded-sm bg-muted` |
| Headings in the prose | h1 16px / 24 semibold −0.01em; h2 15px / 22 semibold; h3 to h6 14px / 22 semibold |
| A table's cells | 13px / 20px, 36px rows |

The gap belongs to the boundary between two rows, never to a row:
`transcriptRows.ts` gives each row its `gap` from the row before it, and a
row that draws nothing takes none. 16px before the first row; 32px from the
previous turn to a turn's first row; 16px from a bubble to its first reply
row; 12px between two blocks (prose, a bubble, a card) or a block and a
line; 4px between two lines; 8px from the last item to the closing line;
8px under "Load earlier messages"; 16px under the last row. Inside the
prose (surfaces/transcript/markdown.css): 12px between blocks, 4px between
list items and into a nested list, 20px above a heading and 4px under it,
20px around a rule, 8px between two paragraphs in an item or a quote; a
list hangs its text at 22px, like a row's words.

The lines that remain: the hairline of one card (a row's opened body, a code
block, a table, a question, failure or held-review card, the composer), the
rules between a table's rows and the title bar's bottom border. None between
turns and none between rows; inside an open group a hairline parts two
table rows and nothing else. A blockquote is a 2px
`border` line with muted, upright text; a table's header has no fill.

The person's message is a right-aligned bubble (`card`, `rounded-xl`, 12/8
padding, at most 85% of the column) with no avatar or timestamp, its
preamble line 4px above it, its chevron trailing and its text ending on the
bubble's right edge. Attachments sit 8px apart inside it; past twelve lines
it clamps, and Show more is a 24px target whose words keep their place. A message the person sent into a running
turn (a steer) carries one 12px `muted-foreground` word under the bubble at
its right edge, Sent, Received or Queued for the next turn, or Not
delivered in the red tone; its time is in the word's tooltip, never in the
flow, and a word that changes on screen morphs (`MorphText`)
(transcript/UserMessage.tsx `SteerLine`). The model's prose is plain text.
Between paragraphs, the actions since the last paragraph are one muted line
("Created diag.ts, ran a command +46 ▾") that opens into a table under it, as
Claude's: one hairline frame with a 12px radius from the prose's edge across
the column, no fill, one 32px row per action with its words 12px in and a
hairline between two rows ("Created diag.ts +46 ▸", "Ran npx convex dev… ▸",
"Read types.ts ▸"), verb muted, object in foreground, counts green and red, a
caret per row. Every row of the list sits on one grid (transcript/stepLine.ts):
glyph, verb, target, counts, extras, caret, each slot only when it has
something: the glyph 8px from the verb, verb, target and counts 4px apart,
the extras and the caret 8px after the last value, 32px a row in the table; a call that names nothing reads its
verb alone ("Ran a command"), a connector's call names the connector
("Cosmic Admin  Build get"), a todo update's tally sits muted in the counts
slot, and a host step folded in reads verb then target like a call. A row's opened body is the row's lower part under one hairline inside an
open group's table; a lone row's is one card (a hairline, `rounded-lg`,
`bg-card`, 12px inset, from the row's glyph to the column's end); an edit's
diff takes the same card with its tints running to its edges. A lone command
opens a card headed by its tool name with the command in mono and its output
under it. An output shows whole, never cut: past 320px (`max-h-80`, sixteen
20px lines) it scrolls inside its own box, the one nested scroller "Scrolling"
allows, with no fill of its own (it sits in the card) and no "N more lines";
its Copy shows at the box's top right on hover and takes the whole output.
The box's cap is its row's height once open: the window measures it like
any row, with no containment. File changes keep their counts on the line and their diff behind
the caret.

The group the turn is working in opens on its own once it holds two calls:
the line folds open above the first row and the rows glide into their hang.
While it works it shows its newest five rows, the line still naming them
all, the running ones included; a call still running is no row (the working
line under the turn says it) and lands as a past-tense row once it settles.
When the work moves on (the model writes again, or the turn ends) it waits
`FOLD_HOLD_MS`, its last row landing, and folds. A person's hand decides for
that group from then on: toggling its line or opening a row's body inside it
ends the automatic open, window and fold, and a group opened by hand shows
every row, its thoughts among them. A step waiting on the person keeps it open; a paused turn holds it
as it is; a group that mounts while working shows open with no motion, one
that mounts settled shows closed. Live
background work is the right panel's Activity section; a task that settled
is one step of the run it woke ("Task finished  deploy the preview"),
never a row of its own. No timestamps
in the flow; the closing line says what the turn took and nothing else. A
live turn's time is the slot above the composer's: the transcript draws
the closing line once the turn is over, and a paused turn is not over (only
a surface with no slot, the fleet's agent detail, draws the live state as
its last row). A thread still watching ends in "Watching" with the watch's
age under its last closing line, on every surface; in a pane it opens the
Activity section.
An approval card carries the amber glyph and its two buttons, not the
word; the call's row above it keeps its tool icon, so the mark shows once.
In an open table the waiting approval is a 40px row, 6px round its raised
buttons, so their drop clears the table's clipped frame. A thought is no row: while it streams with words the working
line says "Thinking" with the block's seconds 4px after it, tabular and
muted, and its finished sentences arrive in the reasoning column under the
line (14px on 22px lines, muted, 8px between paragraphs, 192px at most
then scrolling, the cut edge fading 32px; Thinking alone until the first
words); once it ends the column folds away, and the thought shows only in a
group opened by hand, as its whole text in the entry's place (the thought
glyph in the glyph slot, the markdown in the column's type on the text
column; no word, no chevron, no duration). Each live
turn ends in one working line, from Send to the turn's end: the working
mark, then the phase's words in the shimmer (one running call by its verb,
muted, and its object in foreground, with an edit's live counts, or a
chevron that opens a command's or a tool's body under the line). It folds away
while a step waits on the person (the card says so) and while the turn is
paused, and comes back in the same element; a Stop turns it into Stopped at
once. When the turn ends, and its text has finished appearing, it becomes the
closing line, which reads "Worked for 2m 4s" ("Worked" until the time lands), its copy, note, hand-off and second-opinion
buttons showing on hover or keyboard focus; a turn the person stopped
closes on "Stopped" instead, with the same buttons. Every notice (a gate, a review, a compaction, a
pass, a batch, a second opinion asked of another harness) is one muted
line with a glyph, a lead in medium weight and its details as one muted
comma run after it ("Release passed on master, release-277"); a phrase stays whole in the run, so a lead that needs its preposition keeps it ("Gate failed on") and a label ends in ":" ("Answered Approach: Fast, Small"); only a held review and a failure
are cards. A compaction is one line that counts from its start, takes
its outcome in place and reads "Compaction stopped" when its turn ended
without one; its lead and details follow the same rule ("Context compacted
414K → 3.6K, 1m 29s"). The host's steps of the agent's work fold into the run they sit
in, as calls do: a subagent spawned (on its call's row, one row per child
for a batch), each agent that settled ("Finished", "Failed", "Needs you",
"Stopped" or "Paused", then its title, behind the state's glyph), a
finished task, the check on idle tasks, a gate or release outcome, a review
that merged, the turn pass, the plan's build hand-off, a merge the batch
made, and what happened while the person was away (a decision the thread
noted, a question the host answered for them, an approval it skipped). An
away line is the host's words, muted; a question leads with its still help
glyph and an approval with its lock, both in the muted tone, and a decision
has no glyph. A held review, a failure, Stopped, compaction, "Batch done" and
account-gone stay lines of their own. Every agent row names its agent by
title, the one bright text on its line (28px alone, 32px in a table), and an open wait is no row:
the working line says "Waiting on <title>", drawn like a call: "Waiting on"
muted, the title (or "2 subagents") in foreground. A handoff keeps its bubble: its text is the person's brief. The
left side, where the column leaves room, lists the person's own messages,
one line and a clock time each, the one being read in foreground
(`TranscriptOutline` on `JumpList`; docs/LAYOUT.md "Chat"). A
question card sets the sans face; mono is for code inside it. It is the one
card the transcript allows: a hairline on the card fill, 12px corners and a
16px inset (`QUESTION_SHAPE`, surfaces/QuestionCard.tsx; the held review keeps
`CARD_SHAPE`), and inside a `bg-card` body it draws no second frame. Its title
is 14px medium by the amber Needs you glyph, flat, and a set of more than one
question ends the title row with where the person is ("2 of 3", 12px muted,
tabular). Its question is at the prose's 14px on 22px lines, its options a
flat list of 36px rows 4px apart (a menu row's 8px radius, 8px above and
below the 14px label's 20px line) with an option's description as a muted
13px line under it; the 20px key cap sits on the label's first line. Selected
is the row's fill (`foreground/10`) and the cap turned primary, never a
border; hover is `foreground/5`, a press `foreground/12`, all at once. Its
actions end the card 16px under the options, right-aligned 8px apart, the
raised buttons at `sm`: Back and Skip `secondary`, Next or Continue (with ⌘⏎)
`default`; Back arrives at the group's start, so Skip and Next never move. Every action
row ends in a caret: it turns on a row that opens a body and stays still on
one that opens its file.

A computer call that returned a picture the model asked for stands as its
own row where it settled, as a published page does: its line as a lone
step, then 8px under it the picture at the column's width in its own shape,
at most 320px tall (two to four in one line 8px apart, each at most 240px
tall and keeping its shape), `rounded-lg` on the `image-outline` edge, a
`Skeleton` in that shape while it loads, a click opening the lightbox from
it; a file its host no longer has is one muted line in its place. A running
computer call is told by the working line in the host's words ("Clicking
Save in TextEdit"), and a held one says the scheduler's line whole.

## Restraint

No cards within cards. No glows. No decorative badges or chips. No
repeating the same data twice. No over-explaining: states are shown, not
narrated. No colour without meaning. No shadows on docked UI. No left colour
bar for focus or selection (a focused or selected row is a `muted` fill).
No bullet points in the UI. A toast never covers a control: the stack sits
8px above the focused thread's strip, 16px inside its column's right edge
and no wider than that column less 16px a side (`toastInset` in
components/ui/toaster.tsx, measured from the footer `ChatFooter` registers in
lib/toastAnchor.ts); on a master view whose chat is folded, 8px above the
board's foot (BatchFoot registers while the chat is folded, and a folded,
inert column seats nothing); and 16px from the window's corner where no
thread is focused. Confirmation dialogs only for destructive,
irreversible actions. Every spacing and timing value is a token we can name.

## Verifying without a dev instance

A renderer change proves itself with a jsdom DOM test beside the component
(`*.dom.test.tsx`, `NODE_ENV=test npx vitest run <file>`), the renderer
typecheck (`npm run typecheck:web`) and, for anything visual, a static
render through `html_preview` (render the component with
`react-dom/server`'s `renderToStaticMarkup` against `out/renderer`'s CSS,
or a hand-written HTML sketch of the same tokens). The one electron-vite
build per branch is for `bun run check:bundle`; the index chunk stays under
5 MiB + 16 KiB and imports no lazy surface statically; of Base UI only the dialog
is in the first paint (the tooltip defers its primitive, the menus and popovers
ride the menu chunk (drawn by their parts through components/ui/lazy-menus.tsx), and every select the select chunk: the composer's pickers and every
`ChoiceSelect` draw the same trigger, at the caller's size and width, until it
lands, components/lazy-select.tsx).
