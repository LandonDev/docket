# Appearance: two themes, one per kind of place

docs/DESIGN.md is the standard ("Colour", "The light theme", "Appearance by
place"). This file says where each part lives and how to change it.

## The two settings

Settings → Appearance holds a theme for each kind of place: **Code** and
**Work**, each System, Light or Dark, and the editor's type size. Nothing
else: no accent, no contrast, no code theme, no density.

- Stored per device in localStorage: `monocode.colorScheme` (Code) and
  `monocode.colorScheme.work` (Work). `loadThemePreference(kind)` and
  `saveThemePreference(kind, value)` in `src/renderer/src/lib/appearance.ts`.
- Code is Dark for anyone who never chose. Work follows Code until it has a
  choice of its own, and the Work row shows Code's choice until then.
- With Work off on every host (`useWorkOn`, lib/workSwitch.ts) the page is
  one row, Theme, which is Code's.
- The page is `surfaces/settings/Appearance.tsx`, in the lazy Settings chunk.

## Place to theme

A window wears the theme of the place selected in its rail.
`src/renderer/src/lib/placeScheme.ts`:

- `placeKind(projectCwd, catalog)`: `work` for Work Chats (`~work`) and for a
  workspace whose row has `kind: 'work'`; `code` for Chats (`~`) and any
  other workspace; null for a folder no row names while the catalog is still
  loading, and the window then keeps the theme it wears. The catalog counts
  as loaded from its first host's answer, so a Work workspace on a host that
  has not answered and left no row in the launch mirror is judged code until
  its row arrives.
- `watchPlace()` follows the project store and the workspace catalog. Either
  can be the late one. The stores call back before React commits, so a place
  and its theme land in one frame.
- Settings, the Inbox, the Outbox, Search, Notes, Accounts and Stats open
  over a place and move no place, so they change nothing.
- `changeScheme(next)` is the one function that sets `html.theme-light`. A
  choice in Settings, a choice made in another window (the `storage` event)
  and the system turning over all go through `applyPlaceScheme()` to it.
- `useColorScheme()` reads the class, for a thing that must be told in JS (an
  editor's theme, a frame's document). A colour is never picked with it.

## The dissolve

Where the theme differs, `changeScheme` runs the class change inside
`document.startViewTransition`: the window's picture cross-fades into the new
theme, opacity only, over `--dur-fast` on `--ease-out`. `html.theme-switching`
is on for as long as it runs: it turns every element's own transition off (a
colour animating alone smears) and scopes the view-transition rules in
index.css, so no other view transition takes this timing. The dissolve is a
picture over the page and takes no input.

The class is set at once, with no dissolve: under reduced motion, in a hidden
window, where the window has no view transitions, at launch, and if the page
refuses the transition. A second change during a dissolve skips the first.
The class is right whatever the dissolve does: the dissolve is only how it
looks. If it ever reads as a flash, pass `instant` and it is gone.

## First paint

- The page tells main its theme and kind on every change:
  `window.api.win.setAppearance({ scheme, kind })`, the `appearance:scheme`
  IPC (src/preload/index.ts, src/main/windows.ts). The web `/ui` has no
  `window.api`, so nothing is sent there.
- Main sets the window's backing colour (`BACKING` in src/main/windowFrame.ts:
  light's is the `sidebar` token), and keeps `{ scheme, kind }` with the
  window's bounds in `window-state.json`.
- The next launch creates the window with that backing and caption ink, and
  puts `?place=<kind>` in its address (`withPlace`). A new window opens in
  the theme of the window it was made from. The page keeps that address in
  step as its place changes, so a reload paints the right theme first.
- `src/renderer/public/boot.js` runs before the splash paints: it reads the
  kind from the address (else `monocode.placeKind`, the last any window
  saved, for the web `/ui` and a first launch), resolves that kind's choice
  as `lib/appearance.ts` does, and sets the class. `boot.dom.test.ts` runs
  every combination of kind, choice and system against the library.
- The splash (src/renderer/index.html) draws its logo as a mask in the
  theme's ink, so it shows on white.
- `nativeTheme.themeSource` stays unset: native menus and dialogs follow the
  system.

## The contrast contract

`src/renderer/src/lib/tokenContrast.test.ts` reads both token blocks of
index.css and checks every pair by tier (text 4.5:1, quiet text 3:1, mark
3:1, edge 1.15:1, field edge 1.4:1, wash 4.5:1, code 4.5:1 with comments at
3:1), in both themes. `TOKEN_CONTRAST_PRINT=1` prints each tier's lowest
pair, the numbers DESIGN.md cites. A failure names the pair and its ratio:
move the value, never the floor. The colour arithmetic is
`lib/colourMath.ts`.

`lib/colourGuard.test.ts` refuses, anywhere in `src/renderer/src`: a `dark:`
utility, a `.theme-light` selector outside the token blocks, black or white
by name, and text set as an opacity of an ink. A value that differs by theme
is a token with a value in each block.

