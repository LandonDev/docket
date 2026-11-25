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
page, the compare and History views, the Outbox, Today's page, the
routines' week grid, and a show's two windows (the slideshow and the presenter's view:
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
| `stage-doing`, `stage-waiting`, `stage-done` | a stage of work as a mark on the project screens (a state's glyph, a meter's segment), never a word. Work in hand takes no hue, as a working thread takes none; a waiting mark stays apart from late's red | `muted-foreground`, `waiting`, `success` | `muted-foreground`, `#d9620b` (a mark's 3:1, lighter and yellower than `destructive`), `success` |
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

### File kind tints

A file's kind has one colour, and only its glyph takes it, in the Files
place's rows, tiles and file headers, and on a template's tile, which is a
file's tile (the Templates view and New from a template). `KindGlyph`
(work/files/KindGlyph.tsx) draws it. Never a row's fill, a chip, text or a border, and never on a canvas
tab row or the sidebar's place rows: there the glyph is `muted-foreground`.

| Token | Kind | Dark | Light |
| --- | --- | --- | --- |
| `kind-doc` | document | oklch(0.72 0.13 258) | oklch(0.52 0.16 258) |
| `kind-sheet` | sheet | oklch(0.76 0.14 155) | oklch(0.53 0.13 155) |
| `kind-slides` | deck | oklch(0.74 0.13 300) | oklch(0.52 0.17 300) |
| `kind-pdf` | PDF | oklch(0.74 0.13 348) | oklch(0.54 0.17 348) |
| `kind-image` | picture | oklch(0.77 0.11 192) | oklch(0.54 0.09 192) |
| `kind-video` | video | oklch(0.74 0.11 225) | oklch(0.53 0.1 225) |
| `kind-audio` | audio | oklch(0.8 0.14 125) | oklch(0.55 0.13 125) |
| `kind-text` | text | oklch(0.76 0.015 270) | oklch(0.5 0.012 270) |
| `kind-folder` | folder | oklch(0.78 0.035 250) | oklch(0.48 0.035 250) |

Archive and other have no tint: they stay `muted-foreground`. Text and
folder are near neutral (chroma under 0.04): plain text needs no hue, and a
folder holds files of every kind, so it must not look like one of them.

Three rules hold in both themes. Each tint stands at least 30° of OKLCH hue
from `warning` and `destructive`, since amber means the person is needed and
red means failed or delete; a near-neutral tint reads as no hue and is exempt.
Each reaches 3:1 on `background`, `card`, `popover`, `sidebar`, a selected
row (`muted`) and each of those hovered (`foreground` 5%). And no two of the
seven with a hue stand within 20° of each other.

So a PDF is not red and a deck is not orange here, as they are in Office: both
would read as a failure or as Needs you. A PDF is rose, 34° from dark's red, and
a deck is violet. Documents are blue, sheets green, pictures teal and video a
sky blue. `lib/kindTint.test.ts` holds the rules and the nine names;
`lib/tokenContrast.test.ts` counts the tints among its marks.

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
| `sel-line-dark-pic` | a picked shape's outline and handle edges on a slide ("The slide editor") | `hsl(211 92% 62%)`, in both themes |
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

A canvas chart of one series is the neutral (a sheet's own charts are
not: they wear the file's theme, "Work editors"), never a provider's
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
the literal `text-[12px]` throughout renderer source, and under
src/renderer/src/work any literal size but 11, 13 and 15 and anything above
`text-lg` ("Work's sizes are on the scale"; the clicker, a phone page, is
its one exception).

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
As a bar narrows, the least fact gives way first, and whole: a name the
place already says elsewhere goes rather than stand cut to a stub ("Age…"),
and a press that goes keeps its way in (an icon with its tip, or the menu).

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

### Reduced motion

Reduced is fewer and gentler, never none. Movement goes: a slide, a rise, a
scale, a glide, a spring, a smooth scroll becomes a fade over `--dur-fast`, a
step or nothing. Fades and colour changes stay. The marks that say work is
going on keep moving whatever the setting: the spinner turns, the working
mark's dots gather and part, the shimmer crosses its words, and streamed text
fades in word by word as it arrives (only its 4px rise goes). A still screen
cannot say the app is working.

The rule is one place, lib/motion.ts. Settings → Appearance → Motion is
Follow this computer (the default), Full or Reduced, kept per window origin
as the themes are. Follow this computer reads the system's reduce-motion
setting, which Windows turns on whenever its animation effects are off (a
managed PC, a remote session, a VM; the 1.0.377 Windows build went still on
one). `initMotion` writes the answer on `<html data-motion="full|reduced">`;
a stylesheet's reduced rules sit under `:where([data-motion="reduced"])`,
Tailwind's `motion-reduce:` and `motion-safe:` read the same attribute
(index.css), and scripts ask `reducedMotion()` or `useReducedMotion()` from
lib/motion.ts, never `matchMedia` or motion's own hook. lib/motionRule.test.ts
refuses a reader of the media query anywhere else, a blanket
`animation: none` or `transition: none` under reduced motion, a stop on a mark
of work, and a keyframe animation stopped without its fade unless it is
listed with what still moves. work-kit's own stylesheets and scripts still
read the media query: they follow the computer, not the app's choice.

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

One name a thing, in every view of Work. A job is its workspace's name
("Purdue Esports"), never the sector's word (`jobNameOf`, work/jobName.ts;
the sector's word only where no workspace holds it); a picker of jobs is
"Job". A length of time is `durationOf` ("12 min", "1 hr 10 min",
src/shared/work/duration.ts); a span of time "4:00 to 6:00 PM"; a leave
time "Leave 4:22 PM"; where you are in a bar "1/8", "Page 1 of 14" where
there is room. A host mid-line is lower case where its name is a common
noun ("the box", "this Mac", `nameInLine`, lib/hostWords.ts). LifeOS signed out is
"Not signed in to LifeOS on the box" with Sign in, where the host said signed out (the computer named wherever it is known, as `workErrorWords` says it); a host that says only that LifeOS is "not connected" (any state but connected) reads "The box cannot use LifeOS now. See why under Settings, Connections." (`lib/workErrorWords.ts`). A conflict's second press is Keep
Both; a mail's file is kept with Save to workspace; a proposal is Dismiss
and Add (Add… when a dialog follows), and Not now only for a one-line
offer it puts off. Connections' healthy word is Ready, since Working is a
running thread. A path, a port, an id or a program's name is never on
screen: a host's error is worded once, in `workErrorWords`
(lib/workErrorWords.ts).

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
`useConfirm()` (chrome/ConfirmDialog.tsx), never `window.confirm`. Where
leaving loses something unless he picks how (a copy's changes that have
not reached its file), the confirm takes one second answer, secondary,
between Cancel and the verb (`confirmChoice`: Cancel, Discard, Keep
trying). A
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
it on mount, text changes and resize. Its text breaks a word too long for
the tip, such as a link. Activity labels, fleet goals, home
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
hovering 8px past the words (7px and the item's 1px border, so its words and
its control start and end on a plain row's edges), and the switch and ⋯ at
its end sit above it, so pressing them never opens the row. A row's
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
- **The page** covers the thread area as the Inbox and the Outbox do.
  Its 40px header is the bar of the computer on the stage (below); the
  page's own name stays as its heading for a screen reader, and shows,
  with the `Desktop` glyph, only when nothing is driven. Closing it
  returns him to the thread he left. To keep one computer in view while he
  works he pops it out: the one thing in the app that floats, because he
  asked for it.
- **The bar** (`ComputerBar`, surfaces/threads/computer/ComputerBar.tsx)
  is one 40px row that says whose computer it is and holds every press it
  has. One grammar in three places: docked as the page's header, afloat in
  full screen, the handle of the pop-out. In order: the glyph (the Windows
  VM's screen, the box's page, a Mac's or a PC's window), the title (13px
  medium; a press closes the page and goes to the thread that drives it;
  the VM's own name is no link), then on the same line one 12px muted
  comma sentence: what it is doing in the step's own words, then where it
  runs ("Clicking Save in TextEdit, Landon's MacBook"). While he drives the
  first words are "You are driving", in foreground; while a card waits on
  him they are the card's question, in foreground. A VM that shows only
  its 4 fps picture says "No live picture to drive", which is why it has
  no Take over. At the row's end, always shown and never behind a hover:
  - **the delay**, a ghost button with the whole delay the app can
    measure ("31 ms", tabular, muted). It is not drawn at all until the
    stream has a number. Opened, a popover lists Delay, Frames, Picture
    and Link. On a poor link the number gives way to "Link poor", in
    foreground; opened, it says "The link is slow", why, and offers Use
    Faster where Windows takes it now. Poor is one rule
    (lib/video/linkHealth.ts): frames 120 ms late at the 95th centile
    over 3 s, or two `slow` closes within a minute; it clears after 5 s
    clean. Nothing here moves or takes a colour at rest.
  - **Keys**, while he drives the Windows VM: a ghost icon button with a
    tip opening the keys his own keyboard keeps (Windows key,
    Ctrl+Alt+Del, Alt+Tab); a pick gives the keyboard back to the picture.
  - **The VM's menu** (a ghost icon button, "Size, sleep and more"): Size
    (Fit to window, 1280 × 800, 1920 × 1200, 2560 × 1600) and Detail
    (Sharp, Faster), ticked by the host's choice, off with their reason as
    the row's line while a thread holds it or until live resize is on;
    then Sleep and Restart Windows… (a confirm first; off while a thread
    holds it), Sign in to Office and OneDrive… (the sign-in Connections
    walks), Restore points… (Settings' own dialog). A row this window's
    key may not use is not drawn.
  - **Take over** (secondary, only where the computer takes input from its
    picture: the box's page and the Windows VM with its window) and
    **Stop** (a quiet icon button with a tip; none on an idle page). While
    he drives, **Hand back** alone, the page's one primary button, with
    the chord that leaves the picture as a key cap inside it. A VM not set
    up has Open Settings in their place; after his own Sleep, Wake.
  - **The views**, 8px on: Pop out and Full screen, quiet icon buttons
    with tips.
  Under 640px of its own width the delay and Pop out give way, whole;
  under 480px the status sentence too, so the title reads whole. Afloat
  in full screen it gives nothing way. No toast says the
  leave chord: Hand back wears it. While he drives, Escape is the
  computer's key and never closes the page. Leaving the page with nothing
  else of his showing that computer hands it back by itself 1.5 seconds
  later (lib/driveHold.ts).
- **The stage.** One computer has the page (`ComputersPage`, the layout
  in `lib/stageLayout.ts`). Its picture has all the room under the bar,
  16px in, and sits in the middle of it both ways, in its own shape
  (`fitStage`, the fill rule). A whole computer's screen (the Windows VM)
  fills that room: it is the computer. A window's picture (a Mac's, a
  PC's, the box's page) is never drawn past twice the stream's own
  pixels, so a small window stays small instead of turning to blur, and
  grown past them it is drawn at a whole number of screen pixels to each
  of the stream's (1:1, 2:1) when that costs at most a fifth of its width.
  Drawn at two or more screen pixels to each of the stream's, exactly, its
  pixels are doubled crisp (`image-rendering: pixelated`); at any other
  scale it stays smooth. It takes the box's one display and is where he
  drives. When Windows sends a separate hardware cursor, the picture uses
  that shape as the native cursor while he drives. Its size follows the
  picture in whole device pixels and its hotspot scales with it. The Mac's
  arrow shows before the first shape and for shapes over 128 CSS pixels.
  A fully clear shape hides the cursor. A watcher sees the ring on a
  thread's click and no hardware pointer while he drives.
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
- **The picture** is the Computer section's viewport with no cap of its
  own (`fill`): its place sizes it. Every face it has takes one size: the
  stream's frame, else the last frame that window saw of that computer,
  else the VM's 1280 by 800, through the stage's fit, so nothing moves when
  one gives way to another. A skeleton until the first frame; a click on
  the stage's picture opens full screen. A session this desktop may not
  draw is one muted line in the box's place, naming the machine: "Shown on
  Studio only". The browser /ui lists the tiles with no picture at all.
- **The faces.** Each state has one: a plate of words, centred (13px
  medium, a 12px muted line under it, a spinner where it waits, one press
  where it has one), over the last picture washed back (`Plate`,
  Viewport.tsx), or over the bare box where there is no picture to keep.
  Asleep: the desk the VM slept on, "Asleep", "Since 1:14 PM". Waking:
  "Waking the Windows VM", "6 s of about 13", counted against the keeper's
  median of its last five wakes ("6 s" before it has one). The stage's
  picture fits the page's measured room; before it is measured the picture
  takes the page's width, never a fit to nothing. Connecting: the last picture under a
  lighter wash, which fades out over `--dur-base` once the first frame is
  on the canvas; nothing moves. Lost (the host's link down): "Reconnecting
  to The box", "Try 2 of 5", then "The picture stopped" with Retry; no
  stream is asked for meanwhile. Not set up: "The Windows VM is not set
  up" on the bare box, and the bar's one press goes to Settings. The
  keeper's own work (a restart, going back to a restore point, a move to
  live resize) says its own words with a spinner and no press. A failed
  wake says why, with Retry. "The preview stopped" and Retry are for a
  stream that truly ended with the host linked. The host keeps the desk
  as it goes to sleep (QMP's screenshot, a JPEG under
  `<userData>/winvm/picture/`, `work.winvm.still` under the rule its video
  has).
- **The Windows VM** is one tile in every state, titled by the thread that
  holds it, or "Windows VM" when no thread does (then idle: no Stop, no
  working mark). Its picture is the VM's own under its name, whichever
  thread holds it, so the tile stays one element as the holder changes and
  as it sleeps and wakes. On the stage a VM asleep or going to sleep wakes
  by itself, unless his own Sleep put it there: then it waits for Wake in
  the bar. In the strip it waits for his press, which puts it on the
  stage. Take over on a VM that is not awake wakes it and then takes over:
  one press. It has no Pop out or Full screen until it has a picture.
- **Nothing driven** is the one `EmptyState`: "Nothing is being driven",
  "A browser or an app an agent is using shows here, live." No action.
- **Full screen** (`FullWindow`, lib/fullWindow.ts, its own chunk; main's
  fullScreen.ts): one computer over his whole display. The window itself
  goes full screen (on a Mac on this Space, at once, with no menu bar or
  Dock) and the picture fills it on `matte` (black in both themes, so no
  words sit on it), centred both ways, with no inset: a whole computer's
  screen as large as the display allows in its shape (the 1280 by 800 VM
  is 2880 by 1800 points on a 3200 by 1800 display), a window's picture by
  the stage's rule. The bar floats over the top edge's middle on the
  popover's ground, 8px down and at most 560px wide, hidden until called:
  the pointer resting 250 ms on the edge's middle 240px (the one part of a
  maximized Windows app with nothing to press), or ⌃⌥. It comes by
  opacity and 8px down over `--dur-base` on `--ease-out`, goes over
  `--dur-fast` on `--ease-exit` 600 ms after the pointer leaves it, never
  while one of its menus is open, and comes by itself once when the link
  turns poor. Pop out and Leave full screen sit at its end. ⌃⌘F leaves
  (and from the Computers page takes the stage's computer in: View →
  Enter Full Screen); Escape leaves when the picture does not hold the
  keyboard; a double click on the picture leaves when he does not drive.
  While he drives, the picture holds the keyboard as the computer's own:
  ⌘ is Ctrl, ⌘ alone the Windows key, ⌘Q Alt+F4, and no app shortcut
  runs; ⌘Tab and ⌘Space stay the Mac's. The two ways out are said once on
  each entry where he drives, for three seconds: one quiet line at the
  foot of the display, 24px up, centred, on the popover's ground (12px
  muted, `rounded-lg`, `shadow-overlay`, a ring), each way a key cap and
  its words, 16px between the two: "⌃⌥ frees the keyboard" (the picture
  goes to Hand back, and the bar comes) and "⌃⌘F leaves full screen"
  (Ctrl+Alt and F11 off a Mac). It fades in over `--dur-base`, out over
  `--dur-fast`, takes no pointer, and goes at once on Hand back. A click
  on any live picture or the bar's Full screen opens it, the picture
  growing from where it was over `--dur-slow` on `--ease-out` (reduced
  motion: a fade over `--dur-fast`); the key's entry has no motion. The
  VM going to sleep under him lets the keyboard go and shows its asleep
  face. A window he had full screen himself stays so when it closes. It is
  another canvas on the stream the place already plays, never a second
  stream.
- **Pop out** (`PopOut`, lib/popOut.ts, main's popOut.ts): a small
  frameless window over every app, every Space and every workspace, with
  no place in the Dock: the bar on top, 36px, as the window's handle (the
  title 12px medium and truncating, Keys while he drives the VM, Take over
  or Hand back (xs) and Stop where the stage has them, then Back to the
  page, Full screen and Close, quiet icon buttons with tips that open in
  its own window), and the picture under it, fitted in its shape by the
  stage's rule. It opens without taking the keyboard, at 384 by 276 the
  first time and where he left it after, takes any size he drags it to (no
  smaller than 240 by 186), wears the main window's styles and theme and
  follows a change, and closes when its computer leaves or the main window
  closes. Back to the page brings the main window in front with that
  computer on the stage. Full screen (or ⌃⌘F) takes it over its own
  display, its picture on `matte`. The main window draws it, on the
  stream it already plays: it is never a second stream.
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
  a point at its foot; saving and going back only while it sleeps; a bone
  holds its count's line while the points are read), the
  edition with its end date, and Office. A Work workspace's own page has
  "Computer use on the Windows VM" under Where it runs, a switch shown only
  where its host has the VM set up.

#### The canvas pane

Every kind's body is built on the pane's frame (the tab row, the kind's
bar, the fold, the review stepper, the selection bar and the composer's chip
row); the slides kind's PowerPoint side is "Open in PowerPoint" in the
`EmptyState`'s title, the bar keeping what waits in TempCode and Review. A sheet's
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
  anywhere but the composer's box, and a Work view anywhere.
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
- **A file opened from Files** is the file, not a chat: it opens in a tab
  of the Files place, in its viewer under its own header, and no thread is
  made for it until he sends in the chat Ask docks beside it ("The Files
  place"). Where the workspace's host is a release
  behind and keeps no tabs, it opens as it did before: the item in a new
  thread's canvas with the thread folded away, and the thread that already
  holds it shows it again. An item whose viewer fails, with nothing to
  show, is the centred `Empty` in the body's place: "Couldn't open this
  document", the reason in his words (`workErrorWords`, naming the pane's
  computer: "The box is not connected. Try again once it is back.") when
  there is one, and Retry (`OpenFailed`, work/canvas/FetchState.tsx); never a red line
  over a blank pane. The document, the sheet, the PDF, the deck, the
  media viewer and the meeting all draw it; a Keynote file he must export
  first has no Retry. The state line stays for a failure that leaves
  content shown (a picture the deck could not draw, a version beside the
  one shown, a task not filed).
- **The tab row** is 36px on `sidebar`, as the title bar's strip: tabs
  28px on the strip's chip shape (6px radius, 2px apart, 6px from the
  row's ends), the kind's 14px glyph, the name, no dirty dot; the selected
  tab is `sidebar-group-selected` with foreground text, as the Files row's
  (`muted` on `sidebar` can barely be seen in light; dark sets the token to
  `muted`). One item alone is its glyph, its
  name as the split view's 14px semibold title and one 12px muted fact.
  Each closes by its own ×, the Files tab's (a 24px ghost glyph in
  `muted-foreground`): on the selected tab and on the tab under the
  pointer, lying over the tab's end, and always right after a lone
  item's name. Every tab keeps the close's room, shown or not, so a name
  is cut at one point and nothing moves under the pointer. Past what fits
  the selected tab keeps its name and every other gives up the same part
  of its own, down to 128px (`tabShrink`, `tabMin`, the Files row's rule),
  and then the row scrolls.
- **The kind's bar** is 32px on `background` (the editor's `FileHeader`
  row), 12px muted, in a fixed order: other people as 20px avatars, the
  mode ("Agent suggests" or "Agent writes", a quiet menu button), the
  kind's own tools, Download and Save to workspace (a copy of someone
  else's file: a mail's attachment), History, then the review stepper at
  the end. A kind
  with nothing to put there draws no bar. A second file beside a Files
  tab's own leads the bar with its glyph, name and save line and ends it
  with its close, one row level with the bar beside it. A quiet line's cut
  reason is a Tab stop with its whole words in a tooltip, as a state
  line's detail is. The agent suggests on what
  other people can edit and writes, with history and Undo, on what only
  the person sees; the mode says which.
- **The review stepper**: Previous, "2/6" tabular, Next, Reject (ghost),
  Accept (secondary). It is the one place to accept or reject inside the
  item; Accept all and Reject all live in ⋯, under the kind's own verbs
  on the item (Export transcript, Download recording), each row a glyph
  and a verb. The current change is
  outlined. A move counts as one change, tinted where it lands and where
  it leaves. After a direct write the stepper's slot holds the settled
  line ("Wrote 2 sections, 2:04 PM") with Undo; under a save line that
  already says 2:04 PM it is "Wrote 2 sections".
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
  cannot be reached while its content stays: glyph, a medium word in its
  tone, a muted detail, one action, 32px, a hairline under it. Never a
  second banner. Amber is for a line that needs him; how an item is, with
  nothing asked ("Read only" and why on a sheet, a deck or a document he
  may not change; "Moved." and "The copy from Nov 16, 9:12 AM" on a PDF
  whose file moved), is the quiet line: 12px muted, the word
  medium, its one press a link, a hairline under (`QuietLine`, tone
  `quiet`). A document gone offline asks nothing of him either: its quiet
  line ("Offline." and "Edits stay here until the box is back.", naming
  the computer) is laid over the text's 32px top padding, never above it,
  so the text does not move when the link blinks; it shows after 1.5 s. In
  Pages it lies on the stage's own ground, and the stage keeps 32px over the
  first sheet while it shows, so it covers neither the sheet nor paints a band
  of page colour across the grey.
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
- **Avatars** are Work's one face (`Face`, work/mail/face.tsx): initials
  on `muted` on `image-outline`, 11px medium, one letter under 24px and two
  from 24px, 20px in the bar, 24px in lists, overlapping 6px with a 2px
  `background` ring. The canvas bar, media notes, History, Share and the
  projects kit draw the same part.
