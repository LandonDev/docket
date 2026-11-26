# Name and icon

People read **Docket**, and since the bundle's rename the OS shows it too:
electron-builder.yml's `productName: Docket` names /Applications/Docket.app,
its executable, the Dock and menu bar, the privacy rows, the Windows program
`Docket.exe`, its shortcuts and its uninstall entry, and the release files
(`Docket-1.0.N-arm64.zip`, `Docket-1.0.N-win-x64.zip`; the installer stays
`temp-code-1.0.N-setup.exe`, from the package name). Constants in
src/shared/appName.ts:

- `APP_NAME` ('Docket'): every window title, dialog, menu, notice, error,
  empty state, hosted page, prompt and tool description.
- `OS_APP_NAME` ('Docket'): text that points at a name the OS shows,
  such as "turn on Screen Recording for Docket".
- `KNOWN_APP_NAMES` (['Docket', 'TempCode']): every name the bundle has had.
  Whatever recognises the app by name or path takes both, since an install
  from before the rename can keep the old one (below).

Write "Docket", never "the Docket app". Phone strings say Docket as
literals (Swift does not share the constant).

## The guard

src/shared/appName.test.ts reads src/main, src/shared, src/preload,
src/renderer/src, src/hosted and ios. It fails on any line outside a comment
that says TempCode (in Swift, inside a string literal), unless its `HELD`
map lists that file and text with a reason. It also fails when a held entry
no longer matches anything. Tests, previews, fixtures and proof scripts are
not scanned.

These are held:

- **Other programs know them by name.** The MCP and OAuth client name
  (grantProbe.ts, oauthFlow.ts), LifeOS device and key names (session.ts,
  keys.ts), the Frame.io webhook, Windows task names in the VM, the local CA
  certificate, and `TERM_PROGRAM`.
- **Processes.** Utility process names.
- **Paths and files.** Data folders (macBridge.ts, threadResourcesRemove.ts,
  the guest's folders), the Office render cache, the print and download temp
  names, the phone's inbox folder, and Word's "(before TempCode saved it)"
  backups that already sit on disk.
- **The wire.** The user-agent pattern the Office add-in route reads.
- **The old name.** `KNOWN_APP_NAMES`.

Also kept, because other things read them: appId, bundle ids,
URL schemes, `TEMP_CODE_*`, package, module and database names, the
updater's file names, the Office add-in's Id and URLs, and work-kit's
`TEMPCODE_THEME` (its name is written into files). Changing any of these
needs a migration.

## The icon

The art is build/icon-source.png (1024 px, square, opaque). `bun run icons`
(scripts/make-icons.ts) draws every file from it in a headless Chromium, and
scripts/lib/iconFiles.ts writes the PNG, .ico and .icns containers. To make
a new icon, replace the art and run the command.

| File | Shape | Used by |
| --- | --- | --- |
| build/icon.icns | mac: an 824 rounded square on 1024, shadowed | electron-builder `mac.icon` |
| build/icon.ico (16, 24, 32, 48, 64, 128, 256) | round | electron-builder `win.icon`, the installer |
| build/icon.png (1024) | round | this repo's own icon in the rail when it is a workspace (wsicon.ts) |
| resources/icon.png (512) | round | the window icon (src/main/windows.ts) |
| src/renderer/public/favicon.png, apple-touch-icon.png | round, bleed | the app's renderer and /ui |
| src/hosted/public/favicon.png, apple-touch-icon.png | round, bleed | the hosted guest and form pages |
| src/renderer/public/mark.png (144) | mask | the boot splash (`#boot-mark` in src/renderer/index.html) |
| addins/office/icon-{32,64,80}.png.b64 | round | the Office add-in (office/addin/assets.ts, manifest.xml) |
| ios/TempCode/Sources/Assets.xcassets/AppIcon.appiconset | bleed, no alpha | the phone (`ASSETCATALOG_COMPILER_APPICON_NAME`) |

At 32 px and below the art is cropped closer so the slabs stay apart. The
splash mark has only the slabs, white on clear, with alpha taken from how far
each pixel stands off the art's ground. The splash uses it as a CSS mask
filled with `--boot-foreground`, so it follows the theme the way the old
mark did.

Office keeps an add-in's icons by URL. The manifest's icon URLs carry `?v=2`
and its Version is 1.0.1.0, so Office fetches the new art. Public routes
match on the path alone, so the query changes nothing on the server.

## The update across the rename

Proven 2026-11-25 with test builds TempCodeE2E 1.0.393 → DocketE2E 1.0.394,
one bundle id (`bun scripts/e2e-updater.ts --rename[=present|hand] [--next]`,
`--win --rename`; facts.json under each run's ROOT). `app.getName()` stays
`temp-code` and userData does not move on either OS.

- **Mac.** ShipIt moves TempCode.app to Docket.app and installs the new
  build; one app is left in the folder. It does not open it again: it starts
  its relaunch helper from the old bundle's path, which it has just moved
  ("posix_spawn: No such file or directory" in ShipIt_stderr.log). Opened by
  hand, Docket.app runs `Contents/MacOS/Docket`, and the next update
  (Docket → Docket) relaunches by itself. The one hand step: open Docket
  after that first restart. If a Docket.app already sits beside it, ShipIt
  does not rename: TempCode.app takes the Docket build (executable `Docket`)
  and the stray copy stays, so delete a stray Docket.app first. An old
  bundle renamed Docket.app by hand updates and relaunches cleanly.
- **Windows.** The installer keeps the folder the first install chose:
  `Programs\TempCode\Docket.exe`, with the Start and desktop shortcuts
  renamed Docket and pointing at it, the AUMID `dev.landon.tempcode`
  unchanged, and one uninstall entry, named Docket (the same NSIS GUID). It
  starts the app again by itself. A fresh install goes to `Programs\Docket`.
- **Both names.** Taken by `KNOWN_APP_NAMES`: computer use's own-window and
  launch refusals (policy.ts, `TEMPCODE_WINDOWS_EXES`), appshots' exclusions
  (appshots.ts `excludeSearches`). By hand in scripts: the installed-app check
  in scripts/mac/split-data-dir.sh and cutover-run.sh, the proof process guard
  (scripts/lib/computerProofProcesses.ts), the Windows rig's program lookup
  (scripts/lib/winAppNames.ts), release-publish.sh's ShipIt reference.
- **Not proven.** Whether macOS keeps the Accessibility, Screen Recording and
  Automation grants across the rename (TCC keys them on the bundle id and
  signature, so they should hold) and how System Settings then labels them;
  the real signed and notarized release in /Applications.
- **Code-only.** electron-builder.yml is part of the code base stamp, so no
  code-only update crosses the rename: it needs the signed release.