The code palettes are pure modules so the contract can read them:
`lib/intellijTheme.ts` (Monaco), `lib/editorPalette.ts` (CodeMirror),
`lib/terminalPalette.ts` (the sixteen ANSI colours and the contrast floor
xterm holds a program's colours to).

## Dark is held

The owner works in dark while light is built, so no commit changes how dark
looks. Three things hold it:

- **A frozen copy.** `lib/darkHeld.json` is the dark token block and the dark
  code palettes as they were before this work. `lib/darkHeld.test.ts` fails
  if a token in it moves or goes. A token may be added.
- **Tokens with a value per theme**, grouped in index.css under "Held in
  dark". Light has the new look, dark the one it had. In a JS palette
  builder the same thing is a `dark ?` arm.
- **`HELD_IN_DARK`** in tokenContrast.test.ts: each dark pair under its
  floor, at its measured ratio (`ANSI_LIFTED` for the terminal's black and
  bright black).

Every preview's dark shot was compared with the tree before the work, pixel
for pixel (`bun run ui:preview … --shot` in both trees): they match.

To make a dark change he asked for: edit the value, update
`lib/darkHeld.json` in the same commit, drop the pair's `HELD_IN_DARK` row
if it now passes, and say in the commit message that he asked. One at a
time:

| Change | Edit |
| --- | --- |
| The label on a solid accent or red fill reads (2.88:1 and 2.77:1 today) | `--accent-foreground`, `--destructive-foreground` in `:root` to `oklch(0.2 0 0)`, and `#ffffff` for both in light |
| The neutral chart's quieter bars reach 3:1 | `--chart-neutral` 44%, `--chart-neutral-rest` 38%, `--chart-neutral-stale` 55% in `:root` |
| Text is one of the three inks in dark too | each `--ink-*`, `--soft-foreground` and `--near-foreground` in `:root` to what light gives it; then the ladder can go and its users take the ink tokens directly |
| A link is the link blue, not the accent | `--link` in `:root` to `#7dd3fc`; then `--link-color` can go and `useHtmlRenderTheme.ts` read `--link` |
| A diff's context steps back by ink, not opacity | `--diff-context-dim: 1`, `--diff-context-strong: var(--muted-foreground)` in `:root` |
| The Inbox diff reads like the transcript's | `--pr-code-keyword: var(--foreground)`, `--pr-code-type: var(--muted-foreground)` in `:root` |
| A slide sits on the stage ground | `--slide-stage: var(--stage)`, `--slide-stage-inset: 16px` in `:root` |
| Mail's date picker shows the chosen day and today; its composer sheet has a shadow; work-kit's corners are rounded | move the `--calendar-*`, `--radius`, `--ring-duration` and `--sheet-shadow` values from light's block to `:root` |
| Monaco's completion list: the muted row, badge letters at 4.5:1 | drop the `dark ?` arms for the suggest widget in `surfaces/monaco/theme.ts`; copy light's `--editor-symbol-*` values to `:root`; `--editor-keyword-name` to `#cf7b36` |
| Monaco's line numbers and ghost text are `faint-foreground` | drop the `dark ?` arms for `faint` and `muted` in `surfaces/monaco/theme.ts` |
| A brand mark that vanishes on the dark menu takes the foreground; Cosmic Admin's mark gets its tile | `MARK_SURFACE.dark` in `lib/addonBrand.ts` to the dark popover's luminance (0.0138); `--mark-tile: var(--matte)` in `:root` |
| The terminal holds a program's colours to 4.5:1, and reads its ground from the pane | `MINIMUM_CONTRAST.dark` to 4.5 and drop `TERMINAL_DARK` (`lib/terminalPalette.ts`, `terminalTheme`) |
| The full editor opens dark from a dark window | send `scheme` always in `work/sheets/host.ts` |
| The splash and the Windows caption glyphs take the app's own tokens | `--boot-background`, `--boot-foreground` in index.html's `:root`; `SYMBOL.dark` and `BACKING.dark` in `src/main/windowFrame.ts` |

## Palette copies

Each copy of the palette outside index.css is held equal to it by a test.

| Copy | Test |
| --- | --- |
| `BANNER_TOKENS` (src/main/computerBannerPage.ts) | computerBannerPage.test.ts |
| `PAIR_TOKENS` (src/main/server/remote/pairPage.ts), which the add-on OAuth page shares | pairPage.test.ts |
| `src/hosted/form/form.css` | src/hosted/form/tokens.test.ts |
| `DEFAULT_TOKENS` (src/shared/htmlRender.ts) | htmlRender.test.ts |
| The splash's two colours (src/renderer/index.html), light | src/renderer/src/splash.test.ts |
| `SYMBOL.light`, `BACKING.light` (src/main/windowFrame.ts) | windowFrame.test.ts |
| `MARK_SURFACE.light` (lib/addonBrand.ts) | addonBrand.test.ts |

`.temp-code/prototypes/work-workspaces/_kit/kit.css` is a copy for
prototypes; no test holds it.

## What follows the viewer's system, not the window

- Guest and owner hosted pages: `src/hosted/public/scheme.js` sets the light
  class before the stylesheet, and `GuestApp` follows a later change.
- The published form, the pairing page, the add-on OAuth page: a media query.
- The Mac's computer-use banner: `nativeTheme`.
- The phone: its own System, Light, Dark setting.
- The full editor (ONLYOFFICE) opens light from a light window, and follows
  the browser's system otherwise: from the phone, and from a dark window
  while dark is held (docs/agents/work-sheets.md).

## The phone

Checked in light, not redesigned. One value was fixed (the light
`warningText` and `destructiveText` tints); the rest, 21 rows that come from
Apple's label roles, status words in fill colours and shared values, is
listed for the owner in [appearance-phone.md](appearance-phone.md).

## What only a real window shows

The box cannot show these; their logic is held by tests. They need a look in
`dev:prod` before a release is called good: the dissolve between a code
place and a Work one, the launch of a light window on macOS (the backing
behind the page, the splash's masked logo), the title bar's traffic lights
on the light bar, Windows' caption glyphs on the light bar, and Univer's own
popups (the cell editor, the function picker, validation) in light.
