# The Windows build: install, update, frame and keys

TempCode on Windows 11 as a desktop app: an installer that needs no admin, an updater, the
Windows frame and Ctrl keys (milestone 12 of the Work plan). The host core under it (shells,
process trees, links, the path fence) is milestone 13's, and a Windows host linked to the box is
milestone 41's. Every Windows branch sits behind a platform check, and the Mac's build, release
and updater are as they were. What runs today: the install, the window with its frame, the keys
and the update (seen in the rig, "Proof" below). What does not yet: a thread. Terminals need a
Windows shell, and Claude's and Muse's config dirs are still made of symlinks, which a standard
user may not make (`skills/claudeRoots.ts`, `museConfigDirs.ts`); both are milestone 13's.

## Skills links at boot

The server's boot writes the skills views and scope pointers (src/main/server/skills/), which were
directory symlinks, and a standard Windows user may not make one: the first build stopped at boot
with EPERM. Milestone 13 owns those files; the master gave this milestone the smallest piece early
(src/main/server/skills/links.ts):

- On win32 the views' and pointers' directory links are junctions (`linkDir`), which need no
  privilege. A junction's target is absolute and reads back that way (with a trailing backslash),
  so `readDirLink` hands it back relative to the link's folder, as a symlink reads; every reader
  that feeds gc goes through it, so gc never takes the live generation. Windows will not rename a
  junction over another, so `swapDirLink` removes the old one and renames the new one in.
- A failed write-out never stops the boot, on any platform: `SkillMaterializer.start` and
  `SkillPointers.start` log it, and a refresh logs a scope it cannot point and goes on with the rest.
- Off win32 the links are the same symlinks, made, read and renamed by the same calls.

Left for milestone 13: the file links and per-entry links of the config dirs (`claudeRoots.ts`
`linkTo`, `museConfigDirs.ts`), generations copied instead of hard-linked if that is wanted, and
proving a junction view through a gc pass in the rig.

## The build

- **Config.** `electron-builder.yml` holds the `win` block (an `nsis` installer and a `zip`, both
  x64, the icon, the signing hook) and the `nsis` block (`oneClick: true`, `perMachine: false`).
  `build/electron-builder.win.yml` extends it with the file rules only a Windows pack needs, and
  **every Windows build passes it**: `electron-builder --win --config build/electron-builder.win.yml`.
  Never put a string under `win.files` in the main config: electron-builder folds the top-level
  `files` strings into one file set and a platform's strings become a second, wider one, whose
  union undoes every exclusion (the first Windows pack carried `src/`, `docs/` and `ios/`). Two
  configs joined by `extends` merge into one set.
- **Where it is built.** On the Mac beside the Mac's zip (`release:publish --win`), or on the box.
  electron-builder makes the NSIS installer anywhere, but it writes the uninstaller by running
  the half-built installer once: on a Mac it reads it out of the file in JavaScript instead
  (`UninstallerReader`), as LifeOS's release does, and on Linux it wants wine. The box has no
  wine, and electron-builder's own bundle (`toolsets.wine: 1.0.1`) does not start there (it
  carries no Windows DLLs of its own: `failed to load ntdll.dll`). So the box's build
  (scripts/e2e-updater-win.ts `wineStandIn`) puts a `wine` first on PATH that calls the same
  `UninstallerReader` the Mac's build uses.
