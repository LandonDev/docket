# Launch-time code caches: boot.js, the compile cache, the app scheme

- `package.json` `main` is `out/main/boot.js` (src/main/boot.ts), a second
  main entry that in a packaged app enables Node's compile cache at
  `$TMPDIR/temp-code/compile-cache` (macOS purges it after three idle days),
  picks the code this launch runs (src/main/codeChoice.ts: the bundle's
  `out/`, or a code-only update staged under `<userData>/code/<commit>/`
  that passes every check, [code-only-updates.md](code-only-updates.md))
  and then requires that tree's `main/index.js` through the cache, which
  keys a file by its path and content, so a staged index.js gets its own
  entry. boot.ts shares no module with index.ts: the app reads what was
  picked from `globalThis.__tempcodeCode` (src/main/codeBoot.ts). The
  choice costs one small JSON read when nothing is staged, and the hash of
  the entry files (4.5 MB) when a tree is. index.ts flushes the
  cache 10 s after boot and in `before-quit`, because Electron's quit never
  reaches Node's exit-time write. `TEMP_CODE_COMPILE_CACHE` points an
  isolated copy elsewhere. The first `[boot]` line of a launch reads
  `index <ms> start=<epoch> compile-cache=on|off`; dev runs say `off`.
- The packaged renderer loads from `tempcode-app://renderer/index.html`
  (src/main/appScheme.ts), a privileged scheme with `codeCache: true`, so
  Chromium keeps a V8 code cache for the index chunk and every lazy chunk
  under `assets/`; `file://` never gets one. Both schemes register in one
  `registerSchemes()` call (assets.ts). First boot on the new origin copies
  the `file://` localStorage over once (src/main/originMigration.ts, marker
  `<userData>/localstorage-migrated`).
- The renderer's `public/boot.js` copies old preference keys to `docket.`
  and `docket:` before the splash reads the theme or the modules load.
  The packaged window, dev server and hosted `/ui` run this script on
  their own origins. Existing Docket values win. The old keys stay for
  older builds. Once `docket.preferencesMigrated` records the copy, later
  loads leave resets and consumed notices alone.
- Monaco file and review panes use `surfaces/FileHeader.tsx` for the folder
  and review stepper. A Monaco review tab opens on its first change, and
  the header's Revert change and Stage change act on the change the caret
  is in (Stage only for a review against HEAD, built on the index; editorGit
  reached through `import()`, line helpers in surfaces/monaco/diffActions.ts).
  CodeMirror mounts `surfaces/HunkBar.tsx` for Stage and Revert with shared
  buttons and tooltips. `lib/colourGuard.test.ts`
  checks literal renderer colours against the token layer and counted
  palette exceptions; the counts only shrink.
