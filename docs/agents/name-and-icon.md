# Name and icon

People read **Docket**. The OS still shows **TempCode**: the bundle, its
Screen Recording and Accessibility rows, /Applications/TempCode.app, the
Start menu and Add/Remove Programs entries. Two constants in
src/shared/appName.ts say which is which:

- `APP_NAME` ('Docket'): every window title, dialog, menu, notice, error,
  empty state, hosted page, prompt and tool description.
- `OS_APP_NAME` ('TempCode'): only text that points at a name the OS shows,
  such as "turn on Screen Recording for TempCode".

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
- **Processes.** Utility process names and the `-x TempCode` lookup in
  appshots.ts.
- **Paths and files.** Data folders (macBridge.ts, threadResourcesRemove.ts,
  the guest's folders), the Office render cache, the print and download temp
  names, the phone's inbox folder, and Word's "(before TempCode saved it)"
  backups that already sit on disk.
- **The wire.** The user-agent pattern the Office add-in route reads.
- **The OS name.** `OS_APP_NAME` itself, and the phone's Screen Recording
  line.

Also kept, because other things read them: productName, appId, bundle ids,
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