- **The Claude CLI.** The Claude Agent SDK ships its CLI as one optional package per platform, and
  a package manager installs only the builder's. With `npmRebuild: false` and `asar: false` a
  Windows build made on a Mac would carry a Mach-O `claude` and no `claude.exe`. So
  `bun scripts/win-stage.ts stage` downloads `@anthropic-ai/claude-agent-sdk-win32-x64` at the
  version the installed SDK asks for, checks it against the sha512 `bun.lock` already holds, and
  unpacks it under `artifacts/win-stage/` (ignored by git); the Windows config lays it into
  `node_modules` and keeps every `*-darwin-*` and `*-linux-*` package out. `@muse-code/sdk` is
  plain JavaScript (the `muse` binary is the person's own install), so there is nothing to stage;
  the check fails the day it gains a platform package.
- **The release check.** `bun scripts/win-stage.ts check-app [dir]` judges a packed app
  (`dist/win-unpacked`): `claude.exe` there, a 64-bit Windows executable, the version the SDK
  wants; no other platform's package; node-pty's win32-x64 prebuild; no Mac helper under
  `resources/native`. `check-files <dist> <1.0.N>` judges the four release files and that
  `latest.yml` names the installer with its size and checksum. The rules are
  scripts/lib/winRelease.ts (`packedAppProblems`, `winFilesProblems`, `winReleaseFiles`).
- **Unsigned.** `build/sign-win.mjs` is the signing hook and it is empty (under `build/`, which no app carries, so the Mac bundle does not ship it). SmartScreen asks once
  on a download (More info, Run anyway). A certificate goes in the hook only if a machine refuses
  the build; LifeOS's hook (jsign with Azure Artifact Signing) is the pattern.

## The release

`bun run release:publish --win` (or `TEMP_CODE_WIN=1`) adds the Windows pass to the `sign` phase:
stage the CLI, one more electron-builder call on the Windows config, `check-app`, the feed config
in `resources/app-update.yml`, `check-files`; then the upload carries four more files and the feed
step reads `latest.yml` too. Without the flag the script does what it always did. The files:

| File | What |
|---|---|
| `temp-code-1.0.N-setup.exe` | the installer, about 300 MB |
| `temp-code-1.0.N-setup.exe.blockmap` | its block map, for differential downloads |
| `TempCode-1.0.N-win-x64.zip` | the app unpacked, for a PC that refuses the installer; a copy made this way does not update itself |
| `latest.yml` | the feed file a Windows install reads, beside the Mac's `latest-mac.yml` |

A release published without `--win` has no `latest.yml`, and a Windows install's check of it fails
quietly until the next one that has. Turn the flag on for every publish once a Windows host is in use.

## Install

One click, per user: the installer writes `%LOCALAPPDATA%\Programs\TempCode` and asks for no
admin. `build/installer.nsh` names the folder after the product (electron-builder's default for
this mode is the package name, `temp-code`); an update keeps the folder the first install chose.
Silent: `temp-code-1.0.N-setup.exe /S`. The Start menu and the desktop get a shortcut, and the
shortcut's AppUserModelId is the app id (`dev.landon.tempcode`), which the app sets too
(`APP_USER_MODEL_ID` in src/main/windowFrame.ts) so toasts and the taskbar group find it.

The data (the database, checkpoints, logs) is `%LOCALAPPDATA%\TempCode`, not Electron's default
`%APPDATA%`: a managed PC copies the roaming profile at sign-out and this folder runs to gigabytes
(`localUserData`, set in src/main/index.ts before anything reads the path). electron-updater's
downloads are `%LOCALAPPDATA%\temp-code-updater`.

**The vault stays on a key file.** aliax-core has a Keychain mode (macOS) and a key-file mode;
it has no DPAPI mode, so on Windows the vault's key is a file in the data folder, protected by
the profile's own access rules and nothing more, as on the box.

## Update

electron-updater's NSIS path: the same feed (`latest.yml`), the same check, download and
"Restart to update" as the Mac, and `quitAndInstall` runs the downloaded installer, which shows
its own progress window and starts the app again. What differs (src/main/update.ts,
updateInstall.ts):

- **No Squirrel.** ShipIt's log, its staged bundle and its launchd job are read and cleared only
  on a Mac. Off the Mac the attempt record (`update-attempt.json`) alone says an install did not
  land, and a retry drops electron-updater's `pending` download.
- **Only "Restart to update" installs.** `autoInstallOnAppQuit` is off on win32
  (`installsWhenQuitting`): the NSIS installer runs silently for minutes after the window closes,
  and an app started meanwhile would be the old one, which the installer then closes. On a Mac a
  release still installs on quit.
- **The child tree is stopped first.** The app is unpacked, the installer replaces thousands of
  plain files, and Windows will not replace one a running process holds open: a bundled
  `claude.exe` kept warm fails the update. A child does not die with its parent on Windows. So
  "Restart to update" runs the app's own shutdown ahead of the installer (`beforeInstall`: the
  mid-turn threads recorded for the next boot, the terminals, the server, the helpers), then
  `stopChildTree` reads one process table (`Get-CimInstance Win32_Process`) and ends every
  descendant that is not the app's own executable, and anything else running out of the install
  folder (`installBlockers`: a parent id counts only when the parent is older than the child,
  since Windows reuses ids). One `taskkill /F` over that exact list, never `/T`, which would walk
  the tree again past that check (`taskkillArgs`). Milestone 13's `procTree.ts` and its Job
  Objects can take this over.
- **An installer that never starts.** electron-updater quits only once it has started the
  installer; when it cannot (its `error`, a missing download) the app would be left open with its
  work already stopped. So if no quit has begun eight seconds after `quitAndInstall`, the app
  starts itself again (`relaunchIfStillHere`), and its attempt record says the update never installed.
- **The install takes minutes** in the rig (five to seven, with Defender on and an emulated disk),
  under the installer's own progress window; the new app starts when it is done.

## The frame

src/main/windowFrame.ts (`frameOptions`), used by windows.ts:

- `titleBarStyle: 'hidden'` with a title bar overlay: Windows draws its own minimise, maximise and
  close over the page's bar, so Snap Layouts, the hover states and the red close are the system's.
  The overlay is clear and 40px tall, the bar's height; `window:set-zoom` rescales it with the page,
  and a theme change sets only its colours (`captionInk`), so a zoomed bar keeps its height.
- The renderer leaves that corner empty: `chrome/WindowControls.tsx` draws a spacer as wide as
  the system says the buttons are (`env(titlebar-area-width)`), and no controls of ours. Linux
  and the /ui page keep the drawn ones. The bar is the drag region, as on the Mac.