- **Share** is a ghost extra-small verb in the bar of every document and
  sheet, and Share… in More, in File and in a Files row's menu; each opens
  one sheet, the medium modal: "Share" over the item's name, then For (a
  field), Can (a toggle row, only where there is a choice) and Ends (a
  select); Create link puts the address in the form's place, once, with Copy,
  and the footer's start holds New link. Under a hairline, the item's live
  links, 44px rows: the 24px face, the name, one 12px muted line ("Edit,
  made Nov 20, opened Nov 22 3:10 PM, until Dec 20", no role where there
  is no choice; `linkFacts`, guests/api.ts, the one way a link's facts are
  said, Settings' Guest links adding what it is to) and a ⋯ menu: Replace
  address…, the roles as radio rows, Revoke…. Replace address… and Revoke…
  each ask first; Replace shows the new address once, with Copy, in the
  form's place (in Settings, in the link-made dialog); Revoke has no Undo,
  since an old address must never open again. No links: nothing under the
  form. A document or sheet no link can
  take shows one 13px muted line in the form's place, saying what to do
  instead, and Done; until the host answers for the item the sheet is the
  form's bones with Create link greyed, never a form it then refuses. A file
  in a place others open takes no guest link: its Share reads "Share in
  Teams" ("Share in OneDrive" for his own) and opens the file's own page in
  his browser, only where the workspace's host knows that file's page in his
  tenant (a document kept for a Teams Word file goes to the Word file's);
  where it knows none, a Files row's is greyed with "Share it from Teams."
  A Purdue workspace's sheet holds one 12px muted line at
  the footer's start, beside Create link. **History** on a document or a sheet opens the item's history as a tab of its own
  (in a Files tab, at the file's side, where a second file sits; "Compare
  and History" below);
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
  widths and scroll; a number never clips. A sheet's charts and pictures
  wear its theme's colours ("Work editors": a sheet's charts and
  pictures). A Microsoft-hosted file has a switch in the tab row
  beside ⋯ ("TempCode", "Excel"); the hosted app then fills the body edge
  to edge and our formula bar and sheet tabs go. An opened Excel file that
  holds what only Excel does says so at the end of the kind's own tools
  in the bar, under the switch it explains and apart from the mode's
  word, in the bar's own 12px muted text with no glyph and no chip: "2
  pivot tables and macros open in Excel". The line gives way through its
  words before any control does (it truncates, with the whole of it in a
  `TruncateTip`).
- **Document.** The shared block editor in a 672px measure, a 52px
  leading gutter for the block handle, a 24px glyph rail in the trailing
  gutter when 24px is free, and a margin column (24px gap, 272px card)
  from 1104px of canvas; under that the outline wins on a long document
  and the cards go under the text. The margin cards hold comments; a
  change is accepted only from the bar's stepper. The agent's words arrive by `REVEAL`. Underline and
  Strikethrough leave the selection bar under a 520px text width.
- **PDF.** Paper on `stage`, 12px between sheets, a 24px side inset (12px
  narrow), Fit width from 0.3 to 1.25 or 100, 125 or 150%, a 232px margin column 16px
  off, a 76px thumbnail rail (60px narrow). Margin notes are 13/20 muted,
  foreground when picked. A citation in the thread ("p. 6, clause 7.2")
  is a link that scrolls the page and marks the clause with `sel-bg-paper`
  until Escape or a press on the page. A highlight is the paper's ink at
  22%; from the press until the host makes it, the words keep the
  selection's tint.
  A field the agent fills is a suggestion; signing is never the agent's.
- **Slides.** A 96px thumbnail in a 140px strip, a 3px tint frame at 6px
  radius round a 3px-radius slide, the stage on a 16px inset, filling the
  pane at Fit (as wide as the room, short enough that the notes start on
  screen) or the slide at 50 to 200% of its own size (100%: 96px an inch)
  from Zoom in the bar, scrolling where it is wider; a four-column grid at 12 by 16 gaps, a 164px outline preview.
  Notes under the stage are 14/22 under a 12px medium muted "Notes": where
  he can edit the deck by hand a borderless field in the same type, "Add
  notes" when empty, kept after a 2s pause, on leaving it and on Escape,
  as the typing box is. The
  TempCode and PowerPoint switch sits in the tab row, as the sheet's does.
  Its PowerPoint side is the empty state "In PowerPoint" with the computer
  it opened on as its line ("On the box", "On this Mac"), so from another
  computer he knows where the window is.
- **Images and video.** The frame at radius 8 on `stage` with a 12px
  inset; the scrubber a 24px hit row with a 4px `track`, a 12px head and
  2 by 6 ticks in `success`; the transport 32px; list rows 32px or more on
  a 36/20/1fr grid; a side list 240px, under the body below a 600px body.
  Ask on a stretch or a region chips "start to end, file" or "Region of
  file". The transport has a Comment button that notes the frame shown,
  with no selection; an image region's selection bar has Comment, not
  Copy. Full screen holds the whole player: the frame grows to the
  screen less the track and the transport, which come with it. Two
  versions compare inside the item, side by side on one
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
- **Microsoft form.** The real Forms page in the Office-live guest, his
  own to edit, beside our Responses. The bar holds the mode, then the 24px
  segmented switch Form | Responses (the unseen count after Responses in
  muted tabular text), then at the end: the stepper while agent changes
  wait; Collect responses (the one primary) while a draft; while
  collecting, the response link in `link` with Copy and Close form, the
  address giving way to a worded Copy link under 600px; while closed, one
  muted line "Closed 12:00 PM" with Reopen. Collect responses is held, as
  Publish is; Close form and Reopen are not. Responses is our form's
  Responses (forms/responses.tsx), its summary saying "as of" once when the
  read is old. A change the agent made reloads a guest he has not typed in
  for ten seconds; otherwise the state line says "Changed by the agent"
  with Reload. More holds Open in Browser, Open the Workbook once Forms
  made it (Excel for the web in a Files tab), Question History… (a dialog of
  each change in words, newest first, under a 12px muted line of who and
  when: You, An agent, Seen in the page) and Check for Answers.
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
  dashboard. An empty one says "No numbers yet" and "Ask for one in the
  thread."; a dashboard, a form or a live page whose first read fails is
  the pane's centred failure with its reason and Retry (`OpenFailed`).

Around the canvas:

- **The Outbox** is hand-made on the split surface (the Inbox frame),
  built around how he decides (docs/agents/work-outbox.md "The screens").
  Tabs Waiting and Done, no counts. Waiting's order: Not sent, Starts soon
  (an invite whose event starts before the end of tomorrow), one group per
  thread by the jobs' rail order, then Scheduled; each section only when it
  has rows. A section's heading is 12px medium muted; a thread's group heading
  is the job's dot, the thread's title at 12px medium and the job's name muted
  (it gives way first), with Select N on hover; a group over five shows four
  and "N more". A row is one 32px line: the kind's 14px glyph (the red mark
  for a failed send), the act, what it is about muted (it gives way first,
  and hides under 640px), and one trailing word at 12px: the event's start in
  the foreground, when it goes, "Out of date", "Changed", else when it was
  held. A tick takes the glyph's place on hover and stays on every row while
  any is ticked, but a failed row keeps its red mark until it is ticked
  itself. The detail, in a 688px column: the facts line (the job's dot
  and name, "from" the thread as a link, the time), the act as a 16px title,
  one 14px sentence of what the press does that the thing below does not say
  (a mail's From and To are its fields, so its sentence is "Goes after your
  30-second undo."; a timed send's is when it goes, once, in the zone he named
  first and the window's after where they differ), the notes that apply
  (one 13px muted line each behind a 14px glyph: not sent, out of date, the
  thread rewrote it with Show changes, someone wrote back),
  then the thing as it will arrive. Show changes marks what moved in the
  thing's own slot, never a second copy of it, read as the view reads (its
  order, each address muted after its name, its files) with Send still live: a field's old value muted and
  struck before the new, the body's words taken out muted and struck, 4px
  before the words put in on a light accent tint. A failed item leads with
  its refusal; when the failure will repeat as it stands (too large, refused)
  the fix is the primary press, Open the thread for a refusal of its files
  (the editor cannot change them), else Edit, and Send again steps down into
  the fix's menu, one click away, so the bar fits a narrow window; a failure that may clear (a service that
  did not answer) keeps Send again first. A kind's view that fails is one
  quiet line, "Its details could not be read." with Retry, no bones under it.
  Rows that share an act keep what they are about before the time. The verb bar
  is a hairline and one row: Discard at the start, Edit, and the primary verb
  joined to its menu (Send later's four times above the grant row); an
  out-of-date item's bar is Discard and Ask the thread again, a timed one's
  Cancel send and Send now. Edit turns the fields and the body into inputs
  where they stand; the bar reads Cancel and Save. Discard opens a popover
  over its button with one field, "Why, for the thread". Ticks turn the
  detail into the summary list: one 16px sentence of everything that goes,
  a 36px row per item parted by hairlines (tick, glyph, act, about, a side
  word, a chevron that opens the item in place with no border), and a bar of
  Clear, Discard N and Send N joined to Send later; after the press each row
  shows its own result (the working mark, a check and its word, or the red
  mark and its reason; a plain send's check stands alone) and the sentence
  sums them as they are ("Sent 2, queued 3 in LifeOS, 1 not sent"); a row
  keeps its act whole when narrow, what it is about giving way and its side
  word wrapping under it. Groups stand 12px apart; a row's trailing word keeps
  its column at every width and gives way first on a very narrow row; the
  header keeps "Outbox" when Grants no longer fits. Done groups by day under
  12px headings, a row's outcome ("Discarded", "Out of date") in its trailing
  slot; its head says who decided. Held work's toasts step aside while the
  Outbox is the page. Keys move,
  tick and press without motion; their caps show only in tooltips. A
  computer-use act names the computer and says it "takes its screen for a
  moment", and its Done record keeps a picture. A press's toast carries Undo
  only where the act allows it (a LifeOS mail LifeOS still holds, a kind
  whose Result has a way back); "Sent mail cannot be taken back" stands in
  for a way back. Asked in threads leads Waiting when a thread asked for
  his press: one row a request (the Outbox glyph, its head sentence, the
  thread, when it asked), and an item a request lists sits under it alone;
  its detail is the request card's body in the detail's column, Not now at
  the bar's start and the press at its end. A mail or calendar act LifeOS holds after the press says
  "Queued in LifeOS" with its age on its row, its detail and its toast, never
  sent. Grants are a sheet. The right panel gains Results (the `outbox`
  glyph, two groups). Each kind draws its own payload view; a view on its
  way is bones in that shape, never a spinner. Held is never amber.
- **Back from Away** is one toast ("Decided without you in 4 threads";
  with Work on, "Held 7, decided 4 without you") that offers Review and
  stays until pressed. Review opens "Decided while you were away": one row
  per thread with its count and Open, since the host counts decisions per
  thread and keeps no choices; held items are the Outbox's.
- **Routines.** The week grid has 36px rows with hairlines, 12px muted day
  heads (today's foreground medium) and a 6px `run-dot`; past runs use the
  status marks. A trigger is always plain words ("Weekdays at 7:00 AM",
  "When Dana Lee changes it"), never a tag; a watch's row ends "until
  <day>" or "once". The status slot shows Watching, Failed or Working,
  and nothing for an idle routine; paused, like proposed and ended, is
  said in the row's line alone. A failed run's words are its cause in
  plain words beside the red mark, never "Failed:" again; the Runs list's
  time column is 112px. Only the list view is built;
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
- **The weekly review** (the Review page, work/review/; docs/agents/work-review.md).
  A page above the workspaces: a row under the rail's Work heading, before
  the workspaces, with no count and no mark, opening over the board on the
  frame of a page above the workspaces (`WorkPlacePage`, "Today"). The 40px
  header is the glyph and the name, and at its end the page's controls as
  one group, every control 28px tall: "This week" as one ghost verb only
  while another week shows, the week ("Week of Nov 16", 13px tabular),
  Previous and Next as ghost icon buttons (Next is off on this week), and a
  ⋯ menu: Make again, and "Made Fridays at 4:00 PM…", which opens
  Routines in the routine's workspace (asked for with the page, so the
  menu opens at its full height, and keeps the rows it opened with). A window under 520px has no room for the group beside the
  window's own controls: "This week" goes (Next still walks there) and the
  week is its day alone ("Nov 16"). The body is a page's 672px column with
  a 24px inset and **no title**: its first line is 12px muted and says when
  it was made ("So far, made 2:02 PM", "Made Fri 4:00 PM"), or a 12px
  spinner and "Making…" while Make again reads the week; a host that is
  off is one more muted line there, and so is a list read only in part
  ("Not every held item could be read…", no Retry: asking again reads the
  same cut list); a host or a source that did not answer is one red line. **One Retry** asks every host again and sits at the end of the
  first red line on the page (there, or a section's own), spinning while
  they answer. Three sections under 12px muted headings, 24px apart, in the order
  of a Friday: **Hours**, **Shipped**, **Slipped**. It shows a week, so it
  carries no amber, no badge, no score, no streak and no praise, and no
  chart library.
  - **Hours**: every job, in the rail's order, a row each on one grid: the
    sector's dot in a 16px slot, the name in a 144px column (a 12px muted
    comparison line under it when there is one: "down from about 9 h"), a
    bar, the total right-aligned in a 132px column in tabular figures, a
    12px chevron. A row is 32px at least; it opens (`Collapsible`, the one
    chevron) to its three facts, 12px, on the row's own grid: a fact's name
    under the job's name (the 144px column), its value from the bar's
    leading edge: "On the calendar", "At the desk", "Threads ran", each
    value in the foreground and what it stands on muted after a comma
    (`Facts`: a line breaks only between facts). Money's line is two sums,
    both in the foreground. A narrow page (under 480px) draws no bar and
    sets a fact's name over its value. **The bar** is 8px tall and
    two parts on one scale shared by every job: calendar time **filled**
    (`muted-foreground`), desk time an **empty outline** (a 1px
    `muted-foreground` border), 2px apart, `rounded-sm`, the outline sized
    by the estimate as the words round it and no part under 12px (the key's
    own piece), so a short part never draws as a dot or a ring. Measured and
    estimated differ by shape, so the bar reads the same in both themes and
    needs no new colour; it is drawn for the eye alone (`aria-hidden`), the
    total beside it saying the same in words. A total says "about" whenever
    any of it is the estimate. A job with nothing has no bar and no chevron:
    "Nothing seen", muted, in the bar's and the total's place (it names no
    week: the page may show one long over; a comparison says "the week
    before" for the same reason). One 12px muted line closes the section
    and is **the bar's key**: a 12px piece of the bar (8px tall, its own
    corner), filled, before "Calendar time is measured." and an outlined
    one before "Desk time is an estimate from what you did in TempCode.",
    each 4px from its sentence, the two 12px apart (a narrow page, with no
    bar, drops them). Never a square or a dot: a dot before a sentence is a
    bullet. A job with no hours says "nothing" only as far as it was read:
    "No desk time seen" while the calendar alone could not be read (no
    calendar fact is stated then, and the key keeps the desk's sentence
    alone), "Nothing on the calendar" while a host is off or did not
    answer, or threads, held items, document history or sent mail went
    unread, and "Not known" with neither read, which is every such job
    while LifeOS does not answer. A job whose threads ran with none of his
    own time still opens, to "Threads ran" alone.
  - **Shipped** and **Slipped** group by job, groups 16px apart. A group's
    heading is 12px muted: the dot in the 24px gutter, then the name on the
    same edge as its rows' words. The dot is the only thing in the gutter.
    A job with nothing in a section is not listed in it.
  - A **Shipped** row is 28px, led by what happened, the thing's own name
    in the foreground and the rest muted ("Sent **Budget v2** to Dana
    Reyes", "Finished **Order the new jerseys**", "Dana Reyes answered
    **Field trip forms**"), the day at the row's end, 12px muted tabular
    ("Thu") on the words' 20px line. Five rows a job, then a ghost "Show
    all 23", which hands the keyboard to the first row it brought. A row
    opens its thing. On a narrow page the sentence wraps beside its day.
    Nothing at all is one muted line: "Nothing went out".
  - A **Slipped** row is 32px: the thing's own title in the foreground and
    one muted detail a space after it ("due Tue", "sent Nov 12 to Dana
    Reyes", "held since Tue", "Thu 2:00 PM with Dana Reyes and 3 others,
    nothing sent after"). On hover or keyboard focus (`reveal`, on the
    row) three small ghost verbs lie over the row's end on the row's own
    fill, named for what each does to that kind of thing: Done, Next week,
    Drop; Nudge, Next week, Stop waiting; Open, Next week, Discard; Follow
    up, Next week, None needed. The row itself opens its thing
    (`ROW_HOLDS`). The words under the verbs fade into the row's fill over
    24px at the verbs' leading edge, never cut mid-letter; a narrow page
    sets the title over the detail and the verbs over the detail's line
    alone, the detail there the next size down (12px on a 16px line, 2px
    under the title) and a long word wrapping. The verbs sit 2px inside the
    row, so the row's focus ring is whole round them, and the row holds its
    fill wherever they show: under the keyboard and through a wait, not
    under the pointer alone. The verb pressed
    spins (`BusyLabel`) while the host works, and the verbs stay in sight
    until it has answered, wherever the pointer and the focus went; each
    verb's name carries its row ("Next week: Send the drafts"). A verb that
    has nowhere to go is off: Follow up, where the meeting's job has no
    workspace this window can open. A row a press settled **leaves**: its height and opacity
    ease out over `--dur-base` on `--ease-out`, it takes no pointer or
    focus on the way, and under reduced motion it is simply gone; a toast
    says what was done, with Undo where it can be taken back. The keyboard
    goes to the row after it, else the one before, else the section's
    heading. A group whose last row left leaves with it, its 16px with it.
    Tasks due before the week fold behind "12 older", which counts what is
    still behind it and goes with its last row; in a kept week, rows dealt
    with since sit under one fold at the section's end, the count first
    ("2 dealt with since"), titles only, with no presses. Nothing slipped
    is one muted line after the groups, "Nothing slipped", which takes the
    last group's place as it leaves.
  - Loading is the three sections' bones in the shape of what is coming
    (the Hours key's line too, and nothing at a Slipped row's end), until
    the first host answers; later hosts fill in. An empty section, or a
    job with no hours, keeps a bone in its words' place until every linked
    host has answered: nothing has failed, and "nothing" is not known yet.
    A page opened at a week (a run's row, Today's) shows the bones until it
    has moved there, never the week it stood on. The bones are for the eye:
    one status, "Loading the review", is read out. A source that did
    not answer is one red line (`PageError`): in the one section it feeds
    (threads and document history are Hours' alone), and once over the
    sections, as a host is, when it feeds several (LifeOS, the calendar,
    tasks, mail, held items: a held item is Shipped's approval, Slipped's
    row and desk time). An empty section is always one muted line, and
    says "nothing" only where every source of it answered, every host
    among them: with LifeOS out it reads "Not counted", otherwise "Some of
    it could not be read", the line over the sections saying what. A host
    that left LifeOS out says why once, by the rule, its computer named, from
    its live status, with ", so the calendar, tasks and mail are not counted."
    after the last such line: "LifeOS
    did not answer the box" red with a Retry that asks that host alone; "Not
    signed in to LifeOS on the box" muted with Sign in, a sign-in that waits
    with Show the code, Work off with Open Settings, else who can; "LifeOS is
    still connecting on the box" with no press. A host a build behind keeps its
    plain line beside the others' named ones. The line goes once that
    host's LifeOS says connected again; a host a build behind keeps "LifeOS
    did not answer, so the calendar, tasks and mail are not counted.". A host that did not answer is named in his
    words ("The Mac did not answer: it timed out.", never a wire method),
    and says so when what it answered before still stands in the numbers
    ("Its last answer is shown."). A slipped row whose source did not
    answer stands as last known with its presses off (a held item's Open
    stays), and one muted line under the red ones says "Slipped shows what
    was last known." unless a host's own line already said so. Nudge, as Follow up, is off where the job has no
    workspace this window can open. No comparison with the week
    before is drawn on anything unread, or on a host's answer from before.
    After a Retry the keyboard is back on Retry, or on the Hours heading
    when nothing is red any more; back on this week it goes to Previous.
    A heading the keyboard is put on (that, or Slipped's when its last row
    left) is its words as a `focus-ring` target, never a bare heading with
    the browser's ring.
- **The digest** (work/digest; docs/agents/work-digest.md). Work tells him
  in two toasts and one list, and nothing of Work raises a toast for news
  besides. The day's digest is one plain toast, "Digest: 9 things in
  Cosmic, Purdue and Ref", with Open and a close; it stays until he opens
  or closes it on any device. Open lands where all it spoke for shows:
  Today when the one unseen day is today and Today has a row for each
  thing it counts, else the list. A thing that cannot wait is one toast a
  thing in the waiting voice (the amber mark), its title the tell's own
  sentence and its detail the second line, with Open and a close; it goes
  when the thing is done, opened or closed, and past three at once they
  fold into one ("4 things need you now") that opens the list. Both are
  also system notifications while no window of the app is in front, and
  only then: the title is the job's name ("Work" for the digest and for a
  thing about no one job), the body the same words, a thing's detail on a
  line of its own (never joined by a colon: most titles hold one already);
  the digest's is silent, and one sounds only for a thing he has not heard
  yet (a fold that shrinks or breaks up is quiet). A toast's presses read
  what it stands for at the
  press, and a toast that stays never covers a control: the Outbox seats
  the stack above an open item's verbs (`registerToastAnchor`). The list is a `Sheet` from the right, 480px, titled "Digest": no
  page, no rail row and no count, since Today owns the day's page.
  Sections by time, newest first, under 12px muted headings in 28px lines,
  16px apart: "Since the digest", "Today, 8:00 AM", "Yesterday", then
  dates. A row is the job's `SectorDot` on the title's line (a muted ring
  for a thing about no one job), the title at 13/20 medium, the detail
  12/16 muted under it, and at the row's end, 12px muted tabular, its clock
  in words when it has one ("by 2:00 PM") else when it was told. The list
  is the record, so a long title or detail wraps and is never cut. The dot
  is the only colour, and a screen reader hears the job's name before the
  title; a row he was told of at once reads as the rest. Rows of
  a section go by job, then newest. The whole row is the press (`ROW_PRESS`
  on a box 8px past the words each side): it opens its target and the sheet
  closes; a row with nowhere to go is not a button. Loading is skeleton
  rows in the rows' shape; nothing at all is one `Empty` of one line,
  "Nothing since Oct 25" (the thirty days the ledger keeps); a host that
  did not answer is one muted line at the foot with Retry, and with no
  host answering the empty state says so instead. A Retry on its way is
  the busy label and takes no second press. Settings → Work → Digest is
  one section after Capture: Time (a time field, written once he stops
  typing or leaves it), then Held items, Routine results, Messages and
  mail and Meetings, each a select of three levels in his words ("In the
  digest", "When it can't wait", "Right away"), all starting at the middle
  one; Open the digest is the section's own verb on its heading line. No
  line explains a row. The hosts that refused a change are that row's red
  line by name ("The Mac did not take it"), until the row is written
  everywhere; a failure is said in his words, never the link's own error
  text. The time field keeps what he typed until the hosts answer that
  edit, whatever arrives meanwhile, and a time typed just before he left
  is still written. The
  section shows each setting's newest value, and a host that missed a
  write is brought to it, field by field, when the window reads it. The Go menu
  has Digest, greyed while no host has Work on.
- **Settings for Work.** The settings list gains a Work heading after
  Threads: the Work page, then each Work workspace led by its sector's
  dot. A grant row is the dot (on mixed lists only), the grant's name and
  "<workspace>, made <date> from a held <kind>" as its muted line, with
  Remove and no confirm. With the switch off, the Work page is the switch
  alone. A Work workspace's sector is shown, never edited. Models is one
  row that opens Thread defaults. "Where it runs" names the host new Work
  workspaces are made on (only with two or more hosts with Work on); each
  desktop host's folders are a section of their own, "Folders" or, with
  two hosts, "Folders on <host>", Add folder… at the heading's end, its
  box on the column's edge as the Remove presses' are, so their words end
  on one edge;
  computer use is one switch per desktop host on each workspace's page,
  and for a key that may not change them one line says so ("Computer use
  is changed from a computer that manages the box"). A key that may switch
  no host gets no Work switch, only the line saying where Work is changed.
  A section that needs LifeOS with no session says the state the host
  answered in the views' words (`LifeosLine`), never disabled controls:
  bones while the answer is out; "Not signed in to LifeOS on the box" (or
  the refused sign-in) with Sign in, and a sign-in that waits with Show the
  code, each opening the sign-in dialog in place where this window may sign
  the host in, else who can ("Sign in from a computer that manages the
  box"); "LifeOS did not answer the box" in red with Retry; a host never
  heard from by name with Retry; a host whose link is open but whose
  status or session ask went unanswered, "<Host> did not answer" in red with
  Retry (bones are for an ask still out, never one that timed out); a computer
  kept from LifeOS with no press; Work off with a press named Work, the
  section it opens, where this window may turn it on, else who can, and on
  Settings → Work itself, where the switch is, neither. A
  workspace's Waiting on words its days' failed read from the cause the
  host sent, in the same words, the host named: a state ("Not signed in to
  LifeOS on the box") muted, with the rule's press at the row's end; silence
  ("LifeOS did not answer the box") or a cause with no state in red, with
  Retry; the routine's switch under it stays usable. A Retry of it that the host does not
  answer says so with the host named ("The box did not answer"). When that
  host's LifeOS says connected again (his sign-in approved, or by itself)
  the days are read again with no press.
- **The Files place** (`work/files/`, the Files row): the finder with
  tabs, under the app's strip in the view's own frame. Three regions.
  The **sidebar** is 200px on `sidebar` with a hairline at its right, 8px
  inside, its groups 16px apart: Home, Recent and Starred, with his saved
  searches under Starred; then "Places" (a 12px medium muted label), one
  28px row a place at radius 6, a 16px muted glyph 8px from its 13px
  name, the row he stands in `sidebar-group-selected` (the rail's own
  selected fill: `muted` on `sidebar` can barely be seen in light); then
  Made by threads and Trash. A place's row ends in a quiet chevron, always
  drawn, that turns as it opens its folders under it, 16px a level, kept open per window; a row or a folder
  of the sidebar takes a drop. While a row's folders are read one bone row (a 16px square and a line)
  stands at their depth; a folder with none says "No folders" (12px muted); a read that failed is "Did
  not load" in `destructive`, its cause in the tip, with Retry at the row's end, and no Retry where he
  may not read it. A team with
  several channels is one row, its channels one level in. A place that is
  down greys its glyph and says why only when opened. With no Teams place
  listed there is one greyed row, Teams files, whose page says the one
  cause with its one press. The sidebar folds with the toggle that starts
  the tab row, and by itself under 640px of view, where the toggle lays it
  over the list from under the tab row down, so the same toggle hides it.
  The **tab row** is the canvas tab row's own: 36px on `sidebar`, 28px
  chips at radius 6, 2px apart, a 14px kind glyph in `muted-foreground`
  (never tinted: no tab row's is), the name, the selected tab
  `sidebar-group-selected`; a
  close control on the tab under the pointer and on the selected one; then
  a quiet +. A tab is a folder he is browsing or a file open as itself. A
  folder opens in the tab he is in; a file opens in a tab of its own beside
  the tab it came from, never twice, and closing it returns there. No dirty
  dot: the save line says where each file stands (a Teams Word file's says
  what the Word file does not hold yet). Past what fits the selected tab keeps its
  name and every other gives up the same part of its own (a short name is
  not cut first), down to 128px, which keeps 4.5rem of its name (or its
  whole name where that is less: `tabMin`, the canvas row's too); then the
  tabs scroll under a faded edge. No tab is its glyph alone, so two folders'
  tabs never look the same; under the room of one letter and its ellipsis
  (a pane too narrow for even one tab) the name gives way whole, never a
  sliver (`TabName`). Tabs whose names
  share a start ("Purdue Esports Spring LAN budget.xlsx", "… roster.xlsx")
  are cut in the middle from the word where they part, so the end that
  differs stays ("P…budget.xlsx"); under 4rem of name the end alone is
  drawn ("budg…"). Places and projects of the sidebar that share a start
  are cut the same way.
  While a place loads, the bar's bones stand where it will: Back and
  Forward greyed and a bone for the trail, over the list's bones, so
  nothing moves when the page lands.
  A **page's bar** is 44px: Back and Forward for this tab (28px ghost
  glyphs), then the trail, each step above the folder a ghost press in
  `muted-foreground` and the folder itself in medium `foreground` (its
  whole name in a tooltip where the bar cuts it), 14px chevrons between;
  the steps above give way first, each down to a letter and its ellipsis,
  before the folder's own name is cut; then Go to and Search (28px ghost glyphs), the view
  switch, the page's options (⋯) and the one primary button, New. A press
  on the trail's empty part, or ⌘P (the focus in the list, the sidebar,
  the bar, or on nothing at all; inside an editor it is Print), turns the trail into **Go to**'s
  field: a panel under it (the popover's own depth, 32px rows, at least
  360px wide where the bar has room) lists the
  open tabs and recent files first, then names from every place, then
  "New sheet called …" when his words start with new; Return takes the
  first row, the arrows walk, Escape or the focus leaving the field and
  its panel puts the trail back. One muted row under the list, outside the
  list itself, says where the names stand: "Loading…" with a spinner once
  a lookup takes past 250ms, "No matches" for words that match nothing,
  "Couldn't load names" in `destructive` with Retry when the host refused
  (Tab from the field reaches Retry; Retry gives the field the keys back).
  The names of older words stay drawn but cannot be taken while his new
  words are asked, and give way to "Loading…" once that is slow. A Return
  pressed while the names are out takes the first row once they come, and
  only for the words it was pressed on: a change to the field drops it.
  **Search** (`/`
  or ⌘F) is a field in the trail's place that filters the folder shown as
  he types (a filter that leaves nothing says "Nothing here by that name"
  with Clear filters, which puts the folder and the trail back); Return searches every place as a page of results whose second
  column says where each file lives (cut from its start: the folder it
  lies in stays, the place and the folders above give way), under a 36px bar of filters (Kind,
  When it changed, Others can open, then More, a menu of Place, Project and
  Changed by as submenus and Needs review, its count in `muted-foreground`
  beside its name while any is set), each a 24px ghost press whose words
  are its value and turn `foreground` while set, with Save Search… at its
  end; a saved search is a row under Starred. The Docs view folded in here:
  LifeOS is a place, its filters are this bar's and its saved views are
  saved searches.
  As the bar narrows the trail gives way first (under 520px of bar it
  names the folder alone), then the view switch (under 600px of page its
  five shapes are rows of View options instead); Back, Forward, Go to,
  Search, View options and New never leave. New is left out only where
  it could make nothing: a folder whose read failed with nothing listed,
  a place whose note stands with nothing listed (signed out, not
  allowed; a sleeping VM keeps it, since a make wakes it), or a LifeOS
  folder while its session is away.
  The **view switch** is one segmented control of glyphs: List, Grid,
  Columns, Gallery, Beside. A folder he has not shaped is a list; one he
  has shaped keeps its shape for this window. **View options** (⋯) is one
  menu: Comfortable or Compact rows (the list), the three tile sizes (the
  grid), Sort by Name, When Changed, Size or Kind with the way it runs
  said at the checked row's end (a press on the checked one turns it
  round), Group by None, Kind or Date (and Place in a lens or a search),
  and Show Details.
  The **list** has a 28px head row (12px, a press on Name or Changed
  sorts, a second turns it round, a 12px chevron says which way) and 36px
  rows at radius 6 (28px compact), only the rows on screen mounted past
  80: the kind's 16px glyph in its tint ("File kind tints"), the 13px name
  (semibold while a thread made it and he has not opened it), then one
  state at most, 4px after the name on its baseline (a 12px cloud mark, an
  amber count of suggestions, "Dana is in it", a spinner while a thread
  writes; a glyph keeps the centre line; while his own act changes a row,
  the list's spinner and its verb until the host answers, each row its
  own: "Opening… 1.2 of 3.4 MB", "Renaming…" with the name he typed in
  the name's place, "Moving…", "Copying…", "Deleting…", "Downloading…
  2.1 of 8.4 MB", drawn whole where who and when stand (their 296px, or
  When's 128px where Who has gone; under 360px the spinner alone, by the
  name); a row that went keeps its word for 2 s while the list is
  read again, so it does not show its old self between), then who last changed it
  (160px) and when (128px, right aligned, tabular), both 12px muted. The
  head keeps the room the list's scroll bar takes, so Changed ends on its
  dates' edge; a
  name the list cuts has its whole text in a tooltip. Who goes first as
  the list narrows (under 560px of the list itself, a details pane beside
  it not counted), then when (under 360px). Folders come first. Grouped, each group's first row carries a
  28px heading over it (12px medium muted) on the rows' title edge, 8px clear of the group above.
  With Show Details on, a 288px pane at the list's right (past 640px of
  the folder's body) shows the one selected file's picture in a 160px box on `stage`,
  its name, its facts as a two-column list and Open, the three on one left
  edge under the picture.
  **Grid** is tiles at 96, 144 or 208px: the file's own picture where its
  host draws one, on `stage` inside the image outline with 4px around it,
  else the kind's glyph large (28, 36, 48px); under it the name on two
  lines at most, centred, and one 12px muted fact. A picture is asked for
  only once its tile is within a screen of what the grid shows (the glyph
  holds its place till then), never for a folder, a file kept in the
  cloud, a sound or an archive, and a tile never waits on it. **Columns**
  is a 216px column a folder from the place's top down, 28px rows, the
  folder on the way down held in `muted` (`foreground` 5% while the keys
  are in the columns), the last column the selected file's picture and
  facts; Search's field filters the last column, and the arrows walk what
  it leaves. **Gallery** is one large read-only preview on
  `stage`, a 32px line under it with the file's name and one fact, and a
  76px strip of the folder (60px cells, a small picture or the glyph, the
  selected ones held in `muted`, the one shown where none is); the arrows
  walk, Return opens. **Beside** is the list at 280px (down to 200px as
  the page narrows) in two-line 44px rows (the name alone on the first line,
  so it is cut as little as can be; under it the one state in words, a
  thread's writing as its spinner and "A thread is writing", else who
  changed it, then when, the day alone ("Sam Ortiz, Nov 18"; the clock only
  today); a folder with neither is its one line centred) and the selected file at
  its right, the right half empty on `stage` while nothing is selected;
  under 520px the two take turns, a press on a file showing it under a
  32px line led by Back:
  a read-only preview that follows the arrows after 120 ms, and, on a
  click or Tab into it, the file as itself, editable, under one 32px line
  that says where saving stands and Open in a Tab. It is no tab. A walk
  with the arrow keys never opens, mounts or writes anything.
  In every shape a click selects (`muted`), a second opens; hover is
  `foreground` 5%. Shift takes the run, ⌘ adds or takes one, ⌘A all. The
  arrows walk, Return opens, Space is **Quick Look**: a layer over the
  page (the popover's depth, radius 12, at most 1000 by 760px) with a
  44px head (the glyph, the name, where it is kept, cut only at a word,
  Open, Close) and the
  file read only under it: its pages down the pane, its picture fitted,
  a text file's first lines in the mono face, a video's frame with Play
  under it, a sound's Play, a zip's listing, else its facts in one comma
  sentence and the one sentence that says why there is no picture. Tab
  stays on its own controls, and closing it gives the list its focus back.
  Opened by Space it appears at once (a key's act never animates, as a
  picker opened by a key); opened by a press it plays one scale from 0.96
  and a fade over `--dur-base`, a fade alone over `--dur-fast` under
  reduced motion. It follows the arrows with no motion, and closes at once
  on Space, Escape or a press outside. A file kept in the cloud shows its facts and Download
  and Look: nothing downloads without that press.
  **New** is the bar's one primary button: a menu of what the place
  makes (Document, Sheet, Deck, Text File, Folder), Upload Files… wherever
  the place takes uploads (the workspace's folder, a Teams or OneDrive
  library; not the Windows VM, nor a computer reached through another
  host), From a Template… only where the place lies on the workspace's own
  host (not the Windows VM), and a
  last muted line on the rows' leading edge that says where it is kept.
  TempCode's own endings (".tcsheet", ".tcdoc") are never shown as words:
  a row, a tab, a header and a rename field show the name before them, and
  a rename keeps the ending. The new thing is selected
  with its name ready to type; ⌘⇧N makes a folder the same way, as in
  Finder (the menu's Folder row shows it), only where the page shown makes
  folders: elsewhere it stays the app's New Window. A name is typed in place (F2, a slow
  second press on the selected name, Rename in the menu): the field
  stands where the name was with the part before the extension selected.
  **A row's menu** (a right-click, the same for one or many) is the
  verbs the place takes, each refused one greyed with its sentence as the
  tooltip: Open, Quick Look (its key, Space, at the row's end; a press
  plays Quick Look's entrance), Open in New Tab (a folder: a file's Open is
  already a tab of its own), Share…, Download, Rename, Move to…, Copy to…,
  Star, Delete. Download is offered only where the host gives this window
  the bytes, by the route a tab's own Download takes: never a folder, a
  lens, a Drive file, a computer reached through another host, nor a file
  in a place others open (or the VM) from another computer's window; the
  row says "Downloading… 2.1 of 8.4 MB" and one toast says it came
  ("Downloaded Budget.xlsx", "Downloaded 3 files"). With two or more
  selected one bar floats 12px over the list's foot (40px, radius 12, the
  popover's depth): "3 selected", Download, Move, Copy, Delete, Clear;
  while it shows the list keeps 56px under its last row.
  **Move to… and Copy to…** are one small dialog that drills down in one
  column: it opens in the folder the things are in (Move Here greyed there,
  with no note: nothing has been refused yet), a trail over it leads
  back up and to Places, with New Folder at its end where the place makes
  folders (the name typed in a row over the folders; he then stands in
  it), a press walks into a folder (folders alone, more as the list nears
  its end), and the place's own sentence stands beside the verb where it
  refuses. Places is the sidebar's list, its glyphs and teams (a team over
  its channels, one level in), under Recent: the three folders he last
  moved or copied to, as Save As keeps its own. A move inside one place says what
  went in one toast with Undo, back to the folder it came from; a copy, a
  move across places and Put Back say it with Show, which goes to the
  folder they went to in this tab. Delete
  (⌘⌫, as in Finder; a bare ⌫ moves nothing; on a PC the Delete key)
  goes to Trash and says so in one toast with Undo;
  Trash is a lens, a list alone (no view switch), whose columns are Name,
  Was in and Deleted, whose rows have Put Back and Delete for Good (the row
  leaves as the host answers), with Empty Trash in its bar; empty, where a
  library is listed, its line adds "Files deleted in Teams or OneDrive are
  in their own recycle bin."; a ghost in muted ink that turns red under the
  pointer (the confirm it asks holds the red verb). **Drag**: nothing moves while a thing is
  dragged; the target (a folder row, a place or folder of the sidebar, a
  folder's tab, which comes forward after 600 ms) takes `muted`, and the
  pointer carries a small label with the verb ("Move to Events", "Copy to
  General"). A drop inside one place moves and into another copies; ⌥
  copies, ⌘ moves. Rows the system carries out to the desktop are let go
  once the window loses focus, so files dragged in from the desktop
  next upload. Files dragged from the desktop over a folder draw the
  document surface's wash 12px inside the body (`muted` 70%, a hairline,
  radius 8) with one line, "Drop to upload to Events"; over a place that
  takes no upload (Recent, Starred, Trash, a far computer) the same wash
  holds the place's sentence and the drop is refused. Dropped, they upload
  into the folder,
  with one line over the list for the file going, how far, and Cancel; one
  saved under a free name because its own was taken says so once ("Uploaded
  as Budget 2.xlsx"), and a plain upload says nothing.
  Rows dragged onto the docked chat draw the document surface's wash 12px
  inside it ("Drop to add to the message") and become a file chip each in
  its composer, eight at most.
  **Home** is the page a new tab opens on: three short lists (Waiting on
  you, Starred, Recent) in a 768px column, 36px rows that open on one
  press; a file shows once, in the first list it belongs to, and a list
  with nothing in it is left out. A row being opened shows the list's
  spinner and word; a row that says a state gives its date up first in a
  narrow page (under 400px), and under 360px every row's date goes and a
  state's words go with it, whole, as in a folder's list.
  While the host's LifeOS is down or on its way, Home, Recent, Starred
  and Made by threads say so in one line over the list, and a row only
  that session opens (a LifeOS document, a mail's file) is greyed and
  shut, in every shape, Star still offered; the rest stay live. Found
  anywhere, Recent and Starred too, such a row opens from its own place,
  and Show in Its Folder goes to its project, else the top of LifeOS.
  A **file open as itself** has a 48px header: its kind's glyph in its
  tint, its name at 14px semibold, and under it one 12px muted line that
  says where it is kept ("In Events": a press goes back to the tab that
  shows that folder, else opens one beside it) or whose copy it is ("A copy from
  MacBook. Changes stay here", with Open on MacBook) or, for a kind that
  saves, where saving stands ("Saved 1:52 PM in Events": the last save the
  host answered, kept while his edits wait in the editor's own short pause;
  "Saving…" only once a send has been out 600 ms or edits waited past that
  pause, so a cell or a word never blinks it; a failure at once; no motion
  on the swap; it takes
  `foreground` only when it needs him, with at most two presses beside
  it: Retry where a save was refused or did not land ("Not saved." and its
  reason), else Reload and Keep Both, the one conflict press everywhere; a file moved or deleted under it reads "This file was
  moved or deleted" with Keep Both, which puts what the tab holds back where the file was, a sheet's too). Edits a crash left unsent come back in the same
  foreground line as the file opens, the editor read only until he answers: "Edits from 2:14 PM were not saved" with
  Restore and Discard, or over a file that changed since, "… The file changed since" with Keep Both (a text file), Copy
  Edits (a sheet) or Copy Words (a deck's box, "The slide changed since") beside Discard. A copy that saves back to its file on
  another computer names that computer as its tab does: "On MacBook" until
  a change goes, "Saving to MacBook…", "Saved to MacBook 1:52 PM", all
  muted; in the foreground "This file changed on MacBook" with Reload
  (asked first, since it drops what was not sent) and Keep Both, "This
  file was moved or deleted on MacBook" with Keep Both, "MacBook is not
  answering. Changes wait here" with Retry, "MacBook refused the save."
  and its sentence, with Retry, and "Not saved to MacBook." and the reason
  with Retry where his window's own ask for a send failed. It never says
  saved while his ask is unanswered: "Saving to MacBook…" until the host
  answers, and the file holds the copy's last write; a save of his that
  wrote nothing into the copy reads "On MacBook". A Word file of another computer opened as its document says
  whether the Word file holds his edits ("The Word file in Teams has not
  changed", "Changes since 9:12 PM are not in the Word file", "Saved to
  MacBook as Word 9:12 PM", all muted; a save names the computer that
  holds the file, as a copy's line does), with one press while it does not,
  Save to Teams (the file is Word already). Nothing asks while he types. His
  first press on a file asks once in the house confirm ("Save Plan.docx to
  Teams as you work?", Save automatically and Ask me each time; either saves
  it now), unless Settings → Work, Word files, says how new files save (Ask
  the first time, the default; As I work; When I press Save); after Ask me
  each time each press asks "Replace Plan.docx in Teams?" with Replace and
  Keep Both. Each question names only what this file loses (what its import
  did not keep and Preview's count for Word, in one sentence; none when it
  has none); over a file that changed there, one line says when, Keep Both
  holds the focus and Replace stays his press; over one gone, Keep Both
  alone. Save As… on it never offers the file's own path ("Plan copy"): the
  header's Save to Teams is saving, Save As… makes another file. A save into a Teams or OneDrive library never says it is
  in Teams before OneDrive has uploaded it: "Saved, uploading to Teams…" while that computer holds the bytes and OneDrive
  has not, "In Teams 1:52 PM" once it has (OneDrive in place of Teams for his own), "Saved to MacBook. OneDrive uploads
  it" where that computer cannot say, all muted; past a minute, in the foreground, "Not uploaded to Teams yet." with
  what he can do ("The Windows VM is asleep. It uploads when it wakes", "OneDrive is not running on the Windows VM.
  Start it there", "OneDrive is signed out on the Windows VM. Sign in there", "OneDrive on the Windows VM may be
  paused. Resume it there"). Closing such a tab sends what the kind still holds (a deck's
  open box) first; closing it while changes have not
  reached the file asks once in the house confirm: "Changes to Roster.xlsx
  have not reached MacBook.", Cancel, Discard and Keep trying (Keep Both in
  its place over a file that changed there; Discard alone where it was
  refused); at the right ⋯ and Ask (secondary,
  the Ask glyph; flat on `muted` while its chat is open; its glyph alone under 480px of header, and there the line's second
  press is the first row of ⋯, so the name and its line keep room beside the first; a line cut even so has its whole
  words in a tooltip, and is a Tab stop unless its folder is a press. A bar with no ⋯, a side file's or the Beside
  seat's, always draws both presses: Reload alone would drop his edits. Under 520px of the Beside seat a line with
  presses has the first row to itself, whole, and the presses and Open in a Tab take a second row at the end). The name is a press that renames it in place. ⋯ holds
  its row's verbs (one greyed says why in its tooltip: on a computer this window reaches only through another host,
  "Purdue PC is reached through the box. Change its files on Purdue PC itself."), then Download, Save As… (a
  document), Save as Template… (a file the template shelf keeps) and a Word file's own choice (Save to Word
  Automatically, or Ask Before Saving to Word), then Full Window and Close Tab, always last; Star reads Remove Star
  while the file is starred. Full Window fills
  the app's window with the file, its way back in the header and on
  Escape. Under the header the kind's own bar and body, exactly as beside
  a thread; the `file` kind shows a text or code file in an editor that
  saves as he types (⌘F finds and ⌥⌘F replaces in the code editor's find
  bar, as in a document; a Reload opens it where he was), a sound with Play, a zip as its facts over the list
  of what it holds (each entry by its last name, 16px a level under its
  folder, so a folder is named once), and anything else as its facts (one comma sentence;
  the header already names it) with Download and Open in its app; a Drive
  file no editor here reads (a picked PDF or workbook) has Open in Drive
  alone. Opening a file makes no thread, and the thread is never the
  first thing he sees.
  A **document opened as a copy** whose edits go nowhere (a .doc, .rtf or
  .odt from another computer, or a workbook or deck whose computer named no
  version) says so in its muted line, "Edits stay in this tab, not on
  MacBook", with Save As… for a document and Open on MacBook, its two
  presses. Nothing is sent and no Saved is said. Closed with edits in it, it
  asks once in the house confirm, "Edits to Notes.rtf are only in this
  tab.", Cancel, Discard and Keep; Keep closes the tab and the file opens
  again as he left it. A close that comes by any other way keeps it too.
  With no edits it closes at once. A text file's copy with no version stays
  read only.
  A **shared Office file** (.docx, .xlsx, .xlsm, .pptx in a library) has one
  more control before ⋯: a ghost menu button named by the mode the tab is in,
  "Edit here" or "Word for the web" ("Excel for the web", "PowerPoint for the
  web": the mode's one name, in the menu, Settings' "Opens in" ("Edit here",
  "Office for the web"), asks and tool words alike), with a chevron; under
  480px of header it reads "Here" or "Live", as Ask goes to its glyph, and its
  accessible name stays whole. Until the host answers, its place is kept,
  unseen, for the app the file's name says, so a late answer moves nothing; a
  missed answer is asked again (after 2, 5, 15, then every 30 s, and at once
  when the link returns). Its menu
  holds the two modes as ticked rows, then "Open in Word on MacBook" and "Open
  in Word in the Windows VM" where those exist, which act at once and leave
  the mode as it is. A live tab's body is Office for the web itself, edge to
  edge under the header; the line says where the file is kept ("In Team
  RecWell"), "Opening in Word…" with a 4px bar along the header's foot in
  place of its rule while Word comes up, or "Signing in to Microsoft…" while
  the page is on a sign-in site (never its address). It never says
  saved: Office does. A file that did not load is one `Empty` ("Word for the
  web did not open", the reason, Retry; a Retry after a refused ticket asks a
  fresh one, so it ends in the file or the reason again). A chat or a side file that lies over
  the body hides the page under it. While a switch waits the line says why
  from his press, and the control waits: to Live "Opening in Word…" (or
  "Sending your changes first…", then "Opening in Word…"); to Edit here
  "Leaving Word…" while Word lets go, then "Opening it here…". No bar is drawn
  while a switch waits. Word still saving past 10 s asks in the house confirm,
  "Plan.docx is still saving", "What Word for the web has not saved may be
  lost. If the file does not have your changes yet, it stays in Word for the
  web.", Cancel and a red Switch Anyway (a close asks Close Anyway).
  **Ask** docks a chat at the file's right, under the header; Ask again or
  the dock's close takes it away, at once, never a tween. It shows the
  thread that holds the file, else a draft that is in no rail and on no
  host until he sends ("New chat"), its composer holding the file's chip
  from the first Ask (once he takes it off it stays off, and the thread
  his send makes does not open the file) and no draft row. The dock is 360px to start (360 to 720, kept per
  window), the file never under 440px beside it (so a 1280px window with
  the rail and the workspace's column open keeps the file in view); the canvas split's
  hairline sash between them (an 8px grab, the arrows, a double-click
  back to 360). Its head is 32px, level with the kind's bar: the title at
  13px medium, then Open in its own tab (once it is a thread) and Close,
  24px ghost glyphs. Under it the transcript and the composer; the
  composer is there the moment the dock opens, and a thread's rows still
  coming are the transcript's skeleton over it; a failed first read is its
  Retry line alone over the composer, the skeleton back when a retry
  starts. The thread from before, found behind a fresh draft, takes the
  draft's place only while it is empty, in place, never a fade. A host out
  of reach is said once, in the connection line over the box; the field
  keeps its own placeholder and send waits (a code thread's field says it
  too). Where the tab's body
  cannot keep the file at 440px beside it, the dock lies over the whole
  body instead, its head and Close where they were. Before it would lie
  over the file, Files folds its own sidebar: while the dock is open the
  sidebar folds itself wherever keeping it would leave the body under
  800px (a view under 1000px; a 1440px window with the rail and the
  workspace's column is 980), and comes back when the dock closes. A selection's Ask opens the dock with the selection's chip.
  **States**: loading is the list's own bones (a 16px square and a line a
  row); an empty folder is one `Empty` ("This folder is empty"); a folder
  that did not load is `Empty` with why and Retry, and one that is gone,
  or that he may not read, offers the folder above it (else Back) in Retry's place, and a refusal with
  neither offers nothing to press; a later page
  that did not load is the state line over the rows it kept ("The rest
  did not load", Retry asks that page again); a search that left a place
  out says so in one line over its results, or under "Nothing found",
  with Retry (with nothing to press, "Folders on Purdue laptop were not
  searched" is muted, a fact about the list and no heading; so is a
  place whose files were matched by name alone, the words inside them
  not read: "Events and General were searched by name only"); a machine
  asleep is one
  line over the list it kept ("The Windows VM is asleep", "This is the
  list from 1:40 PM.", Wake it) in the state line's shape with no failed
  glyph, or with nothing kept that line as the folder's `Empty`; while his
  Wake it (or his press on the folder) wakes it, the same line or `Empty`
  is led by the 12px spinner, "Waking the Windows VM", with nothing to press,
  and the rows take its place with no fade when they land ("The Windows VM
  did not wake", Wake it, if they do not); a machine that did not answer is the state line with Retry, its
  detail what is still shown ("This is the list from 1:40 PM.") and never
  its word again; a
  host a release behind is one 12px muted line under the tab row ("Update
  the box to keep tabs here"). Nothing moves between pages: a tab switched
  by a key changes at once.
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
  thread's name in medium, Open thread. Its Send shows one toast,
  "Sending to …" over a 3px track that empties across the undo time, with
  Undo; nothing has gone until the track is empty.
  Send's chevron is the app's 28px menu: a time the draft carries first,
  then the presets with their time muted and tabular at the row's end, Pick
  date and time…, and on a reply the checkbox row "Cancel if they reply
  first". The picker is a popover from the Send group: the calendar, then
  under a hairline the time (112px) and the zone side by side, one 12px
  muted tabular line saying when it goes (both zones only when their clocks
  differ), and the tick to the left of the one primary, Schedule. A
  scheduled mail in a thread's foot keeps a message's header: quiet xs Send
  now, Edit and Cancel send, then its time as a quiet button that opens the
  same picker (Move); under the recipients one muted line when they replied
  since or a try is being repeated. In Scheduled a row they replied to
  carries a 12px reply glyph before its time.
  A face is one avatar everywhere in Mail (a list row at 24px, a message's
  header at 28px, a fold row and a recipient's chip at 18px): the person's
  picture where LifeOS holds one (read from LifeOS's store as bytes, never
  from the web, and kept once read so it never flashes back to initials),
  else a 14px glyph for a mailing list or a shared mailbox, else initials
  on `muted`, all inside the image outline. A picture that does not load
  gives way to the initials quietly.
  **The chat beside the mail** (work/mail/chat/, on the dock lifted from
  Files, work/dock/): Ask, a secondary small button with the Ask glyph at
  the reader toolbar's right end (flat on `muted` while the chat is open),
  an Ask glyph after Mark read in the ticked head, or ⌘L anywhere in Mail
  (a live canvas selection's Ask keeps ⌘L) docks a chat at the view's
  right edge, top to bottom, a hairline at its left and no shadow; Ask
  again or Close takes it away at once, never a tween. It is 360px to
  start (360 to 720, kept per window as `tc.mail.dockWidth`), the canvas
  split's sash between (8px grab, the arrows, a double-click back to 360).
  Mail lays out its list and reader in what it leaves, by its own rules:
  at 640px or less of room they take turns; under 480px of room the chat
  lies over the whole view, its head and Close where they were, the mail
  under it inert. Its head is 44px, level with the list's head and the
  reader's toolbar: what it is about at 13px medium (the open mail's
  subject, "6 mails" for ticked rows, the mailbox or "Results for “…”"), then
  Open in its own tab once it is a thread and Close, 24px ghost glyphs. No
  chip sits in its composer: the head names the subject once. A fresh
  draft shows at most three starters over the composer, 32px rows at 13px
  in `muted-foreground` going to `foreground` under the pointer; they go
  once he types. Its answers are cards in the transcript, 12px radius and
  a hairline, no card inside one: a draft (a 36px head, "Reply",
  "Forward" or "New mail" at 13px medium and its state at the end in 12px
  muted: Draft, In your reply, Sending, Scheduled for Tue 8:00 AM, Sent, Not sent,
  Discarded (one word a status, `sentState` in work/mail/sentState.ts: a mail he scheduled is
  never "Sending", and a sent one names no time the row does not keep); then To, Cc and
  Bcc in full at 12px, each name with the address it really goes to, and
  one plain line in medium when an address is not on the thread or there
  is a bcc ("Not on this thread: …. Bcc: …."); the words at 13/20, twelve
  lines then Show all; Put in reply, secondary, which opens the full
  composer when the card had to tell, and Discard, a ghost trash glyph); a rewrite of his reply (words taken out and put in, the review
  tints; Take and Leave); rows to act on (36px rows: a tick, the subject
  at 13px, the sender and the date at 12px muted; one press in the foot
  names the count, "Archive 3"; a row still reading its mail draws a tick,
  subject and date bone, and the press says its verb alone, inactive,
  until every row has answered); a task or an event (one 44px row: a 14px
  glyph, the title at 13px medium, one 12px muted line, Add…; after his
  Add, an event's Queued mark until the calendar has it, then Added with
  Open, or the refusal in red in the line's place with Add… again). A mail or a
  person named in an answer is a 20px chip on `muted` at radius 6 with a
  12px glyph.
  Mail's settings are flat groups of 44px rows; in Settings → Work they
  are one page section, "Mail", with the groups (Writing, Reading,
  Signatures, Accounts) inside it under 12px regular muted headings, 16px
  apart, and no second title; a signature and an account open as dialogs in the one dialog
  shape (the title beside a quiet Close, a hairline over the footer), every
  control in the account dialog at one width.
- **The Messages view** (TempCode's own, src/renderer/src/work/messages/;
  docs/agents/work-messages.md). Mail's frame: no header of its own, the
  list's 44px head the page's, the list 296px (260 to 480, kept as
  `tc.messages.listWidth`) beside the conversation, and at and under 640px
  of view the two take turns in the same places (one hidden, neither
  remounted), the conversation's toolbar leading with the way back. The head is "Messages" (13px semibold, the job's unread count
  muted after it) on a menu of All, Unread, Direct and Channels, and names
  the filter in force (the count only beside All and Unread; "Messages"
  while a search runs); under it the 28px search, then one 12px muted line
  while a source of the job is stale ("Discord last synced Nov 3, iMessage
  Nov 16"). Under 640px with a conversation open, its toolbar says its own
  source's line instead, so the fact is on screen once. A row is 48px at
  radius 6, 1px apart, in Mail's grid: the 20px gutter for the 6px unread
  dot, a 24px face (two 18px faces lapped side by side by 4px for a group,
  the front one ringed in the row's own fill, a 14px hash on `muted` for a
  channel), the name (600 and `foreground` when
  unread, muted when read) with its time at the end in 12px tabular, and
  the newest words in 12px muted, led by "You: " or the writer's first
  name. The 14px amber circle-dot before the time marks a thread's draft
  waiting there. No source chip: the source is said once, in the open
  conversation. Hover is `foreground` at 5%, the open row 9%, at once;
  under the pointer the time gives way to Mark read or Mark unread. Bones
  are eight rows in the row's grid; an empty list is one line at the
  column's middle with its true cause ("No chat is linked to Cosmic" with
  Open Connections, "No messages in Cosmic yet", "Nothing unread" with
  Clear filter; a failure "Messages did not load" with Retry). A search shows the messages that hold its words in the
  rows' place (the last answer stays while the next words are asked), the
  conversation's name in a row's ink and the time, then who ("You: " alone in
  a direct chat) and the words, cut to start a little before the match only
  where the line, measured in its own 12px font, could not show it otherwise
  (the lead and the match within about two thirds of the line, so words
  follow it; as late as it must, at a word where one starts there, else mid-run, so the match shows even deep in a
  URL; "…" only where words were cut), lit in `foreground` medium. A
  search's first bones say "Loading search results", the reader's "Loading
  messages". Name bones are fixed widths in pixels, different row to row. Under 640px the conversation's toolbar line reads "Last synced
  Nov 3" at the name's own left edge.
  The conversation's toolbar is 44px over a hairline: the name 13px
  semibold (a direct chat's opens the person in People when LifeOS knows
  an address), one muted 12px fact ("Slack, CosmicGames") 8px after it on
  its baseline, and at the end two quiet 28px buttons, Start thread and
  More. Under it the column fades over 12px, the app's edge fade, so no
  sliver of a cut line sits at the seam. The messages are rows, not bubbles,
  in a 680px column stacked from its foot: a run of one writer inside five
  minutes shares one head (28px face, name 600, time 12px muted), the words
  14/22 with their line breaks and http, https and mailto links in `link`;
  runs are 16px apart, messages in a run 4px. A day opens with its date,
  12px muted, centred on a hairline; "New" sits at the end of the hairline
  over the first unread message, 12px `foreground` medium. It opens over
  "New", else where he left it, else at its foot; while he is up the column
  a quiet pill at its foot says "2 new" and goes down. A Slack thread reply
  carries one 12px muted line above it: a turned arrow, then "Mia Chen:"
  in medium and the words of what it answers, cut where the line ends, none
  when that is the message right above. A message's menu (a
  right-click, or its ⋯ under the pointer at its top right) holds Start
  thread, Mention in a thread while one is open, Copy text and its link; a
  row's holds Mark read or unread, the two thread verbs, Open in the app and
  Copy link. A message he was sent to (a search hit, a chip, a tell) comes
  into view with 96px over it under a `muted` fill that fades after a
  moment over `--dur-slow`. A picture is drawn in place in its own shape
  inside 360 by 270, radius 8 inside the image outline, a skeleton of that
  shape while it comes; any other file is Mail's 40px chip with its 28px
  tile, named by its press ("View runner-budget.xlsx", "Download
  build.zip"), and while its bytes are still on their way the same chip with
  a spinner in its tile and its name muted; a file that cannot come is one 12px muted line, its glyph,
  its name in medium `foreground` (a long unbroken name wraps inside the
  message), why, and 8px on its quiet controls: Try again, which asks
  LifeOS again or reads the bytes again (the file then draws as coming, its
  chip's spinner or its picture's skeleton, once LifeOS marks it wanted);
  Open in its app where it has an address; a picture whose bytes do not draw
  takes the same line. A picture is never wider than its message. The composer sits at the column's foot
  on the composer's surface (`card`, a hairline, radius 12), which takes the
  field focus standard at its outer edge (`focus-field`) while the field
  holds the keys, never while a foot-row button does: a field of one
  to eight 14/22 lines, then the foot row, the place for one-press answers
  at its left and the one primary button at its right. Above the box, one
  12px line when there is something to say: LifeOS's reason where nothing
  can send (the button is then Copy, with Open in the app quiet beside it),
  a thread's draft (the amber circle-dot, "Drafted in" and the thread's
  name in medium, LifeOS's reason while its button is Copy, for a copy-only
  draft or a held one where the route says no, wrapping whole while only the
  title is cut, then its controls in ink at
  the line's far end, apart from the name: Use draft while the field holds
  his own words, Open thread; Discard beside the primary), a thread's held
  reply whose press failed (the red mark and "Not sent.", or, its outcome
  unknown, the amber mark and "May have gone."; then the thread's name in
  ink; then 10px on, muted, LifeOS's reason or, unknown, "Check whether it
  went first"; the route's reason while the button is Copy; and Open in
  Outbox at the far end. The line wraps rather than cutting, a wrapped row
  flush with the mark (the 10px is the line's gap); only the thread's name
  may be cut, its whole shown on hover while it is; no tip repeats the line;
  no Discard, its words never in the field, no amber mark on its row); his
  own Send or Undo whose outcome is unknown (the amber mark and "May have gone.",
  10px on, muted, "Check above before sending it again", and Use words at
  the far end, off while the field holds a draft's words; its words wait
  there, never in the field; Undo's words held while a draft sends take the
  same line, muted "Taken back while the field held a draft", no mark); a held
  draft another window is sending (the draft's line with "Sending from the
  Outbox", the field read only, Send off, no Discard or Use draft), or one
  out of the Outbox's list not yet known to have ended (the same, "Waiting
  in the Outbox"). A refusal in red stands above that line, never in its place. His reply shows as his own message with one 12px line under it:
  "Sending" and Undo (in ink, as Retry), or the red mark, "Not sent.", LifeOS's reason and
  Retry. His own words leave the field at Send's press, the button turning
  busy until LifeOS answers. A held draft's words stay in the field until
  the host has taken them: while its press goes the field is read only, Send
  busy, Discard off, the draft's line still naming its thread; refused, the
  field is as it was, with the refusal in red above the line. While any of
  his actions waits on the host (Send, a held press, Discard, Copy, Undo
  placing its words) the others are off and the field is read only (but
  during his own Send, which empties it), the one waiting busy; a held
  press's line and button stay those of the press until it settles. A
  control he had focused that gives way to another (an attachment's Try
  again, a pane's Retry) hands the keys to what takes its place, or to its
  wrapper with the standard ring until something does. A message that arrives at the foot rises 4px and fades in over
  `--dur-fast`; nothing else moves.
- **People** (the People view, work/people/; docs/agents/work-people.md).
  The list is a 720px column, one 32px row a
  person, the 24px face, the name in `foreground`, the first address 4px
  after it in 12px `muted-foreground` on one baseline, when they were
  last heard from at the end, tabular. A person's page takes the Projects
  way back in the 40px header (the arrow, "People", their name muted) and
  its two quiet verbs, Write and New thread. The body leads with the 40px
  face beside the name (the 16px title recipe) and their addresses and
  numbers as one comma line in 12px muted, then the notes at 14/22; then
  each section that has something, 24px apart, under a 12px medium muted
  heading: rows of the list's 32px shape, a title, a 12px muted second
  line, a time at the end. A section with nothing is not drawn, and no
  row repeats what its heading says. An Agenda row names the people at
  an event as one muted comma line ("With …"), each name a link on hover.
- **Clashes** (work/clashes/; docs/agents/work-clashes.md). A clash is a
  fact about an event, so it sits on the event, in words, where he already
  reads it: no page, no count on the rail, no badge.
  On an Agenda row it is one more 12px line under the place, in `warning`
  (he is needed), in the words of that event's side: "Overlaps Varsity
  Basketball (Ref), 6:00 PM", "15 min short after Staff meeting (Purdue)",
  "About 15 min short…" for a drive worked out without the map (to the
  nearest five minutes, as its drive line is). The other event's job is
  named only when it is another job, and its time takes its weekday when
  it starts on another day within three days ("Wed 11:00 PM"), its date
  further off ("Jan 14, 9:00 AM"): a weekday reads as the nearest day of
  that name, and within three days that is always the true one. Two
  drive lines that would read alike each take the other event's start
  ("15 min short before Site visit (Ref), 10:30 AM"). An event with several
  clashes has a line for each, so every one named can be opened. A line
  is a link `Button` at the line's own 16px that takes an underline on
  hover and opens that clash's dialog; the row's menu has
  Show clash, or with several "Show clash with Varsity Basketball" for
  each (two of one name take their job and time, the time as the line
  says it: "Show clash with Stand-up (Refereeing, Fri 9:00 AM)"). An event that is over carries none, and a clash goes from the
  row, its menu and its dot once its later event is over (Running late
  is for the time after the earlier one ends). Over is by the end LifeOS
  gave the clash, so an event with no end keeps its line for the hour
  the rule runs it. The line arrives with its
  read and nothing pulses for it. "Leave 4:35 PM" under the time is from
  where he will be: the event before when that ends within three hours,
  else the day's start.
  The Clash dialog is the `sm` Modal. Its title is the fact ("Two things
  at once", "15 minutes short", "About 15 minutes short"), the later
  event's day the 12px line under it. The body holds the two events in
  time order, 12px apart: each its title (14/22 medium), then one 12px
  muted line of its time span (tabular; a start on another day than the
  title's line names takes its weekday within three days, "Wed 11:00 PM",
  else its date, "Jan 7, 8:00 AM", and the end is said beside its own
  start, "Tue 11:00 PM to Wed 3:00 PM") and, 8px after,
  its job (the sector's 8px dot and, 8px on, its name), then where it is (the place as the
  map names it, less the country; his calendar's own words when the point
  is a town's centre or a start standing in); a long title or place
  wraps, whole, since a tip on a cut line is out of the keyboard's reach.
  Each event is a group named for it, so a verb under it says
  whose it is. Between the two is a
  hairline, which carries the drive in 12px muted at its middle when both
  have a point ("38 min drive, 24 mi", "About 40 min, 25 mi"). Under each
  event, 8px down, are the ways out it allows and no others, as outline
  `sm` buttons: Decline, Propose new time…, Move…, Running late…; an
  event that is over allows none. The foot
  has "This is fine" (ghost) at its start and Close at its end. The host
  runs Decline, a time, a move and This is fine through its own LifeOS
  session: while that is down, none of them is offered and one `DownLine`
  under the two events says the host's state, its computer named (it also
  stands for Running late's); a step already open keeps its note or times,
  says the line and holds Send until the host is back.
  A way out swaps the body for its one step: the event, one 13px muted
  sentence of what goes and to whom (the event stands above it and is not
  named again; a proposal says his reply turns to Maybe, as the calendar
  makes it; a move of an event with guests says they are told the new
  time), then Day, From and To (New event's fields, on one row from 400px
  of the dialog, else Day over the two times) for a proposal
  or a move, and a Note for a decline or a proposal; the foot is Back and
  Send (Move for a move). The times start filled: the earlier event with
  the latest quarter hour that still ends a drive before the later one
  (before the time that one asks him there, when a drive clash tells it),
  the later with the first after the earlier ends, never a time already
  gone; the start lands on the quarter hour and the event keeps the length
  it has. A field he leaves as
  offered sends the instant offered, each field on its own. A To before
  the start on the clock is the next day's, and says "Next day" under it;
  the same minute is no span. An event a day long or more keeps the days
  its end is past its Day, and one that ends further on than the next day
  names that day under To ("Sat, Nov 28"). A time the clocks skip on the
  day it falls on is refused in words, its field ringed in `destructive`
  until he edits and the day still named under To; a From or a To that
  is the second time its clock shows, the night the clocks go back, says
  so under its field ("Second 1:30 AM", "Next day, second 1:30 AM"), as
  an event's own times do ("1:30 AM to second 1:30 AM"); a time already
  gone is refused too. Send
  holds its width and spins, and the step's fields are locked while it
  is out; a toast answers the press and the dialog closes on the clash it
  showed, though his own press is what ended it. The toast says what is
  true when the host answers: a calendar's act is with LifeOS's sender
  then, not yet on the calendar ("Declining Staff meeting…", "Proposing a
  new time for Staff meeting…", "Moving Dinner…"), and only a move
  written in LifeOS itself is done ("Moved Dinner"). A Send that left
  and got no answer may have gone all the same: the step says "The host
  did not confirm the send. Check the calendar before trying again." as
  its alert and keeps Send off, with Back on; a refusal stays in the
  step in LifeOS's words, in `destructive`, as an alert. Back puts focus on the way it came from, or on Close when that way is gone. While the dialog
  reads a clash it was not handed, it draws the two events' bones with the
  hairline between them (and says "Reading the clash…" to a screen
  reader); a step he is typing in stays when the calendar settles the
  clash meanwhile: the title turns to "No longer a clash", the step's one
  sentence turns to "Nothing was sent." (read out as it turns) in the
  lines the sentence held, Send is off, and nothing moves; unless a Send
  of his got no answer, when the sentence stays and the alert says to
  check the calendar, since the clash may be gone because the act went. A step with
  times whose pair changed under it (either event's time, or the drive)
  holds Send the same way and says "These events changed. Go back for a
  new time.", since its offer was made for the pair as it was (never
  under his own press, which is what changed it); a step whose event
  ended while it was open says "This event is over." and sends nothing. What a
  read said for certain holds while a later read is out or fails: a clash
  seen gone never comes back from an old copy; a read that failed says why in the body; two
  events that no longer clash are the title "No longer a clash" over the
  foot, with nothing between; the same two that still clash after one
  moved to start first are the same clash. Running late… opens Mail's composer in
  that job's workspace with the people on the event and one line, and
  lets go with LifeOS's words when the read of those people gets no
  answer in ten seconds; if the two change or stop clashing while it
  reads, or the later event ends or changes job (as the screen or the
  read's own reply says), nothing is drafted and the press is his again
  on the pair as it is; once the time he would have been there by is
  behind him, its line says "I'm running late." and leaves how late to
  him; "This
  is fine" closes with a toast that carries Undo; it goes with the pair
  as he sees it, and LifeOS refuses it in words when a calendar changed
  the pair a moment before.
  In the Week and the Month a clashing event's block carries a 6px
  `warning` dot before its title, named "Clashes with another event".
  Events at once share their day's width in the Week; a block under 64px
  keeps its title on one line, cut whole with an ellipsis, and drops its
  time line, since where it stands says the time (agenda/agenda.css);
  pressing the event opens its day's list, where the line is. An event
  that is over wears none, as its row carries no line.
  Start places is a section of Settings → Work on the Work home host,
  after Where it runs (`StartPlacesSection`): Home, then the six jobs in
  LifeOS's order, each job's title its sector dot and name. A row's line
  is the place as the map named it; "Home" in muted text where a job has
  no start of its own; "Not set" for Home with none; a 12px spinner, 8px,
  "Looking up…" until LifeOS has placed a new address, turning by itself;
  the typed address with "Not found" as the row's red line when the map
  did not find it (a pasted link, which the map is never asked, says so
  at once and wraps inside the row); the typed address and ", using the
  town centre" while only its town's centre is known (said at once; the
  row turns by itself if the map then finds the place). Nothing on the row says whether a job's places go to
  the map: that lives in the dialog. The row opens a small dialog named
  for Home or the job, and its button is named for what the row says
  ("Change Purdue: Cedar Hall, 4 Elm Street"): one Address field, and for
  a job the switch "Look up event places on Apple Maps" with its one
  line, "When off, this job's event places never leave your machines.",
  and Use home at the foot's start while the field holds an address: it
  empties the field and leaves focus there, and Save sends that with
  whatever else changed, for that one job alone (another job's start or
  switch, changed elsewhere meanwhile, is kept). The fields are locked
  while Save is out, for ten seconds at most: then the dialog says
  "LifeOS did not answer. Save again to be sure." and he can. A read
  that shows what Save sent is the Save done, whatever became of its
  answer: while Save is out the dialog closes on it; after the wait ran
  out the words go and what it sent is no longer his edit. An edit is
  what differs from what is stored: a switch flipped back, or a value a
  read comes to agree with, follows the reads again, and an address he
  changed by spaces alone gives way when another comes in. An address
  is compared and sent as LifeOS keeps it, runs of spaces as one. An open
  dialog keeps what he typed when a read fails or the session drops (a
  field he has not touched follows the reads, and Save is on whenever
  the form differs from what LifeOS holds now): it
  says why in its alert, before what LifeOS said of an earlier Save, and
  Save waits for a read that is current; while a read is merely out or
  the session is still connecting, one 12px muted line says "Waiting for
  LifeOS…" after a 12px spinner.
  Save stays off until something changed, spins, and closes; a refusal
  stays in the dialog, as an alert. No toast: the row is the
  answer. Signed out of LifeOS the section is absent; while it reads,
  seven row bones.
- **The Money view** (work/money/; docs/agents/work-money.md). A job's
  ledger read as money, one 880px column read top to bottom like a
  document, 16px from the sides, sections 24px apart under 13px semibold
  headings. The 40px header holds Month or Year and the stepper (two ghost
  arrows round the period in 13px tabular, 120px wide so the arrows never
  move), drawn only once the job is known to have money or something
  waiting (never before the first read lands, never on a job with none,
  never in a columns fault), then Add and More, two menus of plain text
  rows as the other Work views' header menus are; Entry…, Trip… and
  Mileage rate… draw from the period's read and stay off until one has
  landed (Receipt… never waits). A read belongs to its
  period: when the period changes the body is bones until that period
  answers, and a failed read keeps only the same period's last figures
  under the state line. Money has one right edge: By category's amounts,
  Entries' Amount column, Owed's and To confirm's amounts all end 120px
  inside the column, and what follows an amount (the paperclip, Paid,
  Review and a row's menu) sits in those 120px, ending on the column's
  edge (layout.ts). Under 520px the least fact gives way first: Entries'
  Category becomes a 12px muted line under Who and Date narrows to 64px,
  By category and Entries
  end their amounts 48px in (the paperclip's room), Owed and To confirm
  keep their 120px for their presses, Owed's who and what wrap as one run
  of words rather than cut beside Paid (whose name says both), and Month or Year moves to two
  ticked rows at the head of More, so Add and More stay in the header. The 520px is the header's
  content box, inside its padding, for both the toggle's container query and More's measure
  (`headIsNarrow`, on the fractional width), so at no width is the choice in neither. To confirm leads the column while anything waits: a
  row each, a 32px picture (6px corners on the image outline, the receipt
  glyph where there is none), who or the file's name in foreground with
  the date 4px after it in 12px muted (the year only when it is not this
  year's), the amount, Review and the row's menu; a receipt still being
  read shows the spinner and "Reading" and nothing to press, its slots
  kept so the rows line up. Discard is in the row's menu and is said back
  in a toast with Undo, never asked about. The calendar's games and paid
  events follow under a 12px medium muted group name, "From the calendar",
  16px below the receipts (still drawn when only offers wait), with Add
  all at the end of that line once two can be added ("Add 2" when some
  need Review, so the label says its reach): the day ("Sat Nov 21") in
  12px muted, the event, then its fee with cents and its miles as a muted
  comma run (`Facts`), never a dot; Add when both are known and the miles
  were measured, else Review, its word on the column's edge as Review's;
  Skip in the row's menu, said back in a toast with Undo (an event skipped
  meanwhile is added by nothing and said by nothing). Then the figures, as text on one row with a hairline under it
  and no heading: In, Out and Net for the period, then, at the row's end,
  Owed to you and You owe, which are not the period's and are drawn only
  when not nothing; each a 12px muted label over a 16/24 semibold tabular
  figure, no tiles and no colour on a number. A year adds one chart, In
  and out by month: paired bars in `chart-1` and `chart-2` with a legend,
  since it compares two things, no bar below the axis (the hover still
  says the month's true, signed sum, "Out -$20.00"), money short on the
  axis ($1.2k from a thousand up, cents kept where neighbouring ticks
  would read alike). By category is a flat list on one scale (each bar its
  size beside the largest), the name, the 8px `chart-neutral` bar and the
  amount, `+` before money in; a row's press narrows Entries to it, and
  the heading then names the category beside a Clear. Owed is two groups,
  Owed to you and You owe: 40px rows of who and what for in muted, how
  long ("32 days"), the amount and one ghost Paid that spins while it
  lands, its word on the column's edge and the spinner opening to its
  left (on a row with money both ways, where one status covers both
  sides, Open ledger in its place, ending on the same edge); a cost to be paid back leads with what
  it was for and puts the seller after it in muted (with no For, the
  seller and "to be paid back"), so it never reads as the seller owing
  him. Entries is the flat `Table` (Date, Who, Category, Amount, and a
  paperclip where a receipt is kept; every row's money in the one shared
  form, `moneyWords`: "+$30.00", "$20.00", "+$30.00 and $20.00", "-$20.00
  out" for a correction below zero; Amount is 112px always, and a rare
  row with money both ways breaks its two figures onto two lines in its
  own cell, so it grows taller and no row's Who is cut to a letter; rows
  with money and no date Money can read are one quiet muted line under the
  table ("Row 7 has money and no date Money can read, so no month or year
  counts it.") with Open ledger, as the mileage log's fault line is; the
  log's trips with no readable date are the same line under the Mileage
  heading, after the miles line, with Open mileage log);
  the whole row is one press, reached
  by Tab, that opens the entry dialog, and it takes a `muted` fill in hand
  and while focused within, the table's one row with one, since the row is
  the control. Mileage, when there was any, is one muted comma line; a
  mileage log that cannot be read is one quiet line in its place, never a
  zero ("The mileage log has no Miles column, so its trips are not
  counted." or "The mileage log could not be read, so its trips are not
  counted.", with Open mileage log; or "The mileage log leads outside this
  job's folder, so its trips are not counted."), while the ledger still
  reads and Open ledger works; Open mileage log on a log that leads out
  of the job opens nothing and says so in a toast. Loading draws what
  never changes as text (In, Out and Net, the Entries heading and the
  column heads) and bones only what the read fills: the figures and six
  rows of Entries' own table, a bone in each cell; the table's layout is
  fixed, so its columns stand where the header puts them and nothing
  slides when the read lands. A ledger that leads
  outside the job's folder is a failed read in the host's words, never
  "No money yet". "No money yet" ("Drop
  a receipt here.", Add entry) shows only when the job has never had money
  in any period (`any`) and nothing waits, so the first drop on a new job
  is seen; a period with nothing keeps its figures and says "Nothing in
  November 2026" in the table's place; a ledger missing a needed header is
  the state line over To confirm and nothing else: "The ledger's columns
  changed", "No In or Out column" and Restore columns, or, where an
  unknown header holds cells, "No Out column: Spent may be it, name it
  back in the ledger" and Open ledger, never Restore (it would add an
  empty column beside his figures); a money header that stands twice says
  "Two Out columns: rename or remove one in the ledger" and Open ledger. The entry dialog is one form for a new
  entry, a row and a receipt to confirm: Amount (focused and selected, "$"
  quiet before it) beside Date, Who (the ledger's names offered) beside
  Category (the list, then New…), Spent or Received with To be paid back
  beside it for money spent (ticked, Status is not drawn: the two never
  disagree), Status beside For. Return in any field saves, pressed afresh
  each time (a held key saves nothing more); Save waits for an amount and
  a date. A row the one-way form cannot say (money both in and out, or an
  amount below zero) opens read only, its stored values in read-only
  fields at full ink with no picker, its status always shown, focus on
  Open ledger, under one muted line, "This row has money in and
  money out. Edit it in the ledger." or "This row has an amount below
  zero. Edit it in the ledger.", with Close and Open ledger in the footer;
  Open ledger spins with the dialog open, a refusal stays in the dialog's
  error line, and the dialog closes once the ledger opens.
  On a ledger others can open a write waits as a suggestion, and every
  write says so (an entry, Paid, an accept, a trip's pay or log row):
  "Suggested in the ledger. Accept it there.", with Open ledger; one press
  is one toast: a suggested invoice's created toast carries "Its row waits
  in the ledger for you to accept." as its second line, Add all says a
  suggestion once, and restored columns are said on the line alone
  ("Restored as a suggestion: accept it in the ledger"), whose press
  becomes Open ledger for as long as the read says the headers wait in
  the sheet; rejected there, Restore columns is back. Review opens the
  entry dialog wide, titled "Confirm receipt 1 of 2" while more wait, the
  picture in one 420px slot of a 320px column at the left, whatever its
  state, so Save never moves as it lands (a short scan at the slot's top,
  a taller one scrolling inside it; one muted line, "The picture did not
  load", with Retry where it failed or the browser could not draw it) and what was
  read in the fields, empty where nothing was, with no mark of how sure
  the reading was; Discard sits at the footer's start, its word on the
  picture's edge, and waits while Save is in flight; Save shows the next
  waiting receipt in the same dialog, Amount selected again. A file held
  over the view, its header too, lays a quiet wash over the body with
  "File as receipt" in foreground on a patch of the background; the view
  takes the drop itself, so it never starts a thread, a drop (or paste, or
  pick) of nothing Money files says "Money files pictures and PDFs." and
  how many were left out, by the host's own rule (`receiptFileName`); and
  from the drop until the host has every file one loading toast says
  "Filing 2 receipts…", let go when they reach To confirm or settled to
  the refusal. Add → Trip… is the trip dialog (Date, Name, Place, Miles
  there and back beside Fee, "Estimated: check the miles" under an
  estimate) led by From the calendar; Add waits for miles or a fee, and a
  fee of 0 is none; an event added before keeps the form open with "That
  event was already added." (one skipped meanwhile, "That event was
  skipped, so nothing was added."); an event picked there takes up one
  he skipped before. A trip typed by hand that the host already has is
  the dialog's own earlier Add: saved when it filed what the form holds,
  else the form stays with what was filed ("This trip was already added
  with 24 mi and $80.00 pay. Change it in the ledger or the mileage
  log."). More → Mileage rate… is titled for its year
  ("Mileage rate for 2026") and holds one quiet-"$" field, Per mile,
  seeded from the stored rate in plain decimals, padded to two places and
  never rounded ("0.70", "0.7251", never "1e-7"), with "Later years
  without a rate use the most recent one." under it. More → Export… asks the year (this one and the four
  before, the period's first when offered) and three boxes, all ticked:
  Spreadsheet (Excel), CSV, Summary (PDF); Export spins through the host's
  files, the summary's print and its keeping, then one toast, "Exported
  2026 for tax time", with Show in Files and, on its second line, one
  comma sentence of what was replaced, removed or could not be made (a
  summary not of the year's newest export says so in the host's words); with nothing
  made it stays open with the error. Add → Invoice… is a wide form: To,
  then Number, Date and Due in one row (the next number and his usual
  terms from the host), the lines (What, Quantity, Rate, the line's amount
  at its end, a remove on every line but the first, Add line quiet under
  them; Return in a line adds the next) with a quiet "Total" and the total
  under the amounts in semibold, then his own details, asked whole the
  first time and one muted line with Edit after; Create waits for a name
  in From. Create prints it and keeps the PDF with its row, then one
  toast, "Invoice 1042 created", with Send…. A Purdue job's Add also has
  Purchase request…, the same form with Vendor for To, Needed by for Due,
  a Reason, From for the name, and no How to pay. Send…, there and in a
  kept invoice's or request's own dialog (at its footer's start), opens
  the job's Mail with the composer filled (no address, the subject, one
  line that claims no attachment) and toasts the PDF to attach with Show
  in Files: the composer takes no file from outside, and nothing leaves
  until his own Send. A PDF's or a picture's More in a job's canvas pane,
  a mail's attachment or a file, holds File as receipt, after the pane's
  own rows and before Close: "Filing to Money…" at once, settling to
  "Filed to confirm in Money" with Open Money, or to the host's words.
- **A meeting's page** (work/prep/; docs/agents/work-prep.md). A view
  inside Agenda with no row in the column. The 40px header is People's
  way back (the arrow, "Agenda", the event's title muted) and holds one
  quiet verb for where the meeting stands (Brief me; Add notes once it is
  over; Follow up once notes stand; nothing once a brief or an outcome
  stands) beside More. While a thread writes, the verb's place is a
  spinner and a muted word ("Preparing", "Following up") that opens the
  thread. The body is People's column (720px, the same insets): the
  title on the 16px recipe, wrapping rather than cut, and one 12px muted
  comma line under it ("Today, 2:00 to 2:45 PM, RecWell 204, leave
  1:40"). What a thread wrote is body text (14/22) at a 65ch measure, a
  paragraph a line, 8px apart, with no heading while it leads the page:
  the brief before the meeting, the summary after. A line that names a
  mail, a task or a document is pressable on the row's hover fill. While
  the brief is being written its place holds three text bones; when it
  lands on an open page its lines rise in as steps do (`.step-land`, a
  step apart), and a page opened with its brief replays nothing. Then
  each section that has something, 24px apart under People's 12px medium
  muted heading: rows of People's shape (13px on 20px lines, a 12px muted
  second line, a 12px tabular fact at the end). A row that opens nothing
  is the same box with no hover. A person's row leads with the 24px face;
  its second line is their newest mail's subject and its end that mail's
  day, or "Declined". "Last time, Nov 16" is a heading that opens that
  page. A page with no one on it says so in one muted line with a ghost
  Add people after it. After the meeting the outcome leads: his notes at
  14/22 (six lines while they lead, two once the outcome stands over them,
  then Show all only when they run past that as drawn); Decided; To do; Open questions; Mail;
  then the brief under its own heading and the rest as before. A
  suggested task waits on `--add-bg` with a 16px checkbox at its first
  line, rows 2px apart and no wider than the brief's measure (a tint the
  column's whole width would shout), who it falls to as its muted line and
  when it is due at the row's end, as under Tasks; on the tint the box's
  edge is `muted-foreground`, since the usual hairline does not read there; the section's
  foot holds a ghost Tick all and, only while one is ticked, the page's
  one primary button, which counts them ("Add 3 tasks"). A filed task
  loses the tint, takes LifeOS's mark where the box was, and opens its
  sheet. The mail is one row, "Follow-up to Maya Chen and Tom Beck" over
  "Waiting in the Outbox", which opens the Outbox on it. A part that did
  not load, or a filing LifeOS did not take, is the view's one state line
  with Retry. The one-time offer of Prepare ahead is a 12px muted line
  under his first brief with a ghost Turn on and a dismiss. Loading draws
  bones in the page's shape. The Notes dialog is the 576px form dialog:
  one field at 14/22 that keeps its height and scrolls, under it two
  quiet 12px verbs (Use a recording or transcript, Write in a document)
  that wrap when the dialog is narrow, then Cancel and Follow up; it keeps
  what he typed however it closes, and Cancel spins while it does. While a
  file goes up the two verbs give way to the 4px `Progress` bar under the
  file's name (which truncates) and the per cent (which never does), with
  a spinner in the bar's place until the size is known.
  Add people is the 448px form dialog: a search, then a list that keeps
  its height, a 32px row a person with a checkbox, the face, the name and
  the address muted.
- **Project screens** (the Projects view; the tracker's projects screens,
  shared with LifeOS, on TempCode's scale). The view's one 40px header
  holds the screens' bar: the view's name on the list, else the way
  back, then the controls at its end, all quiet 28px buttons (New
  project; on a project New thread and New task) and a 28px ⋯. No second
  bar is drawn. The way back is one shape on every screen: a 24px ghost
  arrow, then the name of where it goes in 13px medium ("Projects", or
  the project a task or document was opened from). A row is 32px of 13px
  words on 20px a level, its bar the row radius (8px), `foreground` at 5%
  in hand and at 9% selected or pressed, at once. A project's name is the
  document title's recipe (18/26 semibold, -0.01em), edited in place.
  No screen draws a meter: a project's work is "2 of 7", done of all,
  in plain muted numbers, and a stage of work is a mark, never a word in
  its colour (a state's 14px glyph in `stage-doing`, `stage-waiting`,
  `stage-done`). Work in hand takes no hue (`muted-foreground`), as a
  working thread takes none: amber stays the one sign that he is needed.
  A task's key (PUR-41) shows only on the row in hand and in its menu
  ("Copy PUR-41"). A field with no value draws nothing: no "Due" or
  "Waiting on" slot.
  - **The list** is the tracker's rows for one job, in a column of
    64rem: one 32px row a project, with Next (its next task and when it
    is due: late in `destructive` with how late, "2 days late"; due today
    in `foreground`; later muted), Waiting on (the name in `foreground`,
    its age muted, "Sam Ortiz 6 days"), Threads (the most pressing
    thread's mark and outcome, as on the tracker; empty when it has
    nothing to say), Done
    ("2 of 7") and Target. One 12px muted head row names the columns
    once; the project column has no label. Rows sort by target date,
    none last, then by name, as the tracker's, so a row never moves
    because its work does. Paused and
    backlog fold under one quiet line ("1 paused, 1 in backlog"), Done
    and Dropped under "Show finished". One New project, in the header;
    the ⋯ holds Board. Under 896px a row is two lines (six columns need
    that room): the name and the
    target, then the facts as one 12px comma sentence. A cut Next is
    whole in a tip while the row is in hand (the pointer a while, the
    keyboard's focus at once), with no Tab stop of its own; a clipped
    Threads cell has the thread's title and its words in its tip. Loading draws
    bones in the rows' shape. A facts read that fails keeps every row and
    its count, with one muted line at the foot, "Next and Waiting on did
    not load.", and Retry.
  - **The board** (Board in the ⋯) keeps its lanes as open columns with
    no fill (a folded lane neither), a plus each but Done's and Dropped's, so a card is the one surface: `background` with
    a hairline (6px), a stronger hairline in hand, no shadow; it says its
    name, done of all and its target. Only a card being dragged lifts.
    Its menu opens on a right-click, or on the menu key or ⇧F10 when the
    card has the focus.
  - **New project** is the form dialog: Name, then State (Backlog, Active,
    Paused: a project starts open) and Target side
    by side, Cancel and Create (the one primary). While Create writes,
    Cancel and Escape do nothing. A refusal stays in the
    dialog with its words and Create reads Retry.
  - **A project's page** is one reading column at the document page's
    measure (44rem): the name; one 12px muted facts line (job, state,
    "target Feb 14"), each a press that changes it; the brief (the
    description, whole, as prose); Plan, with done of all beside it in
    plain numbers and, at its end, the tabs (All, To do, Doing, Waiting,
    each but All with a plain count, since the head says the whole; no
    chip) and Display, no rule above or
    below; the tree (or the task board, which keeps the brief, Files and
    Log around it; grouped by State or Priority, New task draws the plain
    tree while its line is open, Tab in it too, as does a row's Add
    sub-task, and the groups come back when it shuts; Tab and Shift+Tab keep the words typed, and Tab nests only under a task the tab shows; a tab that would hide the task an add line stands under draws it quiet, as an ancestor, and All opens the path above it whatever is folded, so the line keeps its place and words; New task from
    a board card's menu opens the project in List with the field focused);
    "2 done"; Files; Log. Sections stand 40px apart with
    a 14/600 head, no boxes. Files lists the project's documents, sheets,
    links and items and the files its threads made or changed, newest
    first, a 32px row each: glyph, name, then "Made by Seat map for 64"
    and the time muted at the end; a file a thread made opens in a Files
    tab of the job, a batch's files a row each. A host whose read failed
    keeps the rows it last gave, and Files ends with one muted line, "Some
    files did not load.", and a Retry button, never a file row and never "No
    files yet"; while a host's first read is out the known rows stand and
    "No files yet" waits. Log is his notes, LifeOS's changes
    ("You moved it from Backlog to Active") and the threads with their
    outcome under their title ("1 mail to send"), save what Files lists
    (a made outcome: the title alone), newest first, a 16px
    mark, the words and the time; Add note at the head's end opens the
    form dialog. The ⋯ holds Rename, State, Target date…, Board, Share…,
    Project settings… and Delete project…. A row in hand shows its key
    and Start thread in its tail; waiting reads "Waiting on Sam Ortiz 6
    days"; every thread on a task shows its mark in its row at rest, newest
    first, its title and outcome in the tip, each opening its own thread.
  - **The peek** docks flat at the pane's edge with a hairline and no
    shadow or corner, 44% of the view's pane (560 to 960px); the work
    makes room for it on a pane of 1280px or more, and under that it lies
    over the work; one rule of the pane decides both. Its Open and Close float over its corner so its title
    stands level with the page's; it is never wider than its pane. A peek
    over the work takes the focus and the work under it is inert;
    a press on the work it covers shuts it, Enter on it opens the task,
    and the page's keys wait until it shuts;
    shut, the focus goes back to its row, but New task and Rename in the
    header shut it first and take the focus to their field. Its
    sub-tasks are flat rows, their key
    in hand, "1 of 3" in muted numbers on a task with sub-tasks and the
    thread marks at their end, as on the tree's rows. A task's page names its project once, in the way
    back; under its title it names only a parent, where there is one
    (the peek, with no way back, names both). A Work project's settings are a sheet with its name, state,
    target (the kit's own Target field, as New project's), rules, accounts
    and sharing and nothing of code; what LifeOS
    cannot take now is shown as words, never as disabled controls. While
    Save writes, the fields hold still (disabled), so it never closes over
    a later edit.
- **The guest's page** (tempcode.landonhale.com) is the same editor on the
  same tokens under one 44px line: the item's name, whose it is, what the
  guest can do, until when, the faces of who else is in the file and the
  guest's own. A face there is the bar's 20px `Face`; the others lap 6px over
  a 2px `background` ring, each ringed 1.5px in the hue of their caret
  (presence, never a fill), three at most and "+2" in the line's 12px muted
  after them, 8px before the guest's own. The owner's own hosted page draws
  the others at the line's end. One muted 13px line under the format row,
  32px with a hairline under it, says what is wrong with the connection in
  words ("Offline. Your edits are kept on this device until the connection
  is back."); it is a status, never a warning, takes no glyph and no colour,
  and wraps to two lines on a phone rather than cut. An update too large to
  send is the same line in the text's place with a ghost Reload. A sheet's
  page has the same muted line over the grid ("Offline. Your edits are kept
  on this device until the sheet is back."), the grid still editable under
  it; a refused edit is the `failed` state mark "Edit not saved" with its
  reason, and edits that could not be kept one plain line ("3 edits made
  offline could not be kept. The sheet changed under them."), each until
  the next edit the sheet takes. A link that
  opens nothing is the page's one empty state: past its own end "This link
  ended Dec 18" over "Ask Landon Hale for a new one if you still need it.",
  else "This link no longer opens anything"; out of reach, "This page cannot
  be reached right now" with Retry. A styled document is sheets of its paper from 640px ("Work editors: Document pages"). What a guest may not
  do is absent, never disabled. A project's link draws the project
  screens there on the Projects view's own measures, read only: the line
  holds the List or Board switch before the guest's facts, no way back
  to a list of projects, and no Activity. A document or sheet of the
  project opens in place with a 24px back arrow first in the line and
  its own glyph and name after it; a document is drawn as text on the
  document page's measure, with no editor.
- **Sharing a project.** Share… is a row of the project's ⋯ and opens the
  same Share sheet as a document's, with no Can row: a project's guest
  views, and a choice of one is not drawn. The project's settings sheet
  has one Sharing row whose Share opens the same sheet.

#### Today

One page above the Work workspaces: what waits on his press, today's
meetings, what is due, the mail no one answered and the files others
changed, for every job (work/today/, docs/agents/work-today.md). It is the
first row under the rail's Work heading (a sun, "Today", no count: Today is
not a queue), before Projects (a briefcase: every job's projects on one page),
Review (a calendar ticked off) and Work Chats; Go → Today, ⇧⌘T, opens it and also closes it: the menu's row
reads "Close Today" while the page is open. Open, its rail row wears the
workspace cards' selected fill (`sidebar-group-selected`), since an item's
own selected fill is a card's fill at rest in light.

- **The frame** is the Outbox page's: a 40px header with the place's 14px
  glyph, its name in 13px medium and, at its end, the date in 12px muted
  tabular ("Mon, Nov 23"). No title in the body, no counts, no filters, no
  cards. The page opens and closes with no motion: it is opened by a key
  many times a day.
- **One column**, 720px at most, 24px in. Sections are a 12px medium muted
  heading (28px) over their rows, 24px apart, in a fixed order: Waiting on
  you, Meetings, Due, Waiting on others, Messages, Changed by others, Owed,
  Also (the last two only while they hold something). What is blocked
  on his press comes first; the page is grouped by need, never by job.
- **One row grid for the whole page**: a 16px lead, the title with an
  optional 12px second line, the job (its sector's dot and its name, 12px
  muted, a 112px column), then the trailing fact (12px tabular, at the end of
  an 80px column), 12px between columns. Every title on the page starts at
  one left edge, and a fold or an empty line starts there too. A one-line
  row is 32px, a two-line row 48px, rows 2px apart, 6px radius; hover is
  `foreground/5`, a press `foreground/12`, at once. In a column under 480px
  (the window at its least, beside the rail and the Chats column) the page's
  inset is 12px, the gaps 8px, the job's column the dot's 16px and the fact's
  72px: the job's name leads the second line in medium, 4px before its detail
  (a row with none has the name alone there), so the title gets the room and
  no job is cut to four letters (`@container/today`).
- **The lead** is the row's own control or its kind: a round `Checkbox` on a
  task (its ring at rest in `muted-foreground`: on the page's own ground
  the field border is too faint to find), the Outbox's kind glyph on a held item, the file's kind on a file,
  nothing on a meeting or a waiting mail.
- **The job is on every row**, dot and name: the dot is never the only cue,
  and the column is one the eye can run down to find a job. The name is the
  workspace's, as the rail and the held sheet say it, never the sector's
  own word; a held row names the very workspace its item is in. A title,
  a second line or a job's name the columns cut is said whole in a tooltip,
  only while one is cut: the title, then the job's whole name and the
  detail, as the narrow row's second line reads.
- **Verbs show on hover and on focus**, in place of the job and the fact
  (`reveal`, `yields`): at most two ghost `xs` buttons, the last one's
  label ending on the facts' edge. None is drawn at rest, and Send is never
  one of them: a held row opens the item whole in a sheet from the right
  (520px) whose body is the Outbox's own detail, with its Send and its
  rule. The sheet's 40px head says where he is in the run ("2 of 5", 12px
  muted tabular: the items decided since it opened, then this one, of those
  and the ones that still wait, so it counts forward by the run's own
  steps, whenever the host's list catches up) beside Close, whose glyph
  ends on the body's edge. After a press it shows the next held item in
  the order he saw, which fades in over `--dur-base` on `--ease-out`, takes
  the focus (the ring shows where it went) and is inert, to the pointer and
  the keys alike, until the fade is over, so a double click never sends an
  item he has not seen; it closes after the last, and never goes back to an
  item his press already took. Closed, it gives focus back to the list's own
  stop, or to the page once no row is left. A press that does not go
  through is said in the item's own red line, brought into sight, since a
  sheet lies over the toasts. The sheet's head says the item's time as its
  row does. A held row's fact is when it was held, as a time that names its
  day ("7:42 AM", "Sun 7:40 PM", the date alone after a week): never a bare
  date for yesterday's, which is what a late task's due date looks like.
- **A toast sits at the page's foot over the titles** (lib/toastAnchor.ts:
  the titles' column is the anchor), clear of the ticks before them and the
  verbs after, so a run of ticks or dismissals never waits on a toast. The
  list ends with a runway a toast and its gaps tall (96px), so the last row
  can be scrolled clear of the stack. In the narrow column, where a toast
  is as wide as a row, the page's own toasts get a strip under the list
  (80px for each of them, up to the four the toaster shows, so the stack
  covers no row even open under the pointer; only while one is up),
  outside the scrolling rows. While the held
  sheet is open the toasts are back in the window's corner, behind it, as
  under any sheet.
- **Long sections fold**: Waiting on you shows 5, Due 7, Waiting on others
  5, Changed by others 5, then one muted 12px line ("4 more") that unfolds
  in place and stays unfolded. Meetings that have ended fold into "2
  earlier" at the section's head.
- **One live line**: under a meeting's time, 12px medium `foreground`,
  "Leave 5:10 PM" while that is ahead, then "in 25 min" within the hour,
  then "Now". Nothing else on the page moves by itself.
- **Late is the only colour**: an overdue task's fact and a clash's note are
  `destructive`. No amber: held is not Needs you, and a page of asks must
  not read as a page of alarms.
- **States.** A section that has never answered draws its heading over
  three bones in its rows' shape (two lines where its rows have two, a
  round bone before a task's), so nothing under it moves when it answers;
  nothing else waits for it. A section whose rows came while a read some
  job needs is still out keeps them usable and draws one bone under them
  (three, and never its empty line, where none came); rows it only reads
  again on a reopen stand with no cue. An empty
  section is its heading and one 13px muted line ("Nothing waits on your
  press", "No meetings today", "Nothing due today", "No one owes you a
  reply", "No one changed your files"). With nothing left the page is one
  `EmptyState` and no headings: "All clear" over "Nothing needs you
  today.", or, once the day's meetings are over, over what tomorrow starts
  with ("Tomorrow starts at 9:00 AM with Staff sync."). A meeting that
  ended is not left, whether "N earlier" is folded or open, and the page is
  not clear while any source is still out, even one that draws nothing
  while it waits. A read that did not come back is one line in the
  section it feeds, on the rows' grid: the failed mark in the lead, the
  words on the titles' edge ("The box did not answer", with the cause
  beside it only when it is not the wait running out; "LifeOS could not
  read tasks" for a read LifeOS refused, "LifeOS could not read Ref's
  tasks" for a job no signed-in host can read), Retry's label ending on the
  facts' edge; that section never says "nothing" beside it. A job no
  signed-in host can read says so with no Retry ("No signed-in host can
  read Ref's tasks"); a read that failed in a source with no section, and a
  source that broke ("Today could not show this" in its own section, "Today
  could not show clashes" under Also, naming what is missing), are said
  under Also, once each, and the page is never clear over either. An
  offline host is one 12px muted line at the page's foot ("Mac is
  offline."), on the titles' edge, and nothing more: no section draws a failed line for a read
  its link refused, and a section that reads LifeOS says nothing while no
  linked host holds a job. While no
  host can reach LifeOS its sections give way to one line on the same grid,
  in the session's true state, the computer it reads through named: "LifeOS
  did not answer the box", or "The box did not answer" for a host whose
  status or session ask went unanswered, in red with Retry; the plain muted
  "Not signed in to LifeOS on the box" (or "LifeOS refused the box's
  sign-in") with Sign in, and "The LifeOS sign-in on the box waits for your
  approval" with Show the code, where this window may sign the host in;
  "Work is off on the box" muted with Open Settings where this window may
  turn it on; else with who can under it; "This computer cannot read LifeOS
  through the box", muted with no press. A job read through another host's
  session that is down is one line for the page a host and state, in the
  place of the first section it fed: that session's state the same way, its
  press by the same rule, then what every section left out on a muted line
  of its own ("Refereeing's meetings, tasks and mail left out"), its Retry
  asking that host alone; the other jobs' rows stay. A section that held
  nothing but what that session, or an offline host the foot names, took
  from it is left out whole, never a bare heading, and the page is still not
  clear. A muted line with no press
  wraps across the columns the press would take, never cut. A cut detail is a Tab stop with its
  whole words in a tip.
- **Keys.** Every row and every fold line is one list and one tab stop: ↑ ↓
  Home End move, Enter opens the row or the fold, Space ticks a task; the
  row the arrows are on shows its verbs. A fold he opens hands its focus to
  the first row it showed. Focus lands on the first row when the page
  opens, and where he left it when he comes back, unless he had scrolled
  that row out of sight: then on the first stop in sight.
- **A row that leaves a list by his own act** (a tick, Tomorrow, Dismiss, a
  Send from the sheet) fades where it stands over `--dur-fast`, inert; then
  its place closes over `--dur-base` on `--ease-out` (`glideHeight`), so
  the rows under it glide up by its height; then it is gone, whether or not
  its source has dropped it yet. Under reduced motion it fades and the list
  steps. A task's tick holds 350ms first, its title struck through, as in
  Tasks; a tick he made still completes if he leaves the page inside the
  hold. The stop that takes the focus of a row that left is brought into
  sight, and once no stop is left the page's own region takes it. A row that comes back while its place closes (Undo, an act that
  failed) stands whole at once. A row that leaves because the world changed
  just goes. A row that
  arrives while he is looking lands (`.step-land`); the rows a list opened
  with, and those his own unfold shows, do not move. This is the rule for a
  row leaving any list by his act.

#### The tracker

Projects, one page above the Work workspaces between Today and Review (a
briefcase, "Projects", no count): every job's open projects, a row a
project (work/tracker/, docs/agents/work-tracker.md). Its frame is
Today's: the 40px header with the glyph and the name, and at its end one
quiet 28px outline `Toggle` (its hairline says press at rest), Waiting on you, which keeps only the rows with a held
act, a question, a failure, a late task or one due today. Nothing sits
beside the page's name; no counts, no other filters, no cards.

- **One column of 64rem**, the job's Projects list's own measure, with one
  12px muted head row naming the columns once (the project column has no
  label). Then a group a job, 12px apart: the job's name in 13px muted on
  the rows' left edge, its sector's dot hanging in the gutter before it,
  so every project name starts at one edge. The job's name is the
  workspace's.
- **A row is the Projects list's row** (work-kit's `ProjectFactsRow`): 32px,
  Next (late in `destructive` with how late, due today in `foreground`),
  Waiting on (the name, its age muted), Threads, Done ("2 of 7"), Target.
  Threads is the most pressing thread's mark and its outcome in words: a
  question's amber mark, a failure's red, the Outbox's glyph muted for a
  held act ("1 mail to send", never amber), the spinner for live work; a
  file made or an act done says its words with no mark. No lead mark on
  the row: the Threads cell says it once. Rows stand by target date, none
  last, so a row never moves because its work did; paused and backlog fold
  under one quiet line a job. Under 896px a row is two lines, as the list's.
- **Presses.** The row opens the project's page in its job; the Threads
  cell's words open the thread. A job's head shows a 24px + at its end on
  hover or focus (`reveal`), New project in that job: the job's Projects
  view opens with its New project dialog.
- **States.** Loading is the rows' bones under the head row. An empty job
  is its name and a quiet New project, nothing else. A job LifeOS could not
  be read for is `DownLine` in the group's place (the shared words and their
  press); where the window's own session reads, the host's words with a
  ghost Retry. A host that did not answer, or whose link is not open ("The
  box is connecting."), is one 12px muted line over the
  groups. Under the filter a job with nothing waiting goes; with nothing
  left, and every host answered, the page says "Nothing waits on you". A
  clipped Threads cell has the thread's title and its words in its tip. The
  page keeps its last answer, so a second visit draws it at once. The page opens and closes
  with no motion.
#### The column

A Work job's column (chrome/WorkspaceSessions.tsx, work/shell/WorkColumn.tsx, work/shell/WorkColumnRows.tsx;
docs/agents/work.md "The column") holds three groups, 16px apart, on the rail's 12px row inset. Nothing in it asks a
host anything per row: the rows read the session summaries (`workOutcome`) and LifeOS's `projects:list`.

- **Views**: Mail, Tasks, Agenda, Messages, each a 28px `RailRow` with its one muted fact, then **More**, a row of
  the same shape (the ⋯ glyph, muted) that shows or hides the rest under it (People, Money, Files, Forms, Templates,
  Plays, Routines): a fold, not a menu, so no fill while open. The More view he last opened stays as a row of its
  own after Messages until he leaves the job. Projects has no view row: its heading is the row.
- **Projects**: a 28px heading, 12px medium muted, that opens the job's Projects view (and reads as open, the
  `muted` fill, while it shows). Then a row a project, 28px: the 16px lead slot says what is live in its threads,
  most pressing first (the amber mark for a question, the red mark for a failure, the Outbox glyph in muted for a
  held act, never amber; the spinner for work), else nothing; the name; the target date at the end in 12px muted
  tabular ("Dec 12", the year only in another year), red once its day has passed. Rows sort by target, none last,
  so a row never moves for what its threads do. Paused and backlog fold into one quiet row on the names' column,
  "1 paused, 1 in backlog" as the tracker counts them, that shows them under it; one with something live keeps its
  row in the list. A row opens the project's page in the Projects view and reads as selected while that page (or a
  task or document of it) shows, however he came to it; a paused or backlog project's page opens the fold. The
  heading reads as open only on the list, and from inside a project it goes back to the list. Held outranks working in the lead (a thread still working that holds a
  mail shows the Outbox glyph): what waits on him comes first.
- **Threads**: a 12px heading, then every root thread of the job, loose and in its projects, newest first, a page
  at a time. A row is two lines, 6px top and bottom: the lead slot (the same marks, and the thread's own at-rest
  marks: watching, paused, …), the title in 13px (medium foreground while unread) and its time at the end in 12px
  muted tabular ("10:02 AM" today, "Tue" this week, "Nov 3" before), none while it works, since the spinner says
  now; under them in 12px muted the project, then what it left him, one comma sentence ("Spring LAN, 1 mail to
  send"), or nothing when it has neither. A row with neither is its first line alone. Done and idle draw no mark.
  A title or second line the column cuts is said whole in a tip on hover and focus, only while one is cut.
  Right-click or ⋯ (over the time on hover) is the thread's menu; a double-click renames it.
- **Archived**: a quiet row on the names' column at the end of Threads, "3 archived", opening the archived list
  (`ThreadListPopover`, Restore on hover) of the job's threads, loose and in projects; a pick restores and opens
  the thread. Work Chats ends its list with the same row. Nothing while none are archived.

#### A thread's head

A Work thread opens on what it left him (surfaces/transcript/WorkHead.tsx; the record is the host's,
docs/agents/work.md "What a thread left him"). It is the transcript's own top, in the first message's row on the
768px column, and scrolls with the thread: no band under the title bar, no card.

- **Rows, one grid**: a 14px lead in the transcript's glyph column, the title in 13px foreground over an optional
  12px muted second line, and a trailing fact in 12px muted tabular ("Held 10:02 AM", "Made 10:04 AM"). A row is
  32px, 48px with its second line; one with somewhere to go is a button whose fill reaches 8px past the column so
  its glyph stays on the transcript's: hover `foreground/5`, press `foreground/12`, at once.
- **The order**: what waits (a question, a failure, a thread's request, each held act, a failed send first), then
  the open task it works on, then what it made or changed, newest first. Under the last row a hairline and 20px,
  then the first message.
- **Tones**: held is muted, the Outbox's kind glyph and nothing amber; an out-of-date held act says "Out of date",
  muted. A question is the one amber row ("Asks you", the waiting mark); its card stays where the transcript asks it,
  and the row takes him there, from the keyboard with focus in the card so he can answer. A failure is red, its words
  in the red tone and its cause muted under them, and its row takes him to the transcript's failure card, where its
  fix is, the same way; a failed
  send takes the red mark, its error is its red second line and its fact is "Failed 10:04 AM", never "Held".
- **The task**: its title, then who it waits on and for how long ("Waiting on Sam Ortiz 6 days", as the plan row
  says it), else when it is due, late in red once its due time passes (as Tasks and Today); the row opens its sheet in Tasks. "From the task …" (12px muted, the title in foreground) sits
  over the first message, right-aligned as the message, only when the head has no row for that task (it is done):
  nothing is said twice.
- **Made and changed**: the file's own name with its kind glyph, the verb and time as the fact; the row opens it in a
  Files tab of the job (`openInFiles`), a Google upload on the web, a link into a project on its page.
- **A held row** opens the Outbox's own detail in a 520px sheet from the right (`HeldDetail`, as Today's sheet), with
  its Send, Edit and Discard; the head adds no Send of its own. In the transcript a held call is one quiet line,
  "Held" then the act, all muted, in the call's place.
- **Nothing left**: no head at all, no empty line. It is drawn once its record lands, with no bones: it sits above
  the thread's start, which a returning reader is rarely scrolled to. A refresh that fails keeps what it showed,
  with one 12px muted line under the rows: "Couldn't refresh. As of 10:02 AM"; so does one whose LifeOS read
  failed, which keeps the task as last known.
- **The title bar** of a Work thread is its crumb: the job's dot (12px), the project (a muted button opening its
  page) or, loose in a job, the job's name, a 12px chevron, then the title in 13px medium; no strip of thread chips.
  A Work Chat shows its title alone. A code thread's bar and transcript are unchanged (pixel-diffed).
- **The right panel** lists Results but opens on them only when he picks them.

#### A Work draft

A Work draft and a Work thread share the code composer's box (one row: `+`, the field, Send) and replace only the
row under it (work/composer/WorkComposerRow.tsx, its own lazy chunk; the branch is the row's, lib/workRow.ts). It
holds the code row's place and size: 24px, 4px under the box, its first glyph on `+`'s axis, its last control on the
box's right edge, ghost controls in 12px muted text (`ROW_CONTROL`).

- **The draft** leads with its source chip in the box (a task, a mail) and its field asks "What should it do?"; the
  centred "How can I help you today?" is code's. Under the box at the left, the filing control: the job's dot (8px in
  a 14px slot), the job's name, a 12px chevron and the project, then a 12px chevron down ("Purdue Esports › Spring LAN
  ▾"; loose, the job alone). Its menu: the job's name as the label, the job's projects in the column's order (LifeOS's
  live projects, a project with no mirror yet among them; the one it files in checked), No project, a separator,
  Another job (a submenu of the other jobs, each with its dot). A pick moves the unsent draft whole: its words, files
  and chips stay. Picking a project with no mirror opens it first (`work.project.open`): the trigger shows its name
  with a 12px spinner just after it until it lands; the field keeps taking words but Send waits until the move
  lands or fails. A failure says so in a toast in plain words, and the control names the old place again. A Work Chat's draft reads "Work Chats" and its menu lists the
  jobs. There is no type picker, Master thread, name field, host picker or context meter.
- **The thread** asks "Reply, or steer the work", and its row holds the settings glyph alone.
- **One settings glyph** at the right (`SlidersHorizontal`, 24px, "Thread settings"): a 288px popover over it, aligned
  to its end. A draft's first row is Chat | Research, a full-width segmented toggle; then 32px rows, the label 13px
  muted at the left, the control at the right: Model (the model menu, its tabs, favourites and search held to the
  providers Work allows, src/shared/work/providers.ts) and Access. Access names each mode by what the thread does on
  its own: "Asks first", "Edits on its own", "Works on its own", each with one line of what it changes and asks; the
  list ends on one muted line, "Sending, posting and sharing always wait for your press." ⌘. opens the popover, then
  the model menu inside it.
- **The title bar** of an unsent Work draft is its crumb alone: the job's dot and its project (or the job), no chevron
  after it, no title and no strip of chips, until the first send makes it a thread's crumb.
- **The `+` menu** reads "Mention a task, mail, file or thread". A Work thread's first message has no "Project rules N
  words" row: the rules live in the project's settings.
- Code composers are unchanged: three code pages (the docked footer, the composer's fixtures, the empty thread) at
  864 and 400 in both themes differ by zero pixels.

#### Work editors

What the document, the sheet and the deck share on screen. Who hears a key,
Print… and Export… are docs/agents/work-editors.md.

**Two keys every editor shares** (decision 11). ⌘S saves now what holds the
focus: a Work file sends the edits it still holds, and its line says Saved
only on that send's receipt; a Word file of Teams whose save is his press
says so in a toast ("Plan.docx changes when you press Save to Teams."); a
code editor saves on ⌘S only when the focus is in it. The menu's row is
File → Save. ⌘P is Print inside an editor, and Go to everywhere else in
the Files place.

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
  not drawn there. A change made another way that the file cannot keep (a
  range dragged to move it in an Excel file) is taken back as he makes it,
  and one toast says why in a few words; no line stands over the canvas
  about it, and nothing stays on screen that the file does not have. The
  same holds for a move the file's host refuses once it has read the file
  ("Move this in Excel: it crosses a table"): the grid takes no edit for
  the seconds the move is with the host, then keeps it or takes it back.
- **In the sheet** the row sits over the formula bar. Its groups: Undo and
  Redo; the cell style (Normal, the headings, Total, Input, Note, then
  Good, Bad and Neutral in the app's own inks, then Currency, Percent and
  Comma, and under the rule "Clear formatting" with its key); the font and
  the size; Bold, Italic, Underline, the text colour and the fill; then
  Align (with Wrap text and Merge cells), Borders (a menu of six: All,
  Outside, Bottom, Top, Top and double bottom, None) and the number format
  ("123": Automatic, Number, Currency, Accounting, Percent, Date, Time and
  Plain text, each with its example, then More decimals, Fewer decimals
  and "Custom format…", which opens a small dialog for a format code).
  Strikethrough is a key alone. The font and the size show the cell's own;
  a cell with no family reads "Default" (the sheet's own face, not a font
  the list offers) at the size the grid draws; a selection of mixed cells
  shows the active cell's. A named style sets what Excel's sets (a
  heading the font and the border, Currency the number format alone), and
  the select names the style a cell wears while that part of its look is
  the style's. A border preset too large for one press has its row off; a
  merge that would empty cells asks first, in the app's own confirm. The
  row ends in Preview, as a document's does (the row's way out, its eye
  glyph and word), opening Preview on the format he last used.
- **Find in the sheet** is the document's find bar over the grid's top end, 8px down and
  16px in from its right edge: the same 360px bar, words and keys, with Whole cell in Whole word's place. A match
  is washed at `find-hit`'s weight on the cells; the one he steps to is selected. Replace is there only where he
  may edit. The formula bar's first field is the **Name Box**: he types a place (B2:D9, Roster!A1, a name) and
  Return goes there; one that is not there stays, ringed in `destructive`. While he types a formula in the bar, a
  press or a drag on the grid puts the range's reference in at the caret.
- **Freeze and Hide** are rows of the grid's right-press menu where the sheet's store
  keeps them: Freeze › (Freeze panes, Freeze top row, Freeze first column, and under a rule Unfreeze panes), and on
  whole rows or columns Hide row or Hide column, with Unhide where one is hidden. A **sheet tab** is dragged into
  its place: a 2px `accent` line in the gap, no tab moving under the pointer; ⌥← and ⌥→ move the focused tab.
- **The sheet's Data** is one menu in the row's data group (232px): Sort
  (A to Z, Z to A on the selection's column, then "Custom sort…"), Filter
  with a check while the sheet has one (⇧⌘L), and under a rule Validation,
  Conditional formatting and Named ranges, which open the side sheet. A
  row is there only where the sheet's store keeps what it makes; a guest's
  page has no Data menu. Custom sort is a dialog: the range, "My data has a
  header", up to three keys.
- **Tables.** Insert holds Table (its glyph a plus, the row's the table
  glyph), which makes a table of the selection's block in Medium 2. While
  the cell in hand is in a table the data group ends with Table (232px):
  Style › with the style's name in 12px muted, opening a 264px grid of
  Excel's styles under "Light", "Medium" and "Dark", seven to a row, 6px
  apart; Total › on a total row's cell; then Header row, Total row, Banded
  rows, Banded columns, First column and Last column as checks; under a
  rule Rename…, Resize to selection and Convert to range. A swatch is the
  style as a 28 by 20 table of five rows and four columns, in the file's
  own theme and never themed, every line on whole pixels, on the
  `image-outline` edge at a 3px radius; the table's own takes the 2px gap
  and the 1.5px `foreground` ring, the one under the pointer or the keys
  the same in `muted-foreground`. A row that cannot be had is off, its name
  and glyph at half, with why on a 12px muted line under the name ("Remove
  the filter first"). Rename is a 360px dialog: one field, what is wrong
  with the name in 12px `destructive` under it as he types, Rename off
  until the name can be taken. A table is drawn in its Excel style and the
  file's theme; a table's header carries no filter button. Insert is one
  menu (208px): Chart, Table, Picture, each where the sheet's store keeps
  it.
- **Page breaks (the view).** The grid itself, still editable, with the
  row's Page › Page breaks checked. A page's edge is a 2px `border-strong`
  line: dashed where the page size makes it, solid where he set it (a
  manual break, a print area's edge). Each page's number reads "Page 1" in
  12/16 `muted-foreground`, tabular, on a 16px `background` pill (4px
  radius, 0 4px), 6px in from the page's bottom-right corner; a page whose
  corner is out of the window keeps its number at the window's edge, 12px
  clear of the grid's scrollbars, and a page with less than 64 by 22px in
  view shows none. Cells outside a print area sit on `muted`, their ink
  untouched. A break between two pages takes the pointer within 6px of its
  line (`row-resize` or `col-resize`) and darkens to `muted-foreground`
  under it. Held, it is a 2px solid `accent` line at the row or column edge
  it would take, its old place stays at 40%, and a 24px readout (the
  popover fill, its ring and shadow, 6px radius, 12px tabular) sits 6px off
  the line beside the pointer: "Above row 25", "Left of column G", "Scale
  85%" when the page must shrink to hold more, "Remove break" where setting
  it down removes it. Nothing animates but the line's colour (150ms). With
  the keyboard on a break it is the same accent line: the arrows move it a
  line at a time, Delete removes one he set. Under Fit to no line moves and
  the first page number in view is preceded by the scale ("Scale 73%", the
  same pill, 4px before it). A read-only sheet shows its pages with nothing
  to take. **Page set-up** is a dialog from the row's Page menu; its
  measures are in work-kit's README.
- **Notes.** A cell with a note or a thread carries a 6px corner triangle, `muted-foreground` for a note, `accent` for a thread. Its pop-over is the popover's surface, 280px, 12px in, 6px off the cell's right edge: author 13px medium, time 12px muted on its baseline, words 13/20, replies 12px in, "Resolved" and "Reply in Excel" 12px muted. A note's text is a field in place where the store keeps the edit. The host says what a note takes by store (`view.notes`): an Excel file rewords a note it has, a sheet of ours makes and removes them too, and a guest's page, a sheet he cannot edit and a workbook Excel or Google holds read them only.
- **Rules, the side sheet.** 320px, docked at the grid's right on
  `background` with a 1px `border` left edge and no scrim: the grid stays
  live, and the open rule's range shows on it in `sel-bg`. Under 560px of
  canvas it stacks under the grid, 344px tall, its hairline on top. The
  header is 40px: a 13px medium title ("Rules", or the rule's kind with a
  24px Back chevron first) and a 24px close. One list a kind
  (Conditional formatting, Validation, Named ranges): a 28px heading in
  12px medium `muted-foreground` with New at its end; a rule one 32px row
  at 6px radius: a 32 by 20 swatch reading "Aa" in the rule's own format
  (a validation or a name takes a 14px muted glyph), the condition in
  plain words at 13px, truncating ("Total above Budgeted", "Status from a
  list"), then its range in 12px muted tabular figures. Hover is
  `foreground` 5%; the open rule `muted`. A rule opens in the same sheet,
  16px by 12px in, 16px between fields under 12px medium muted labels:
  Apply to with a 24px pick-in-grid button inside the field, the
  condition, the style (a preset select, then Bold, Italic, the text
  colour and the fill from the format row's parts). The foot is Delete
  rule (ghost, the destructive ink on hover) and Done. Edits apply as he
  makes them and each is one step of Undo; there is no Cancel. No list
  says anything while it is empty but one quiet line. It is shut while
  the sheet takes no edit (read only, or reading its file again) and stays
  shut after.
- **In the grid, a filter and a list.** A filtered range's header cells
  carry an 18px button 4px from the cell's right edge (4px radius, a 12px
  chevron, `muted-foreground`; the accent's ink on a column with a
  criterion), and the header's text keeps clear of it. Its menu is ours:
  Sort A to Z and Z to A, a search field, the column's values with
  checkboxes and their counts in 12px muted, "(Blanks)" last, one
  condition, Clear and Apply. A cell with a list validation shows the same
  button while it is the cell in hand; its list is a menu under the cell,
  128px or more, with a check on the current value. A value a rule refuses
  is said in a small notice by the cell, in the rule's own words when it
  has some. Univer's own panels for these never open.
- **A sheet's charts and pictures** (work-kit `src/sheet/objects`; on an
  opened Excel file, a `.tcsheet` and a LifeOS sheet, and to see on a
  guest's page). A chart's colours are the file's theme, as cell fills
  are (TempCode's theme for a sheet made here: `chart-1` to `chart-4` as
  accents 1 to 4), and are never themed: they hold in light and dark. The
  frame: 12px in, a 1px `border`, 8px corners, `background`; the title 12px
  medium; the legend 8px squares at 2px corners with 12px
  `muted-foreground` names (the series in hand `foreground` while the chart
  is selected); axes 12px tabular `muted-foreground`, gridlines `border`,
  the baseline `border-strong`; bars with 2px outer corners, stacked bars
  square. In hand: a 2px `accent` outline 1px inside the box and four 8px
  corner handles (2px corners, `background`, a 1.5px `accent` edge), held to
  their size at any zoom. A picture: 4px corners, a 1px `image-outline`
  ring. With a chart in hand the row holds the chart type (a 132px select,
  a 216px menu, a rule over each family), font, size, B, I, U, text colour,
  series fill, then Data range, Title, Legend and Axis titles as word
  buttons (Title a pressed word); Data range is 288px, 12px in, 28px range
  fields, 32px series rows, a 10px swatch. A kind not drawn keeps the frame
  and title, with the kind in 13px `foreground` and "Opens in Excel" in
  12px `muted-foreground`, centred. Nothing of a chart animates.
- **A format or a rule an agent proposes** changes no cell's value, so it
  sits in no cell: it steps with the cell changes in the bar's stepper,
  its range marked as a waiting change is, and while the stepper is on it
  the formula bar says it in words, in muted ink with no tint ("Bold,
  yellow fill on B2:B9"): it takes nothing away. One whose rows or columns moved since says so there and can
  only be rejected.

**A sheet opened as a copy** (an `.xls`, `.ods` or `.tsv`, which opens as
an Excel copy: `work/sheets/ImportLine.tsx`). The deck's quiet line again,
between the format row and the grid: 12px muted words, a 12px inset, 4px
above and below, a hairline under it, then one press 8px after the words,
a link button in the same 12px with its busy label, off while it runs and
as tall as the line to a pointer. The words say where his edits go and
what the first format drops: "Edits save to an Excel copy. Saving back as
.xls drops tables and newer functions.", then "Save back"; for a file
others can open, "Edits stay in this tab's Excel copy until you save
back." Where the copy cannot go back the words say why ("This file changed
since the copy was made, so it is not saved back.", "This file holds
macros, which an Excel copy does not keep, so it is not saved back.") and
the press is "Save as Excel", the way that keeps his edits. The save line
under the file's name says the copy saved ("Saved 3:04 PM in the Excel
copy"), never the file the tab names, which is untouched until Save back. A
save the host refused on any sheet but an opened Excel file reads "Not
saved." with its reason and Retry, in the foreground; only a dropped link
reads Offline. The words wrap
to a second line in a narrow pane and are never cut, since they say what a
save would lose. More keeps "Save back as .xls" and "Save as Excel", and
"Discard edits and read again" only when the file changed under his edits.
A press that went through is one toast, "Saved Ledger.xls", with what the
format left behind of this workbook under it; a refusal is one toast in
the host's own words.

**A deck that is read only here** (an imported `.ppt`, `.pps`, `.ppsx`,
`.odp` or `.key`, or a Google deck). It has no format row and no mode. One
quiet line sits above the stage: 12px muted words, a 12px inset, 4px above
and below, a hairline under it, then at most one press 8px after the
words, a link button in the same 12px with its busy label (the spinner in
its own reserved place, the press off while it runs), and Present at the
line's far end (owner item 32), so the deck has one row above it, not a
bar holding only Present over the line. An import and a Google deck read
"Read only", then "Make a copy to edit". A Google deck changed in Drive
since it was read reads "Changed in Google", then "Read again"; one Drive
could not be reached for reads "Couldn't reach Google", "This is the copy
from 1:40 PM" in regular muted (the time the host read it from Drive,
owner item 33; a date before today), then "Read again". A mail's file in a Files tab
keeps the press alone: its header already says Read only. A failed press
is one toast. More keeps Make a copy to edit, and for Google Read again
from Google and Open in Google; Save to Google Slides is there for a deck
of his own, opening the dialog with the same account field as Open from
Google. A Keynote that cannot be read is the canvas's failed line alone,
"Export this from Keynote as PowerPoint", with no Retry. A deck whose file
is not where it was offers "Show in Files" in Retry's place: the folder it
was in, as a page tab of Files.

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
  the other display unless he picks. Last, after a rule, "In PowerPoint"
  where desktop PowerPoint is on the computer the deck's file is on (absent
  elsewhere, never greyed): its second line, 12px `muted-foreground`, says
  how many effects our show plays otherwise or leaves out ("3 effects play
  only in PowerPoint"), and is absent when there are none. It is absent while the host has no
  picture of the file. Where the format row is drawn (he can edit the
  deck by hand), Present leaves the bar and is the row's way out: the
  row's quiet glyph and word, then a 20px chevron for the same menu, the
  same press.
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
  Previous, "4/12" (12px tabular, at least 44px wide), Next, a 1 by 16
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
  slide at radius 4 on `image-outline`, the edge drawn over the picture's
  layers (`--slide-edge`: the outline in light, clear in dark, which is
  held). A host's reason on either window is in his words, never a
  program's name or a method. A press on either picture is a
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
  deck…" while a read of the deck is asked again; the slide stays up. It
  says "This build could not be drawn here. The room keeps the picture
  before it." while the show is at a build whose picture could not be made,
  and "This slide could not be drawn here. The room keeps the picture before
  it." while the picture the room should see could not be painted.
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
  | Start, from the deck | ⇧⌘↩ from the start, ⌘↩ from this slide, ⌥⌘↩ presenter view, F5 from the start (⇧F5 from this slide); never while the keyboard is in a field (the notes, the typing box, a sheet's field) |

  A key held with ⌘, Ctrl or Alt is the window's own.
- **Builds, transitions and the clock.** A press that shows a build fades
  its picture in; a slide's own fade or push plays on a press on to it
  ("Motion values"). A build whose picture is not ready keeps the picture
  before it up (the matte, at a show's first step), never the slide whole.
  A slide whose file says it moves on after a time does, in both windows,
  at each of its steps, counted from when the step's picture is up; a black
  screen or the open picker holds it.
- **The clicker** (`show/Clicker.tsx`; the approved page's "The phone, as
  a clicker"): the app's own page at phone width (640px or less), while a
  show of the deck runs on another device of his, draws it over the whole
  page on `background`, clear of the screen's safe areas, in place of the
  deck. A 44px bar: End (a quiet text button) at the leading edge, the
  deck's name 17/22 semibold in the middle, Blank at the trailing edge (a
  toggle, `foreground` fill and `background` text while on). A 44px line,
  16px in: one press target holding the Pause or Play glyph, the time talked 17/22 semibold tabular (`warning`
  past his target) and "of 20:00" 15/20 muted (no target: nothing); "4/12"
  15/20 muted tabular at the end ("End" at the end of the show). The notes
  at 16/24, scrolling inside themselves ("No notes" muted). Previous: 56px
  tall, 12px in from the sides, radius 16, on `muted`, an 18px chevron and
  17/22 medium words, 8px over Next. Next is the lower part of the screen:
  42% of its height (176px at least), 12px in, at least 16px off the foot
  (more where the screen's own inset is), radius 32 (concentric with a
  phone's corner), on `card` with a hairline `border` ring inside, 20px in:
  at its top what comes, a 15/20 muted line over a 22/28 semibold one
  ("Slide 5" over the next slide's title, at most three lines; "This slide"
  over "Build 2 of 4"; "End of show" alone, muted, before the end), at its
  foot "Next" 22/28 semibold with a 20px chevron; at the end "Close the
  show" alone. The time's glyph is filled, 18px. Previous, Next and the time press to 0.96 over
  `--dur-fast` on `--ease-out` (none under reduced motion). No control
  waits on a hover; the page never scrolls. A press that fails is said in
  the clicker itself, which lies over the page's toasts: one 15/20
  `destructive` line between the notes and Previous, so Previous and Next
  never move ("This device can only watch the show." for a key that may
  only read; "The show didn't take that press. Press again." for one the
  running show did not take), gone once the show moves on. When the show ends the deck
  comes back.
- **Video and sound** play over their shapes in both windows: the room
  hears the slideshow's copy. The transport is in the presenter's view
  only, one 28px row a clip, 8px under the picture the room sees, its Play
  glyph on the picture's edge: Play or Pause and Play from the start (24px
  quiet icon buttons), the place as a 4px `Progress`, and "0:12 / 1:04" in
  12px muted tabular; while the clip is read, "Getting the video ready…" in
  its place. With no presenter's view a press on the clip's box starts and
  stops it; the slideshow has no other chrome but the bar the pointer
  calls.

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
  file with no pages, while it is drawn, or on a failure. It is the part of the
  bar that gives way: on a bar too narrow for it and the verb (a deck beside
  its chat, about 460px) it is not drawn, and the verb is never cut. The
  format's fit is measured as if the count were there.
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
  least 24px tall and 8px above it, 12/16 muted: "As drawn here" for our
  own drawing (LibreOffice on the file's host, never named), "As Word draws
  it" (or Excel, or PowerPoint) only when that app drew it,
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
  footers; a kind's own rows follow. A change draws the file again. A kind
  whose rows differ by format puts its own in their place (the deck's PDF: Layout, Paper for paper, Hidden slides; its
  .pptx: none), and a format with rows of its own that are not the page's
  (a deck's Pictures, Video) has them first, with no heading, since the bar
  names the format; a row that would change nothing is not drawn. **In
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
  tall on `stage`. Its title is one sentence with the format ("Word preview
  failed."), the reason under it as the `Empty`'s description in Work's words
  (`workErrorWords`, naming the computer), then Retry. A press here that fails
  (Export, Print, Check in Word, the page set-up, a video) toasts the act's own
  line with those words under it. The primary button stays live and
  the Page rows stay beside it; no losses are listed. A render the host no
  longer has is drawn once more with nothing said.
- **A long file** draws its first pages: the who-drew slot reads "The first
  50 pages" with a ghost extra-small "Draw all 2,084" at its end, and the
  count is of the whole ("Page 1 of 2,084").
- **The sheet's formats**, in the bar's order: Excel, PDF, Print,
  OpenDocument, Excel 97-2003, CSV, TSV, Web page. An opened Excel file's
  own format is already the file: its button reads Save a copy. CSV and TSV
  draw the first 500 rows of one sheet, with the Sheet row over them. The
  sheet's ⋯ holds one Preview… in place of its export rows; a sheet read
  from a .csv keeps Save as CSV beside it. Its Page rows wait for the
  sheet's page set-up.
- **After Export** the system's own save dialog is the answer and nothing
  more is said. When a kind saved the file somewhere itself, one toast says
  where: "Saved Budget.xlsx to Spring LAN", with Show opening that folder in
  Files, as the Files place's toasts do. A sheet's Save as CSV, Save back and
  Save as Excel say it the same way.
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

#### Save As…

A document's one way to save itself as a file somewhere (work/files/SaveAs.tsx,
DocLinks.tsx; docs/agents/work-files.md "Save As…"). A ghost extra-small
"Save As…" stands in the document's own bar, before Share (beside a thread,
and in a Files tab under its 48px header, which holds no second one); File →
Save As… (⇧⌘S), More and ⋯ open the same sheet. Beside a thread under 560px
of bar, Save As… is in More alone and Share stays in the bar.

- **The sheet** is the large modal (768px): "Save As" as its title, then a
  20px inset in two columns, 20px apart: the form, and 200px for the page.
  The form is a label column of 56px (12px muted, 12px from its field) and
  rows 12px apart: Name, a 32px field whose extension is the format's, muted
  at its end; Format, a 28px outline menu button with the format's name and
  a 12px chevron (its menu rows are the names with the extension as the
  muted end fact and a tick), and after it, 10px off, one 12px muted line of
  what that format drops, counted ("3 suggestions go as tracked changes",
  ", and 1 more" with the rest on hover), none when nothing is lost; Where,
  a 252px box at the 8px radius with the hairline and 6px inside, holding
  the Move to… walk: the trail over the folders with New Folder (ghost
  extra-small, muted) at its end, a new folder named in place as Files
  names one. It opens in the folder of the document's own file when there
  is one (a Word file in Teams opens where it lies), else in the last
  folder he saved to; the format starts as that file's own, and a .doc
  starts as Word with "A .doc is saved as .docx" first on the drops line. On the places, Recent comes first (the three folders he saved
  to last, each with its place's name muted at the row's end), then Places;
  Google Drive and LifeOS stand last, muted and off, their sentence on hover.
- **The page** is the document's first page as the host draws its file, 168px
  wide on `paper` with the image outline, centred on `stage` at the 8px
  radius with 16px inside; "Page 1 of 4" under it in 12px muted, nothing for a
  one-page file. While it is drawn, a skeleton in the paper's shape; no page
  for Markdown, its kind glyph at 32px in its place. Under 620px the column
  goes and the form takes the width.
- **The footer** is the dialog's: Just a copy (a checkbox and its 13px word)
  at the start, then one 12px muted line of what Save does, truncating
  before the buttons: "Saves Plan.docx in General, kept up to date", "Saves
  a copy of Plan.docx in General", "Pick a folder" while none is; Cancel and
  Save (primary, "Saving…" with the spinner while the host works). Enter in
  the name is Save. Save is off with no folder or no name.
- **A file of that name there** is the house confirm over the sheet:
  "Replace Plan.docx in General?", Replace and Keep Both, Keep Both holding
  the focus. Nothing is written until he answers.
- **After Save** the sheet closes. A linked file is said by the header alone:
  one quiet extra-small menu button before Save As…, the format's 14px glyph
  in its tint, then the words ("Saved to General 9:12 PM", "Saving to
  General…", "Not saved to General yet"), "+1" muted for each other link, a
  12px chevron; at most 256px, truncating. It reads `muted-foreground`, and
  `foreground` only when a link needs him (then, and only then, its words are read out, a status beside the button; a save is never announced): "Changed in
  General", "Moved or deleted in General", "Not saved to General". Its menu
  is a label row per link (its name, and with several its state too), that
  link's presses first (Keep Both, Replace for a Word file changed there;
  Save Again for another format changed or gone; Retry), then Open, Show in
  Files and Unlink, links apart by a rule. A copy made once (Just a copy) is
  one toast, "Saved a copy of Plan.docx in General", with Show.
- **Motion** is the modal's, the menus' and the toast's; a folder walk swaps
  the list at once. Nothing glows or slides in the header: its words change.

#### Work editors: The document

What the document adds to the format row above (work-kit
`src/editor/format-row.tsx`; docs/agents/work-docs.md "Styling: the format
row"). The row is the body's first, unscrolled row; the text scrolls under
it and Preview covers it.

- **A classic document keeps today's look.** One made before the row is
  drawn on the house ladder in the system's font, and its row holds only what
  such a document can keep: Undo, Redo, Style (Normal text, Heading 1 to 3,
  Quote), Bold, Italic, Underline, Align, the lists, Insert, Preview. The
  rest is absent, never greyed. The first font, size, colour, named style or
  spacing he sets makes it a styled document.
- **A styled document is drawn in its own styles**, in points: the file's,
  or for one made here the default theme "TempCode": Calibri (drawn as
  Carlito), Normal text 11 pt at 1.4 lines with 6 pt after, Title 22 pt,
  Subtitle 13 pt muted, Heading 1 16 pt, Heading 2 13 pt, Heading 3 11 pt,
  all three semibold, Quote italic and muted with an 18 pt indent, Caption
  9 pt muted. Nothing inside the text is on our type scale: it is the file's,
  as a PDF's page is. The column stays 672px in Flow.
- **Colours the file names, on a dark ground.** A colour a style or a run
  names is drawn `oklch(from C max(l, calc(1 - l * 0.4)) c h)` in dark, so a
  dark ink rises and a light one stays; in light, on paper and in every
  export it is itself. Words on a highlight take the ground's own ink in
  dark, so a file's yellow is read. A picture is never lifted.
- **The Style menu** draws each style in its own face, weight and slant at
  12 to 18px, never in its colour (a file's ink may be unreadable on a menu).
  The font list draws each family in its face; a font with no twin here
  carries one 12px muted second line, "Drawn as Carlito".
- **Line spacing** lists 1.0, 1.15, 1.5 and 2.0, then Add or Remove space
  before and after the paragraph, by what the paragraph has; a value that is
  none of the four (the default theme's 1.4) is listed in its place, checked.
- **A layer waits on the first styled change.** The first change that styles
  a classic document asks the host first; its menu or picker stays open until
  the change is made, with no spinner: the wait is a few hundred
  milliseconds. If the host refuses, nothing is written and those controls
  leave the row.
- **In a compare**, what a change did beside the words is one 12px muted
  line under its block ("Heading 1 becomes Title · 11 pt becomes 14 pt"), and
  the page's own changes are one last step, "Page formatting".

#### Work editors: Document pages

A styled document as sheets of its own paper while it is edited (work-kit
`src/editor/pages/`, `pages.css`; the pane's side is `DocumentCanvas.tsx`;
the account is docs/agents/work-docs.md "Pages"). The row's last group holds
the switch, **Flow | Pages**; a classic document has no switch and is always
Flow.

- **Which view an item opens in.** A styled document opens in Pages on a
  canvas of 640px or more and in Flow under it: beside a thread a 504px
  canvas sets 11 pt text at 8px, which can be read and not typed on. His own
  switch is kept per item and wins from then on; a later resize changes
  nothing. A document that was classic when it opened stays in Flow when he
  styles it, so the text never jumps onto sheets under his hands; the next
  time it opens, its width decides.
- **On the guest's page** the same rule reads the page's own width as it
  opens: sheets from 640px, fitted to the width under 864px and at true size
  from it. The page under the 44px line is the stage, edge to edge. An Edit
  link's row ends with the switch; Comment and View links have none and read
  what the width gave them. Under 640px a guest's document is always Flow
  and the row has no switch: a sheet fitted to a phone sets 11 pt text near
  7px. For a finger the switch's track is 44px tall.
- **The stage** is the scroller itself, edge to edge on `stage`, padded 16px
  over the first sheet and 24px at the sides and under the last (12px all
  round under 640px of stage). The column's 672px measure, its 52px gutter
  and the title over the text are not drawn: the sheets are the document.
  Comments open at their words, not in a margin. The format row stays the
  body's first, unscrolled row.
- **A sheet** is the paper at true size (US Letter 816 by 1056px, at 96 to
  the inch), 12px from the next, with no shadow: `page` under a 1px ring of
  `page-edge`. Its text is `page-ink`, its header and footer `page-ink-2`.
  The sheet wears the theme: `page` is `card` in dark and `background` in
  light, the inks are `foreground` and `muted-foreground`, `page-rule` is
  `foreground` at 24% in dark and 30% in light, and `page-dim` is
  `muted-foreground`. Preview's paper and every print stay white. A colour
  the file names is lifted on the dark sheet as in Flow ("The document"
  above); a picture never is.
- **Zoom** never re-flows: the document is laid out once at true size and
  drawn larger or smaller, so the breaks do not move as he zooms. The menu
  sits after the switch, in Pages only, and reads its value: Fit width (the
  stage less its side padding), Fit page (one whole sheet in the stage's
  height), 50%, 75%, 100%, 125%, 150%, 200%. An item opens at 100% where a
  true-size sheet fits (a canvas of 864px or more) and at Fit width where it
  does not; his own pick is kept per item. Wider than the stage, the sheets
  scroll sideways inside it and the pane does not.
- **"Page 2 of 5" in the kind's bar**: one 12px `muted-foreground` tabular
  fact at the end of the kind's tools, before History, in Pages only. It
  follows the scroll, naming the last sheet whose top is above 40% of the
  stage's height. It is said nowhere else in the pane, is absent while
  unknown, and goes whole in the bar's narrow form (under 560px).
- **The header and footer** stand on every sheet, half an inch from its top
  and bottom edge, across the text column in three places (start, middle,
  end), 9 pt at 1.3 in the document's body face. A press in one enters it:
  the body's words dim to `page-dim`, and pictures, tables and tints go to
  half; the zone takes a 1px `page-rule` hairline across the sheet, 18px from
  the text, broken 8px from the sheet's edge by its name, "Header" or "Footer", 12/16
  in `page-ink-2` on the sheet's fill, with Insert (Page number, Number of
  pages, Document title, Date) at the other end. A press in the body, or Escape, leaves.
- **Page set-up** opens from the row, from a double press on a sheet's
  margin and from the column note. It is the kit's 448px dialog, rows 12px
  apart, a label at the left and its control at the right: Paper (US Letter,
  US Legal, A4, A3, A5), Orientation (Portrait | Landscape), Margins (Normal
  | Narrow | Wide | Custom; Custom opens Top, Bottom, Left and Right in
  inches or millimetres by his locale), Columns (1 | 2 | 3), a hairline,
  then the switches Header and footer and Different first page. Cancel is
  ghost, Apply primary.
- **Columns are not drawn while editing.** A set-up of two or three says so
  once, in one 12px line, "2 columns in print and export": under the first
  sheet's top edge at the text's left in Pages (at this size whatever the
  zoom), above the text in Flow. A press on it opens Page set-up. It is
  never printed.
- **A table** that fits moves whole to the next sheet; one longer than the
  room left breaks between rows and its header row is drawn again at the
  top of the next. A list item, a picture and a code block move whole.
- **Find** keeps its place at the stage's top right, and its tints are drawn
  on the sheets.
- **Under a review**, the page's own changes ("Page formatting") stand on
  the stage over the first sheet, 16px from the top and 24px from the side,
  which is the sheet's own left edge at Fit width.
- **Print and the PDF are these sheets**, page for page, in paper colours
  whatever the theme, with no mark of the editor's own: under Preview the
  editor draws no change in review and no find tint. Preview's Page rows (Paper, Orientation, Margins,
  Headers and footers) read and write the same set-up, on a document he may
  edit; a reader has no such rows.
- **Nothing here moves.** A switch of view, a zoom and a new page count are
  drawn at once: he presses them many times a day.

#### Work search

One field over everything in Work (`work/search/Picker.tsx`; the account is
docs/agents/work-search.md). It is a picker, never a page: it opens under
his hands and leaves no trace on what he was searching from.

- **The frame** is `PickerDialog`, the Go to File shell: 560px, the field
  36px with 12px corners (the dialog's 16 less its 4px inset; its glyph
  in a row's own 16px slot, so his words stand over the titles they find)
  over a
  hairline with 4px over it as under it (the field's ring never sits on
  the line), 28px rows (a 20px line and 4px above and below) at the frame's
  4px inset, appearing at once. The hairline is drawn only over rows: with
  nothing to list the field stands alone. The dialog's own exit is the
  shell's. Nothing in the list moves or fades: it is read tens of times a
  day. The field is a combobox that names the list and the highlighted
  row (`aria-controls`, `aria-activedescendant`), so a screen reader says
  the row the arrows are on.
- **The field** takes 200 characters, what a host is asked, and leaves
  every key to an input method while he composes a word.
- **The key** is ⌘⇧K, a command of its own (`search_work`); ⌘K stays the
  app's Search. The page owns the key (the menu row only shows it), so a
  code editor keeps the chord for its own Delete Line; the row is Work's
  own and is gone from the Go menu while no host has Work on. The place to click is a ghost search mark on the rail's
  **Work** heading, before its +, with the key in its tip. No other screen
  draws a field for everything: a view's own filter stays the view's, and
  a screen that wants this one calls `openWorkSearch`.
- **The scope** is the field's own end: a quiet button reading "All jobs",
  or a job's dot and name. It opens on All jobs every time. ⌘⇧K again
  narrows to the job the window is in and again widens (the rows still in
  reach stay on screen through either, and no other); a click opens the
  menu of All jobs and each job, and ⌥↓ in the field opens it by key.
  While a source is still out a `Spinner` stands before it, in the field:
  only once the wait has lasted 150ms, and then for at least 300ms, so an
  answer in a few frames never flickers it.
- **Groups** stand in one fixed order by kind (People, Mail, Messages,
  Tasks, Agenda, Files, Documents, Projects, Threads, then the rest;
  Documents only from a host a release behind, since a LifeOS document is
  a file and stands under Files),
  never by speed or score, under the menu group label (11px medium muted,
  `px-3 pt-2 pb-1`; the first under the field `pt-1`, which with the
  rule's 4px stands it the same 8px down): the `@` list's own headings. Narrowed to one kind
  the heading is gone: the field already names the kind, and a reader is
  told on the way in and out ("Mail only", "Every kind").
- **A row** is the `@` list's own, one line: a 16px glyph of its kind, the
  title (13px, as wide as its words, the matched ones in the foreground's
  weight through `MatchText`), the fact or the matched line right after it
  (12px muted, cut first, a matched word marked as in the title; a long
  fact keeps 72px, a short one only its own width), then at
  the row's end the job and the time (12px muted, tabular, each a column
  of one width, 8px apart). The time column stands from his first word,
  whichever rows have landed, so the job column never jumps when a kind
  with times lands after one without; Recent, with nothing typed, has no
  times and gives the room to its titles.
  What has passed says how long ago ("2d"); an event says its time today
  and its day otherwise ("Jan 12"), never a year and never on two lines.
  Under 480px (only /ui in a narrow browser: the desktop window is never
  under 800) the fact goes rather than stand as a stub, and the job is its
  dot alone. A file kept in
  the cloud wears Files' cloud mark after its name.
- **The job** is the sector dot and the job's name in 12px muted, in an
  80px column so the names line up (a longer name is cut); never a chip. It is drawn only
  while the results can mix places (All jobs, with more than one job in
  reach, or one job and a thread of the Work Chats among its rows, which
  reads "Work Chats"). Scoped to one job the column is gone.
- **Four rows a kind**, then one muted row, "All mail for “budget”"
  (foreground once the highlight is on it, as any row Return will take):
  Return on it narrows the picker to that kind (thirty rows), the kind's
  name standing muted before his words in the field (and in the hint's
  place while he has typed none). Escape steps back out, onto the row he
  came in by; a second Escape closes. A kind a host can search further when
  asked alone (Files: a file's text, every place) offers its row on every
  search, under its rows or, with none, as the list's last row.
- **Return opens what he sees.** A highlighted row he has scrolled out of
  sight by the trackpad is brought back by the first Return and opened by
  the next.
- **The list holds still.** Rows on screen never change order among
  themselves: within a kind, what lands later goes under the rows already
  there, into the free places, and the rest is behind "All …". Until he
  moves the highlight it stays on the first row.
  Once he has moved it, by arrow or pointer, the highlighted row keeps its
  place on screen: what lands above it is taken up by the scroller in the
  same frame, so the row under his eye, and the one Return will take,
  never moves, and a group that fills keeps the row he is on among its
  four. A thing he chose that an answer takes off the list leaves no row
  lit: Return never opens a neighbour in its place, and the next arrow
  starts from the top. A new ask (his words, the kind, the scope) stands
  the list at its top again, with the highlight. The scroller keeps its 10px strip from the start
  (`scrollbar-gutter: stable`), so the columns do not shift when the list
  first overflows; the strip lies in the frame's own right inset (`-mr-1`),
  so a row ends 10px from the frame's edge. A cut edge fades (`OVERFLOW_FADE_Y`) while more
  lies past it, and a row the arrows bring into view stops 32px clear of
  it (`scroll-my-8`), so the highlighted row is never the dimmed one.
- **Nothing typed** shows Recent: the last eight things he opened from
  search, any job, two that would read the same shown once (held to one
  kind, the things of that kind, under Recent's own heading). No hint text and no tips.
- **Nothing found** is one muted row, "Nothing for “q”" (`PickerNote`).
  Scoped to one job it is followed by one row he can take, "Search all
  jobs", on the note's own inset. It is said only of a search that ran: at
  two characters or more, with at least one source answering. When none
  could search (every host away, or mail alone with LifeOS signed out) the
  causes below stand alone. A reader is told both once the search settles
  (a status line), since no row is there to be named. His words are echoed on one line, cut at the
  row's end.
- **What could not be searched** is one muted line a cause at the list's
  foot, in LifeOS's or the host's own words: "LifeOS is signed out on
  MacBook.", "The box is offline.", "Mail did not answer." (a source),
  "The box did not answer." (a host's first answer). One line for
  LifeOS covers every kind it feeds, and follows its host's live status:
  LifeOS lost after its rows landed adds the line, and those rows stay in
  place drawn as disabled, never lit or taken, until it is back and the
  search runs again. The lines stand under the list,
  outside its scroller, so a list that fills its box never hides them. No button: Settings → Connections has
  the fix. A source that does not exist on a host says nothing.
- **Return opens in place**: the picker closes, the window enters the
  thing's job if it is in another, and the thing opens in its own view,
  its thread or a Files tab. ⌘↩ starts a thread about it where the kind can
  be a chip. Right-click gives the same two with their keys ("Open",
  "New thread about this"), moves the highlight to the row it opened on,
  and takes ⌘↩ while it is open.

**The slide editor** (`src/renderer/src/work/slides/SlidesCanvas.tsx`,
`geometry.ts`, `Strip.tsx`, `Sorter.tsx`, `edit/`). A picked shape is outlined along its own edges, turned with
it: a 1px line, eight 8px handles (2px radius) at the corners and the
middles of the sides, and a 10px round turn handle on a 12px stem, 22px
above the top edge. One look in both themes and on any slide: the line is
`sel-line-dark-pic` and the handles are `paper` with a 1.5px edge of the
line's colour, because the selection sits on the deck, not on the app. It
is drawn at screen size whatever the slide's size, as one SVG over the
picture that takes no pointer. Nothing animates: a selection is made many
times a minute. A shape that cannot be picked shows no hover. Handles are
drawn only where they act: a shape he can move by hand (a deck he can edit,
a slide no suggestion changes, a shape with its own box on the slide) has
the eight and the turn handle; a table and a chart have no turn handle; any
other picked shape is the outline alone.

- **Moving a shape** (`edit/Manipulate.tsx`, the maths in `edit/drag.ts`).
  A press on the picked shape (or on any shape he can move, which it picks)
  and a move of 3px drags it; a handle resizes it along its own width and
  height, so a turned shape stays turned and the side or corner across from
  the handle stays put (Shift keeps its proportions, an edge handle growing
  the other way about the middle); the turn handle turns it about its
  centre (Shift: 15 degree steps). The pointer says what a press will do:
  `move` over a shape he can move, the resize cursor of a handle's own way
  turned with the shape, `grab` on the turn handle and `grabbing` while it
  turns; nothing where his hand cannot move it. The handle stays under the pointer. While
  he drags, the handles step aside: the shape's own picture, cut from the
  stage along its corners, rides at 80% opacity under a 1px outline in
  `sel-line-dark-pic`, over the picture as it was; a guide, a 1px line of
  the same colour the slide's whole height or width, is drawn exactly where
  an edge or the centre of the box the shape is drawn in meets the slide's
  edges or centre or another shape's edges or centres, and the box is
  pulled onto a line within 6 screen pixels (Alt or ⌘ held: no pull). A
  resize pulls only a square shape's moving side. The size ("7.11 × 1.29
  cm") or the angle ("35°") sits 6px off the drawn box's bottom-right
  corner, turned to its other side where the stage ends: 16px tall, 4px in,
  4px radius, `sel-line-dark-pic` with `paper-ink` 11px medium tabular
  words (5.4:1). Lengths are inches where the locale's paper is Letter and
  centimetres elsewhere (`unitFor`). On release one `geometry` edit goes,
  and the carried picture stays where he left it, the outline and handles
  on it, until the stage paints the new picture; Escape puts everything
  back and sends nothing. The arrows nudge by a pixel of the stage (Shift:
  ten), the carried picture moving at once and one edit going once the keys
  rest for 400ms. Delete and Backspace take the shape off the slide: the
  slide's own colour, read just outside its edges, lies over its place
  until the new picture lands.

- **The floating bar** (Ask) for a picked shape is anchored under the
  slide's bottom-right corner, its end there (`askAnchor`, geometry.ts;
  `CanvasSelection.align`), not beside the shape: the frame lays it above
  its anchor, so it falls just under the picture, never over a shape, a
  handle or the typing box, where his next press goes, nor over the Notes
  heading at the left under the slide. While he types it steps aside.
- **The typing box** (`edit/TypingBox.tsx`). A second press on a picked
  text shape, or a double-click on any, opens it with the caret where he
  pressed; Return on a picked shape opens it with its words selected, F2
  with the caret at their end. An empty title, subtitle or text
  placeholder he can type in shows PowerPoint's prompt ("Click to add
  title") where its words will go, in the look they will take, and one
  press on it opens the box; the prompt goes while the box is open. The
  box is the shape's own size (only a shape that grows to its words
  grows), so words that overflow lie about its anchor as the picture will
  draw them; in a shape that shrinks its words to fit, they are drawn
  smaller as he types past its bottom (to a quarter at least), as
  PowerPoint does, and never larger than they opened.
  On a table the box opens on one cell: the cell pressed, else the first
  (Return, F2, Insert). It lies on that cell's corners (the file's column
  widths and row heights), with PowerPoint's cell margins, and its words
  take the ink that reads on the cell's ground (the deck's light ink on a
  dark one, its dark ink on a light one), as the table style draws them.
  The box lies on the shape's own corners, turned with it (a shape flipped
  across reads as before, one flipped down turns half round, as PowerPoint
  draws them), with the shape's insets and anchor, each run in its font,
  size, weight, slant, underline and colour, each paragraph in its
  alignment and list, all scaled to the stage. A single line is 1.2 of its
  size. It is filled with the slide's own colour read from the drawn
  picture just inside the shape's edges, so the old words never show
  through; on a picture or a gradient that is the colour most of the edge
  has, flat. The selection keeps its outline and handles over it. The
  caret is the first run's colour; a selection is `sel-bg-paper` on a
  light slide and `sel-bg-dark-pic` on a dark one, and it stays drawn
  while the row holds the keyboard. No spinner and no word: while his
  words are on their way, and until the stage has painted the new picture
  of that slide, the box stays as it is and takes no pointer, then goes.
  The picture under it is never blanked between two revisions. A shape on
  a slide an agent's suggestion changes takes no box: the press says
  "Accept or reject the suggestion on this slide first" once.
- **The row's deck arm** (work-kit's `FormatRow`, kind `slides`, the
  first unscrolled row of the body wherever the host says he can edit the
  deck by hand; absent, never greyed, where he cannot). Undo, Redo | the
  slide's layout (148px, 132 on a canvas under 420px) | font (120px) and
  size | Bold, Italic, Underline, text colour, shape fill | align (left,
  centre, right, justify), Bulleted, Numbered, Arrange, Format | Insert,
  Theme | Slide and Sorter | Present, its way out, with the ways to present
  in its menu. The groups never swap with what is picked: the outline is
  the Format sheet's. It acts on the box's selection while the
  box is open, else on the whole of the picked text shape (written at
  once); with neither its controls rest at 50%. It shows the selection's
  look, a value where all of it agrees and nothing where it mixes; a
  toggle is on only when all of it is. A press on a toggle leaves the caret
  in the box. The colour picker's theme is the deck's; Automatic is the
  theme's dark ink on a light slide and its light ink on a dark one.
  Shape fill, Arrange and Format act on the picked shape (fill rests on a
  table, a chart or media, set in PowerPoint), "No fill" first; a theme
  colour goes as the theme's own slot.
- **The layout** is a quiet select in the Style place. Its popover (12px
  in) holds the layouts this slide can take, three across: each the
  layout's picture at 96px in the strip's 3px frame (`DeckView.layoutsPic`,
  one page a layout), its name 12/16 muted under it, balanced on two
  lines; the current one on `muted` with its name in foreground; 12px down
  and 8px across between them. A layout whose places do not hold the
  slide's is absent. With no picture of the layouts it is the style menu's
  list of names.
- **Insert** is the word and its chevron: New slide (after the one on the
  stage, in its layout, or the next one after a title slide), a rule, Text
  box, Shape (a submenu of eight outlines, each drawn as its row's glyph),
  Picture…, Table (a submenu: a grid of 16px cells eight across and six
  down, the size under it in 12px tabular), Video…. Each lands in the
  slide's middle at a size of its own and is picked; a text box opens for
  typing with its word "Text" selected, a table with the caret in its first
  cell. Chart is not offered until a chart's data can be changed here. A picture or a video is read in the window for its
  proportions and fitted to three fifths of the slide; while it travels to
  the host its place is outlined with a 20px pill in the middle, a 12px
  spinner and "Adding"; a file that goes in more than one piece (over
  4 MB) counts what the host holds, "Adding 40.0 of 210.0 MB" in tabular
  figures.
- **Theme** is the word and its chevron: a 288px popover, 6px in, a row per
  theme (8px in, 8px radius): its ten colours as one 16px strip at 4px
  radius on `image-outline`, its name 13/20, its two fonts 12/16 muted; the
  deck's own on `muted`. A deck that wears none of them (a school's or a
  company's template) has its own first, by the name its file gives it
  (else "This deck's theme"), on `muted`. A press on another theme writes
  it and closes; a press on the one the deck wears closes and writes
  nothing. "Edit master
  slides…" waits for the PowerPoint switch and is not drawn.
- **The Format sheet** (`edit/FormatSheet.tsx`), from Format in the row:
  280px at the stage's end on `background` with a hairline on its leading
  edge, on a canvas 720px wide or more; under that it lies under the slide
  in the notes' place (the notes go while it is open, the slide fitted to
  42% of the height). Its head: two tabs, Format and Animate, as the
  segmented control at 28px with 12px labels and the gliding pill, and a
  28px close at its end; the sheet opens on the tab he left. Format's first
  line is the shape's name 13/20 medium. Sections 20px apart, 8px inside,
  labels 12px medium muted:
  Position and size (X, Y, W, H in a two-column grid of 28px fields, the
  letter 12px muted inside, values in his units, tabular; Rotation, a 96px
  field), Outline (its colour picker, "No outline" first; Weight and Dash
  as 112px quiet selects, each row drawing its line), and for a table, a
  row and a column by their place with Insert above, Insert below (left,
  right) and Delete; the row or column it names is filled on the stage
  (`sel-bg` of the picture's tone, its 1px line) while the pointer or the
  focus is on it, and each row of its menu as he goes down them. A field writes when he leaves it or presses Return,
  only if its words changed; Escape puts it back. With nothing picked:
  "Pick a shape on the slide"; with a shape picked on a slide a suggestion
  changes, the hand's refusal in its place ("Accept or reject the
  suggestion on this slide first"). Its body enters on opacity and an 8px slide,
  `--dur-base` `--ease-out`, each tab's body on its own. Shadow and crop
  have no edit yet and are not drawn.
- **The Animate tab** (`edit/Animate.tsx`) is the slide's, so it needs no
  shape picked. Transition: Effect (None, Fade, Push) as a 112px quiet
  select; for a push, Direction (From bottom, From left, From right, From
  top, PowerPoint's words and order); On click and After as 16px checkboxes
  with their words 8px after, After's seconds a 112px field under the selects' edge ("5 s") only
  while it is ticked. A kind the app does not play is the select's face by
  its own name ("Random bar") with one 12px muted line under it, "Plays in
  PowerPoint; a cut here", its two checkboxes held. Builds: the shapes that
  appear on a press, one 28px row each: its place 12px muted tabular in a
  16px slot (the grip there under the pointer or the keyboard), the label
  the stage reads to a screen reader 13/20, truncating, "Fade" 12/16 muted
  after it on a shape that fades in (one that appears says nothing), and a
  24px remove at the end by the hover reveal; a drag shows the 2px `accent` line where
  it will land, and the row carries the `muted` fill. ⌥↑ and ⌥↓ move the
  focused row, ↑↓ walk the rows, Delete takes one out. A row under the
  pointer or focused outlines its shape on the stage (1px `sel-line-dark-pic`,
  no handles, at once), so two "Picture" rows can be told apart; the pick
  is unchanged. Under them "Appear
  on click", a ghost xs button with its plus, opening a 224px menu of the
  slide's shapes not in a group and not yet listed. A slide whose builds
  are more than that shows no list: "Edit in PowerPoint" 13/20, why under
  it in 12px muted, and, where it can, "Remove animations…" as a ghost xs
  button, which asks in a confirm what goes before anything does. On a
  slide a suggestion changes the tab is the proposed values as words,
  under the refusal line 12px muted, and the values the change names on
  the added tint, as the stage's words are.
- **Slides by hand.** Where no suggestion waits, a slide in the strip or
  the Sorter opens its menu on a right-click or the menu key: New slide
  after (a layout), Duplicate, Hide or Show slide, Layout (those that map),
  Add section here or Rename section… and Remove section, Delete slide.
  Adding or renaming a section asks its name in a small dialog. A slide
  drags to a new place (`useSortable` in the strip, a 2px `accent` line
  where it will land); Delete and Backspace take the focused one out. A
  hidden slide's picture is at 45%. While a suggestion waits the strip is
  the proposed order, and none of this is offered: a right-click or Delete
  on a slide says "Accept or reject the suggestions first" once, as a toast.
- **The Sorter** is the deck's grid: 16px in, four across (two under
  640px), 12px across and 16px down between them, each slide in the
  strip's 3px frame with its number and title 12/16 under it (the title in
  foreground). A section is a heading 13/20 medium with its count 8px after
  it in regular muted tabular, 24px above it and 16px under. A press goes
  back to that slide on the stage; the arrows move four ways. A drag shows
  a 2px `accent` bar in the 12px gap where it will land and carries the
  slide at 80% with a 1.5px `accent` outline and `shadow-overlay`; its own
  place is a 1px dashed `border-strong` frame. The drop lands at once.
- **History** is a quiet button at the end of the deck's bar (its glyph
  and word; under 560px of bar the glyph, with its tip), only where he can
  edit the deck by hand. It opens a 280px popover: the kept copies newest
  first, each a 36px row with its time in the app's words (`dayTime`), the
  first one kept with a 12px muted line, "Before TempCode changed it"; the
  whole row is the press, with the row's press fill. Three bones while the
  list comes; "No versions yet" with none; the host's reason with Retry
  when it cannot be read. A press on a row closes it and opens that copy to
  look at, never restoring blind: the md dialog titled by its time (the
  first's line under it), its slides one under another at the body's
  width, each at radius 6 on `image-outline`, in a body of at most 560px
  (60% of the window) that scrolls, two 16:9 bones while the host draws the
  copy, the host's reason with Retry when it cannot; the footer Cancel and
  Restore ("Restoring" while it runs), Restore off until the slides are
  there. A restore closes it; the copy from just before is the newest next
  time.
- **Find** (`DeckFind.tsx`, `find.ts`), from Edit → Find… or ⌘F
  anywhere in the deck, one he can only read too: the document's bar, with
  its measures and words (a 32px line of 24px parts on `popover` with
  `shadow-overlay`, its corners 10px over the buttons' 6, "Find", the count
  "3 of 17" or "No results", Match case, Whole word, a hairline, Previous
  match, Next match, Close find), floating 8px under the stage's top at its
  end (the Format sheet's edge, where it stands beside), so nothing moves
  when it opens. It finds as he types, slide by slide in the strip's
  order, each slide's shapes back to front (a table cell by cell) and then
  its notes. A step puts the slide on the stage and outlines the shape
  (1px `sel-line-dark-pic`, no handles, as a build row's mark); a match in
  the notes brings them into view. Escape gives the keyboard to what he
  found: the shape picked, or the notes' words chosen in their field. It
  reads and changes nothing: no Replace. No motion: a key opens it.
- **Keys**, while the keyboard is in the deck (its body is marked
  `data-editor-keys="slides"`, `read` where he cannot edit it):

  | Act | Keys |
  | --- | --- |
  | Type into a picked text shape | a second press, Return (words selected), F2 (caret at the end) |
  | Commit the box, his words kept (a refused send keeps them in the box for Retry) | Escape or ⌘↩ in the box, a press outside it and the row, Tab out of it, closing the tab |
  | Up to the row with the box open, and back | Shift-Tab in the box; Escape on the row |
  | New paragraph, line break | Return, Shift-Return |
  | A list item in and out | Tab and Shift-Tab at its start |
  | Bold, Italic, Underline, size up and down, Bulleted, Numbered | ⌘B, ⌘I, ⌘U, ⇧⌘. and ⇧⌘,, ⇧⌘8, ⇧⌘7: on the box's selection (a caret in a word takes the word), else the picked shape |
  | Undo, Redo | ⌘Z, ⇧⌘Z (Ctrl+Y off the Mac): the box's own while it is open, else his edits to the file |
  | The next shape, the one before (back to front) | Tab, ⇧Tab |
  | Nudge the picked shape | the arrows: a pixel of the stage; ⇧ and an arrow: ten |
  | Take it off the slide | Delete, Backspace |
  | While dragging: keep proportions, steps of 15 degrees; no pull to the guides; put it back | ⇧; ⌥ or ⌘; Escape |
  | A slide's menu, in the strip or the Sorter | the menu key, ⇧F10, a right-click |
  | Take the focused slide out | Delete, Backspace, in the strip or the Sorter |
  | Find the deck's words; the next and the one before; close, keeping what he found | ⌘F; Return and ⇧Return in its field; Escape |
  | Duplicate the picked shape (12pt down and right; again after a move, as far again) | ⌘D |
  | Copy the picked shape (its words to other apps); paste it on the slide on the stage, from this deck or another | ⌘C; ⌘V |
  | A picture on the clipboard onto the slide, in its middle; a picture or a video from the desktop, where it is let go | ⌘V; a drop on the slide |
  | A new slide after the one on the stage, in its layout (after a title slide, the next), on the stage | ⌘M (Ctrl+M off the Mac) |

  A paste into the box is plain text, each line a paragraph. A picture
  pasted or dropped goes in as Insert's does, its place outlined with
  "Adding" while it travels, then picked; the stage draws no mark while a
  drag passes over it, the pointer's copy cue alone. A shape pasted
  from another deck has its place outlined with "Adding" while its slide
  travels, as a picture's does.

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
Three glyphs carry colour: `StatusMark`'s, for a state, the type glyph
(`TypeGlyph`), in its type's tint ("Type tints"), and a file's kind glyph
(`KindGlyph`), in its kind's tint ("File kind tints"), in the Files place's
rows, tiles and file headers and on a template's tile only; every canvas tab row draws it muted, so no
thread's canvas changes. Every other glyph is
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

A LifeOS session that is down is said once on a screen, in the session's
words with the computer named (`sessionWords`), and never again by a line
of the body under it. Its one press is `downPress`'s (work/shell/lifeosDown.ts):
Retry only where LifeOS or the host did not answer, and that Retry asks the
host again (`reopenLifeos`), never a remount that reads the same session;
Sign in where it is signed out or refused, and Show the code where a sign-in
waits for his approval, each only where this window may sign that host in
(`work.lifeos.pairStart`), and each opening the sign-in dialog in place
(`useDownAction`, work/shell/DownSignIn.tsx), never a page where he presses
again; Open Settings (Settings, Work, where the switch is) for Work off only
where this window may turn Work on for that host (`work.set`); where it may
not, no press and who can, by the act ("Sign in from a computer that manages
the box", `signInElsewhere`; "Changed from…", `managedElsewhere`, for the
switch); none for a computer the host keeps LifeOS from. Every state names
the computer: "Not signed in to LifeOS on the box", "The LifeOS sign-in on
the box waits for your approval", "LifeOS did not answer the box", and "The
box did not answer" for its own silence, the session's ask as well as the
status ask. `useDownPress` decides it, `downAction` names it, one name a press on every reader, a button with no ellipsis ("Sign in", "Show the code"), a menu row with the menu's ("Sign in…"); every reader
takes it from there, the view frame's title, Connections' rows that need him,
Waiting on's days and the rail's + menu too, and Connections' LifeOS rows,
worded by the window from the state the host names, each naming its
computer once (in its line, else in its title) and LifeOS answers with Retry
for that host alone, as the sign-in row of a host that says LifeOS is unreachable has beside its Sign out; while that
host does not answer its own check, the Hosts row says so with the one Retry, and its old LifeOS silence is not
drawn. On Today a job's session on another host that is down
is one line for the page a host and state, naming what every section left
out ("Refereeing's meetings, tasks and mail left out"), its Retry asking
that host alone; a section that held nothing else is left out. Review names
each host that left LifeOS out the same way, once, and says what the page does
without it once, after the last line. Every line is the host's live status's,
never a reason an older read saved (`useLiveDown`, work/shell/lifeosLive.ts):
a status that changes changes the line and its press at once, and connected
reads again: while that read is out the reader draws its own loading state
(bones, a spinner) in the line's place, never the saved cause. A session on its way is a wait with no press, one wording
everywhere: "LifeOS is still connecting on the box" (`connectingWords`). Once
the host has said so (`useHostLive`'s `waits`), the wait is said once where a
down state's line would stand (the view frame's body, a canvas body, the
first chat card, Today's LifeOS line, a held mail's note, a held calendar or
chat reply's reads, a settings section, a project sheet's fields, an open Start
places form), muted, with none of the
controls the host would refuse (a clash's ways out, a recording's Accept, an
open form's submit, which keeps his text); a status not heard yet keeps
its bones (the + menu's a muted bone row). On Today a job read through
another computer that says it is connecting is one such line for the page,
that computer named, with what it left out. A way back from a page inside a
view (Back to Agenda, Back to People, Back to Projects) needs no session and
stays through every state; the page's own controls are held. A Retry spins on
the button pressed alone, never on another
press that asks the same host, nor for a check the page ran by itself, and
the line it was pressed on stays, spinning, until the answer replaces it: a
new cause, or what was read. Bones are for a read the reader asks by itself
(another item, LifeOS back), never for his press (`useAgainKept`,
work/shell/againKept.ts, for a read that mounts afresh). Retry on "<host> is
not connected" waits for the link to try (`retryLink`). A held mail's Retry
asks the host's LifeOS status first, then the mail. A read that failed is never said
as a sign-out (Capture names this computer with Retry). A part that stands in
for what it could not read (a held act's details, a chat card, Running
late's place in a clash, the Start places dialog) draws
`DownLine`. While the session is down, no press whose dialog needs it is
offered (a view's New task, New event, Add people, a clash's Running late),
and a press made while it was on its way is dropped, never opened later by
itself. A form he has open over a view (New task, New event, Add people, a
project's settings) is the frame's, not the body's (`WorkViewModule.Kept`;
a mail chat card's Add… form is its keeper's, above the card's gate, and in
Mail's dock Mail's frame's, above the view's):
a session that drops keeps it and what he typed, says `DownLine` in it and
holds its submit until the session is back. A failed Retry
is said once, by the line, with the newest cause: a Retry the host does not
answer says "The box did not answer" in the place of LifeOS's silence, until
the host's next answer. When the session comes back every reader reads again
and drops its line with no press: a fresh answer or push that says connected
asks again for a session that is down, and Waiting on and Connections read
again; a status that goes down while Waiting on is open takes its days' row down at once, its switch kept. The sign-in dialog's code ask that fails says so in the code's place
with Retry, which asks the same computer again, and a code past its life gives
its timer's place to New code, which does the same; each keeps its row,
spinning, until the new code or cause lands; bones are for the first ask. A long computer name wraps; the red word is
never cut (`StatusMark`'s `wrap`).

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
| A step landing in it (`.step-land`) | fade + rise 4px, `--dur-base` `--ease-out`; only a step that lands while the fold is open, never at mount, on a hand open or when a panel unhides; steps that land in one commit wait their place in the batch, `--stagger-step` (30ms, `STAGGER`) apart, the fourth and later at three steps | none | the fade; no rise |
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
| Shimmer (`WorkingText`) | a masked band and a bright copy of the words (the band's `::before`) cross them in opposite directions, transform only, every 3s (`SHIMMER`); not mounted in a hidden pane or document | — | the same |
| Working mark (`WorkingMark`, the working line's glyph) | three 3px dots gather into one and part every 1.6s, transform only (`MARK`); enters and leaves as an icon swap does | — | the same; it enters and leaves by a fade |
| The working line settling (only once every row of the turn has finished revealing: the mark stays till then) | the mark leaves as an icon does, the words morph into "Worked for 2m 4s" (or Stopped; "Worked" while the time is still to land, which then fills in) and slide from the glyph slot to the prose edge, 22px, `--dur-base` `--ease-swap`; the hover actions mount | — | the morph's fades; no slide |
| Spinner | the one arc turning, on the document timeline from 0 (every spinner in phase; a remount picks the turn up) | — | the same: it turns |
| Lightbox | opens from the thumbnail that asked for it (its transform origin is the thumbnail's centre) and settles back toward it as the dialog does | — | fade only |
| Appshot | fade + scale 0.95→1 centred, `--dur-slow`; holds; glides into its chip, `--dur-drawer` `--ease-drawer` | — | fade in and out in place, `--dur-fast` |
| Released drag (every sash let go past its bound, the reorder drop, an Escape glide-back) | settles on `SPRING_GLIDE` from where it is drawn, carrying the pointer's speed at release | — | at once |
| A theme change (a move between a code place and a Work one whose themes differ, a choice in Settings, the system turning over; `changeScheme`, lib/placeScheme.ts) | the place changes at once; the window's picture dissolves into the new theme, opacity only, `--dur-fast` `--ease-out` (a view transition round the class change), with every element's own transition off while it runs (`html.theme-switching`); it takes no input; a second change skips the first | — | the class at once, no dissolve; the same in a hidden window and where the window has no view transitions |
| Scrollbar | shows at once on hover or scroll | hides at once, `SCROLL_IDLE_MS` (900ms) after the last scroll or when the pointer leaves | same |
| A row leaving Today by his own act (work/today/TodayRow.tsx; "Today" above) | — | the row fades where it stands, inert, `--dur-fast` `--ease-out`; then its place closes as the rows under it glide up by its height, `--dur-base` `--ease-out` (`glideHeight`); a row the world took just goes | the fade; the list steps |
| A row arriving on Today while he looks | `.step-land` (fade and rise 4px, `--dur-base`); never the rows a list opened with, nor those his unfold shows | — | the fade; no rise |
| List rows (rail, tabs, fleet, attachments, the transcript's message list, the composer's queue, dragged by its grip; every reorder is `hooks/useSortable`) | none; a row being reordered follows the pointer on the list's axis from where it was grabbed while the others hold still with the insertion line, then glides into its slot (or back to its own, on Escape or a drop that changes nothing) on `SPRING_GLIDE` | none | the line alone; the drop at once |
| The transcript's message list folding sideways to its chevron (its chevron, View → Hide Message List, ⌘⇧M) | the rows slide in from past the pane's left edge and fade in, `--dur-base` `--ease-out`; between 864px and 1264px the column (and the footer) glides back beside them from centred on a transform, same duration and curve, after one layout change | they slide out past the edge and fade, `--dur-fast`, then leave the tab order; the column glides to centred with them | fade only, `--dur-fast`; the column snaps |
| A queued message arriving above the composer (chrome/MessageQueue.tsx) | fade + rise 4px, `--dur-base` `--ease-out`, on a full `transform` string so the compositor runs it (motion's `y` is main-thread) | fade, `--dur-fast` | fade, `--dur-fast` |
| Transcript rows | one `--dur-fast` fade on first appearance, never replayed: a row on screen never changes its key (the echo of the person's message keeps the optimistic row's, `Block.rowKey`) | — | the same fade |
| A question card arriving (once per question: a remount of its row replays nothing) | fade + rise 4px, `--dur-base` `--ease-out` (`@starting-style`, `QUESTION_ENTER`) | — | fade, `--dur-fast` |
| Next and Back between a card's questions | the arriving question fades in over `--dur-base` `--ease-out` while the leaving one fades out over `--dur-fast` `--ease-exit`, in place; the card's height glides to the new question's over `--dur-base` `--ease-out` (the card is the last row, below the reader's anchor, so nothing above it moves); Back slides 8px in at the actions' start | the same | the fades; the height snaps |
| A question answered | at the click, the card folds closed on `.collapsible-auto` while its one-line answers open in its place on the same fold; a refused answer opens the card again | — | opacity, `--dur-fast` |
| The working line held (a card waits, the turn is paused) | folds closed on `.collapsible-auto` with its words kept; a resume reopens the same element | the same fold | opacity, `--dur-fast` |
| The Watching line, the fleet detail's live state | each in a kept fold under the turn: opens and closes on `.collapsible-auto`, mounted once it first opens, never unmounted while on screen | the same fold | opacity, `--dur-fast` |
| A status glyph changing state (`StatusMark`) | in the box that stays: the new glyph grows from 0.25 on the layout spring (`glyph-in`) while the old shrinks out over `--dur-fast` (`glyph-out`); never at mount | — | both fade, `--dur-fast` |
| The thought on the working line (`ReasoningColumn`, components/ui/reasoning-steps.tsx) | one phase for the whole block: "Thinking" shimmers once, the block's seconds tick 4px after it on the shared second hand (the figure alone re-renders, nothing morphs); each finished sentence fades in once in the column under the line on `.stream-step` (`--dur-reveal`, opacity alone) and stays put; the column grows to its newest line on `useHeightGlide` (`--dur-base` `--ease-out`), scrolls past 192px (smooth, following the newest line unless the person scrolled up; 32px of mask at a cut edge) and folds away on `.collapsible-auto` when the thought ends | the fold | the fades and the fold's opacity; the scroll snaps |
| Streaming text | the prose: the jitter buffer (surfaces/smoothText) steps whole words every 100ms (`REVEAL.stepMs`) a lead behind the live end (100ms here, 250ms for another host's thread, grown by an underrun, never slower than the stream, every character within 1.5s), draining at the stream's end instead of snapping and revealing a row born live from its first word, holding a bare block marker, a table's header row and a table row with only its pipes until they have content; each step is one span fading in over `--dur-reveal` on `--ease-reveal` (lib/streamReveal.ts, `.stream-step`), and the settle waits for the last fade. Code is not prose: inside an open fence a line shows once its newline arrives (a line held `REVEAL.lineHoldMs`, 600ms, steps by words) and fades in as one element. A list item, a table row, a heading, a quote's line or a fence born mid-stream rises 4px over `--dur-base` `--ease-out` as it fades (`.stream-rise`), a paragraph never; a table's card fades in with its header row. A thought's sentences are no stream: each lands whole in the reasoning column under the working line | — | the same word and line fades; no rise (a block born mid-stream fades alone) |
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
| A step landing at the top of the Computer section while it follows; a batch settling into its steps | `.step-land` (fade and rise 4px, `--dur-base`), `--stagger-step` apart; never at mount, for the first read's rows, for a page of earlier steps, while a row is pinned or on a key; the class is the landing commit's own, gone at the next landing, so a group that moves in the list never plays it again | — | the fade; no rise |
| A row chosen in the Computer section, its facts opening, the running row's words changing | none | none | none |
| A step's read text opening | `Collapsible` (`--dur-slow` open, `--dur-base` close) | the same | opacity |
| The computer cue arriving in the title bar | fade, `--dur-fast` `--ease-out` (`FADE_IN`); its words morph (`MorphText`) | at once | the fade |
| The agent's click on the live viewport (`CLICK_MARK`, a Web Animation on the ring alone, placed at the click's share of the picture) | scale 0.6→1 at full opacity over `--dur-base` `--ease-out`, holds `FOLD_HOLD_MS`, fades over `--dur-slow`; a new click restarts it | — | appears and fades, no scale |
| A slide or a build changing in a show | the new picture comes only once it is whole (the next press's is painted ahead under the one shown, so nothing dips to black); a build, either way, fades in over the one before, opacity 0→1, `--dur-slow` (240ms) `--ease-out`; any change of slide but a slide's own fade or push is a cut; a press during a motion ends it at once | — | the build's fade, the same |
| A slide's own transition in a show (a press on to it; a jump, a step back and every other transition cut) | a fade: the new slide fades in over the old, opacity, `--dur-slow` `--ease-out`; a push: the new slide comes from the side the file names as the old one leaves by the other, `translate` by the slide's own size, `--dur-drawer` `--ease-drawer`; both Web Animations on the app's tokens, read from the window, never the file's own speed | — | a push is a fade; a fade is the same |
| A slide's video in a show | none: it lies over its shape once started, the slide's own poster under it until then | at once, with its slide | the same |
| The slideshow's bar | on a real move of the pointer: opacity 0→1 and a rise of 4px, `--dur-base` `--ease-out` | 2000ms after the last move (`PRESENT_IDLE_MS`), with the pointer hidden at the same moment: opacity →0 and 4px back down, `--dur-base` `--ease-exit`; held while the pointer is on it or its picker is open | opacity alone |
| The slideshow's picker and the presenter's target menu (panels of their own window, so no portal) | the popover's: fade + scale 0.95→1 from the trigger's side, `--dur-base` `--ease-out` | at once | fade only |
| The slide editor: a shape picked, the typing box opening, going and waiting for its picture | none: a selection and the box are there at once and go at once; the old picture stays until the new one has painted | none | none |
| The slide editor: a shape dragged, resized, turned or nudged, its guides and its label | none: the carried picture follows the pointer frame by frame and stays where he left it until the new picture has painted; Escape puts it back at once | none | none |
| The slide editor's Format sheet | its body: opacity and an 8px slide from its edge, `--dur-base` `--ease-out` | at once | opacity only |
| A slide dropped in the Sorter | none: the carried slide and the bar go, the grid is in its new order | — | the same |
| The Mac's computer-use banner ("The Mac's computer-use banner" below) | opacity, `--dur-base` `--ease-out` | opacity, `--dur-fast` `--ease-exit`, then the window hides | `--dur-fast` |

Rules: animate `transform` and `opacity` (and height only through the
collapsible, the question card's frame between its questions, the slash menu's frame, or `useHeightGlide` for a box whose content grows while it is read); every animation is interruptible and starts from the current
value; nothing animates on a keystroke but the menu it opens; nothing overshoots without a
gesture; every animated class carries its reduced-motion guard (`motion-reduce:`,
or a rule under `:where([data-motion="reduced"])`; "Reduced motion" above).

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
under a hairline: the job as a `ChoiceToggle` named "Job" (Unsorted first,
then the six), and at the end Start thread (secondary, its key cap in
muted ink: the one key not plain) and File (primary): a capture on
its way shows nothing, since the window is already gone and the next draft
starts empty. While the host says LifeOS cannot take a capture, the line
says why in the rule's words, this computer named ("Not signed in to LifeOS
on this Mac", "The LifeOS sign-in on this Mac waits for your approval",
"LifeOS refused this Mac's sign-in", "Work is off on this Mac", "LifeOS is
still connecting on this Mac"), muted with no press, and both buttons are off; "LifeOS
did not answer this Mac" is red with Retry. A host that names no state keeps
"Not signed in to LifeOS". A state
ask the host did not answer is not a sign-out: "This Mac did not answer" in
the red line's place with Retry (the window's own refresh), the draft kept
and both buttons held, Return asking again and filing nothing. Retry spins
while its read is out, the line kept until the answer replaces it. A drag of
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
one class chain. A Work thread's and Work draft's row is Work's own, in the same
place and size ("A Work draft").

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
block, a table, a question, failure, held-review or request card, the composer), the
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
A thread's request for his press (its `outbox_request` call) stands in
the call's place as the question's frame (a hairline on `card`, 12px
corners, 16px inset): the Outbox glyph, muted, never amber (held is not
Needs you), the request's one name at 14px medium (the same words on its
Outbox row, on Today and after Away: "Send 3 mails to 3 people and discard 1
mail"; the press counts what is ticked), "You asked: "…"" muted under
it on the head's text column, the summary list (36px rows parted by
hairlines: tick, kind glyph, act, what it is about, a side word, a chevron
that opens the item in place), then Not now and the press (Send N, Discard
N, Approve N when the actions mix; "Send 2 of 3" when fewer are ticked than
were asked) at its foot, right-aligned. A row that
dies leads with "Discard", its act muted. A row rewritten since the thread
asked shows an empty tick he cannot take, "Changed since asked", and its
chevron reads "Review the change"; the tick is his once he opens it. Pressed, each row shows
its result where its tick was; then the head sums them, with the rows he
left out ("Queued 1 in LifeOS, 1 not sent, 1 left out") and the foot says "by you at 9:41 AM" with, for what did not go,
Send again (a Send), Pick a new time… (a Later, its new time said before it
goes), or Open in the Outbox (an item that moved since or may have gone). A
tick holds only while its row keeps the receipt it was given for. A held
interrupt toast (a request, a held act) takes the Outbox's muted glyph, never
the warning. Not now, a request that ran out and a refused ask are one muted
line where the card was (the Outbox glyph, "Not now", "No longer open",
"Not asked" with the first sentence of why). A held line ("Held Send to
…") opens the Outbox on its own item.
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
comma run after it ("Release passed on master, release-277"); a phrase stays whole in the run, so a lead that needs its preposition keeps it ("Gate failed on") and a label ends in ":" ("Answered Approach: Fast, Small"); only a held review, a failure and a
thread's request for his press are cards. A compaction is one line that counts from its start, takes
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