- The renderer is split (docs/bundle-split.md): the index chunk carries
  only the first paint (rail, transcript, composer, thread header; 4,891.7
  kB on 2026-11-05, once Base UI's menu and popover left it, under the
  5,136.0 kB budget)
  and every other surface is a
  lazy chunk behind
  `defineChunk` (src/renderer/src/lib/lazyChunk.tsx), listed in
  `src/renderer/src/surfaces/chunks.ts`: Settings, the Aliax pages
  (recharts), the edit row's diff body, the CodeMirror
  editor with its find keys and git helpers, the terminal (xterm), the
  non-chat thread views (board, plan, research, fleet), the HTML render
  frame, the media viewer, the lightbox, the release notes with the
  changelog parser, the action-opened dialogs (`dialogsChunk` over
  chrome/dialogs.ts, each mounted only while open, the thread menu's
  Resources, Archive, Mac bridge, Rename and Goal, its Recent and Archived lists
  (`ThreadListPopover`), the plan chip's options and the branch picker's
  switch confirm among them), the failure card's account list (`accountsChunk`),
  the transcript's message list rows under their chevron (`messageListChunk`),
  a workspace's threads beside the rail (`workspaceThreadsChunk`), the
  file and symbol pickers (`pickersChunk`, mounted while open), a
  thread's per-run options (`threadTuneChunk`: the New thread chooser's
  tune view, warmed as it opens, and the thread menu's Options… dialog,
  with components/page.tsx under them; the skeleton reads a page's frame
  from components/pageLayout.ts), the
  composer's slash and @ menu (`commandMenuChunk`, mounted from a
  composer's first `/` or `@` on), a box
  thread's waiting Mac bridge card (`macBridgeChunk`), the return from Away
  (`awayReturnChunk`: chrome/AwayReturn.tsx, mounted at boot, loaded after
  the first paint), a review's notice
  (`reviewChunk`, ReviewCard and GateCard behind a 28px skeleton line, warmed with the
  first thread's chunks) and the
  rail's virtualizer (`virtualChunk`; the rail lists its cards plainly until it
  lands, chrome/railRows.tsx). A mount
  point calls `chunk.surface(name, <SurfaceSkeleton kind=… />)`, which
  sits in a `ChunkBoundary` (a failed import or a render throw holds the
  skeleton with "Couldn't load" and Retry, which replaces the lazy and the
  chunk's promise; the rail and the other panes stay); a trigger
  spreads `chunk.intent` (hover or focus warms the chunk, so a click on a
  warm machine never shows the skeleton); the first thread on screen warms
  the diff and thread-view chunks in an idle slot (`preloadWhenIdle`).
  The skeleton is drawn in bones, and Skullet rides a chunk of its own
  (`bonesEngine`, 81 kB, asked for as components/bones.tsx loads, never in
  the entry's static closure): [loading-bones.md](loading-bones.md).
  A module in a lazy chunk must never be imported statically from the main
  chunk (the right panel's Changes section and App.tsx's editor find keys reach the
  editor chunk through `import()` and `surfaces/editorFind.ts`); the
  transcript's highlighter loads each grammar's chunk on first use
  (lib/highlightLanguages.ts). `electron-vite build` writes the chunk map to
  `out/bundle-map.json` (`bun run bundle:map` prints it); the sound engine
  (cuelume) is its own chunk, asked for at the first idle moment after launch
  (lib/sounds.ts `initSounds`), and micromark's table of character names
  rides the parse worker's file alone (lib/decodeNamed.ts); remark-gfm is
  aliased to its reading half (lib/remarkGfmRead.ts: the window never
  writes markdown, and the writer was 37 kB of the entry); and
  `scripts/check-bundle-size.ts` (`bun run check:bundle`, in `bun run
  build` and the release gate) fails when the index chunk's static closure
  passes 5 MiB + 16 KiB or holds one of the lazy modules (the Base UI primitives
  stay out of the entry: the tooltip defers its primitive (its provider, a context and a delay group, is drawn from the first paint), the menus and
  popovers ride menuChunk (a first-paint surface that draws a menu or a
  popover by its parts imports them from components/ui/lazy-menus.tsx: a cold
  trigger of the same element until the chunk lands, no content), the branch
  picker's list, the model picker's rows and the context meter's breakdown with them
  (chrome/BranchRows.tsx, ModelRows.tsx, ContextBreakdown.tsx: a popover's body is drawn only while it
  is open, by when the chunk is in), the Accounts page's bones with its own chunk (the window's fallback,
  surfaces/SurfaceSkeleton.tsx, draws its rows alone), the chrome glyphs no first-paint surface draws (a module
  each under chrome/icons/, made with a pure `wrap` call behind the same `chrome/icons` barrel, so each rides
  the chunk that draws it; chrome/icons.test.ts holds their shape), the key check's whole table (a first-paint
  control asks lib/linkMayCore.ts, a leaf with the methods Docket's controls ask about, held equal to the
  host's rule by its test; `src/shared/capabilities.ts` carries every Work schema and is in NEVER_IN_ENTRY),
  every select rides
  selectChunk: the composer's
  permission, thread type and model setting pickers and every ChoiceSelect
  (asking for the chunk as it mounts) draw a cold trigger of the same
  classes, size and width until it lands, components/lazy-select.tsx; only the dialog is in the first paint). It also fails when anything of Work is in the entry (`WORK_NEVER_IN_ENTRY`: `src/renderer/src/work/`, `src/shared/work/`, `src/shared/contract-work*`, `work-kit`; docs/agents/work.md "The first paint"), and `scripts/entryGraph.test.ts` holds both lists on the source with no build (scripts/entry-graph.ts walks the entry's static imports that survive the build and names the chain to a module that broke the rule). It also fails when a chunk renders a string tag that is no HTML, SVG or custom element: the React Compiler inlines a lowercase component alias into the JSX tag (`jsx("current")`, an empty element), which only the built bundle shows. A chunk that is pdf.js's build alone is passed over (`VENDOR_STRING_TAGS`): its SVG factory calls its own `createElement("svg:rect")`, which is no JSX; a chunk with any of our code in it is still read.
  `/ui` serves the chunks
  as immutable module scripts behind the cookie (remote/ui.ts).
- Boot order (src/main/desktopBoot.ts `bootDesktop`, run from index.ts): the
  window first, the server beside it. Ahead of any window, each ended: the
  dev guard (a dev build without TEMP_CODE_USER_DATA exits) and the
  single-instance lock, the privileged schemes, ready, every IPC handler a
  window may call (one that needs the server waits for it: `server-port`,
  the editor, the capture key, the accounts pages' `aliax:*`, the mirror's
  writes, the appshot listener; a Dock click, the Dock menu's and the
  menu's New Window wait in `windowsGate`, windowGate.ts, until the next
  two end), `migrateLocalStorage`, `registerOfficeLive`, and the launch
  mirror's read-only boot read (src/main/bootMirror.ts,
  [launch-mirror.md](launch-mirror.md)). Then `openSavedWindows` and
  `startServer` at once. A `startServer` that rejects settles everything
  waiting for the server with its error and quits with code 1 (before, a
  failed start left a process with no window). Work's code (work/load.ts `loadWork`) loads at once
  only while Work is on for this host (the boot read says); else it waits
  for the first window up (`ready-to-show`, or the window gone), its
  `workAfter`, so its compile never holds the first paint, and with Work off
  nothing of Work's mount or pillars is in main's static graph
  (scripts/mainEntryGraph.test.ts names the few helpers that are). The boot
  waits for the fixed port's listener, not for its browser endpoints'
  publish, which waits out older proofs (1.5 s, remote/restarts.ts). The
  `[boot]` marks: boot-mirror (the read's ms) and window-create before
  server-start; then db-open, store, registry, services-a to -c,
  work-loaded, work-started, listening, remote-ready, server-ready,
  server-returned, and ready-to-show beside them. On the scrubbed copy
  (Nov 26, 3 launches, load about 14.5): `tc:ready` after spawn 5.0 to 6.5 s
  before, 3.5 to 4.2 s after; server-ready 3.4 to 4.2 s before, 2.05 to
  2.75 s after; window-create about 700 ms, ready-to-show 1.6 to 2.3 s. The
  order is held by src/main/desktopBoot.test.ts; boot.ts's module set is
  untouched.
- Proof: `bun run script:e2e-launch-timing` (scripts/e2e-launch-timing.ts)
  packs an isolated copy under /private/tmp/tc-launch-timing and launches it
  four times with Chromium's startup trace on; the report shows the `index`
  mark, `tc:ready`, and the index bundle's `consumedCacheSize`. On the box,
  `bun scripts/launch-timing-linux.ts --tree <checkout>` runs a built tree
  under xvfb-run with a window and reads `tc:ready` over CDP (it pre-sets
  the migration marker: on Linux with a display the migration's hidden
  window closing is window-all-closed, and the app quits before the first
  real window opens). `--copy <dir>` boots it on a scrubbed copy of real
  data (D01): the copy passes perf:host's `confirmedCopy` first, the launch
  gets a stripped environment (scratch HOME, no remote port, a dead
  provider, an empty WINVM_DIR), the copy's paths are moved aside and put
  back, each launch also times the rail whole (`tc:rail-complete`), and only
  counts, times and the `[boot]` marks' labels are printed.