- The glyphs take the ink of the app's theme. Only the page knows its theme, so it writes the
  shell colour to its `theme-color` and main reads `did-change-theme-color` (`isDarkColor`).
- No menu bar (`setMenuBarVisibility(false)`), so Alt reveals nothing; the menu still exists and
  its accelerators run, Ctrl where the Mac has ⌘.
- **No Mica.** The plan named it; docs/DESIGN.md has one neutral palette and no glass, and it wins.
  The shell is the opaque `sidebar` tone on every platform.
- The lock and sleep come from `powerMonitor` (`screenOfIdleState` for the state at boot); the
  display is kept awake while threads work, as on a Mac (`powerSaveBlocker`).

## Keys

One key map, `src/renderer/src/lib/keys.ts`:

- `modKey(e)`: the command modifier, ⌘ on a Mac and Ctrl elsewhere, one of the two alone. For the
  chords where Ctrl on a Mac means something else: ⌘Enter in the composer, ⌘click on Send, ⌘P.
- `modOrCtrl(e)`: either key, which most chords have always taken on every platform.
- `ctrlOnly`, `altOnly`, `macCommand`, `chordKey`, `bareKey` for the rest.
- `keyHint("mod+shift+M")` is `⌘⇧M` on a Mac and `Ctrl+Shift+M` elsewhere; `keyCaps` gives the
  caps one by one. `lib/settings.ts`'s key list, the in-app menu bar and every tooltip go through them.

`lib/keysGuard.test.ts` holds it: no renderer file but `lib/keys.ts` reads `metaKey`, and none
types a key glyph outside a comment (Appshots, a Mac-only feature, is the one exception). A test
whose keys are a Mac's says so with `vi.mock("…/lib/platform", () => ({ IS_MAC: true }))`.

A Windows host's glyph is a desktop (`hostKind` in lib/hostPlatform.ts, `chrome/HostGlyph.tsx`).

## Proof

Seen in the rig on 2026-11-19, as the standard user, never elevated (`bun scripts/e2e-updater.ts
--win`, screenshots in .temp-code/plans/landed/M12/):

- **Install.** The installer ran silently over SSH in session 0 and exited 0 in 270 to 350 s
  (Defender on, an emulated disk): `%LOCALAPPDATA%\Programs\TempCodeE2E`, nothing under Program
  Files, a Start menu shortcut. The bundled `claude.exe --version` answered `2.1.280 (Claude Code)`.
- **The window.** Windows' own caption buttons over the page's bar, the caption space 136px, none
  of ours; their glyphs in the theme's ink in dark and in light (the page's `theme-color`, an
  `oklch()` string, reaches `did-change-theme-color` as a colour); Alt shows no menu bar; Ctrl+,
  opens Settings; every hint on the Keybindings page reads Ctrl and no ⌘ shows anywhere; Ctrl+=
  zooms to 110% and the caption buttons grow with the 44px bar. The database is under
  `%LOCALAPPDATA%`.
- **Update.** check → download → Restart to update off a local feed: the app shuts its work down,
  the bundled `claude.exe` left running out of the install folder is gone within six seconds, the
  installer's own progress window runs for six to eight minutes, then starts 1.0.N, which answers
  its version with no pending update and no failure and has cleared its attempt record.

Not seen: Snap Layouts on hovering maximise (the rig has no pointer input yet, milestone 43); a
real thread or a warm harness across the update (milestone 13); the real product's name
(`TempCode`; the test builds are `TempCodeE2E`, the folder rule is the same); the zip.

The driver, on the box: builds 1.0.N-1 and 1.0.N as `TempCodeE2E` with the harness block, serves
the new one from a local feed, installs the old one silently, starts it on the desktop, checks the
frame, both themes, Alt, Ctrl+, and the key list over CDP, runs the bundled CLI, and drives the
update until the relaunched app answers. `--busy` starts the bundled `claude.exe` from the install
folder before the restart and checks the sweep ended it; `--reuse` keeps the builds; `--rig-up`
uses a rig that is already up; `--build-only` stops after the builds. The guest reaches the feed
and the box reaches the guest's CDP ports through one SSH connection (`-R` and `-L`): Chromium's
debug port listens on the guest's own loopback, where QEMU's forward does not reach. Each build has
its own CDP port (9333 old, 9335 new): the installer inherits the old app's listening debug socket
and holds it while it starts the new app. Over SSH, list a standard user's desktop processes with
`Get-Process`; a CIM query of them is refused.

Unit tests: `src/main/windowFrame.test.ts` (window options per platform, the data folder),
`scripts/winRelease.test.ts` (the release file list, the config, the release check),
`src/main/updateInstall.test.ts` (the child sweep, taskkill's arguments, the install on quit,
the relaunch when no quit begins), `src/main/server/skills/links.test.ts` (junctions, boot), `src/main/presence.test.ts` (the lock at boot),
`src/renderer/src/lib/keys.test.ts` and `keysGuard.test.ts`, `chrome/WindowControls.dom.test.tsx`,
`chrome/HostGlyph.dom.test.tsx`.
