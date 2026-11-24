# The Windows build: install, update, frame and keys

TempCode on Windows 11 as a desktop app: an installer that needs no admin, an updater, the
Windows frame and Ctrl keys (milestone 12 of the Work plan). The host core under it (shells,
process trees, links, the path fence) is milestone 13's, and a Windows host linked to the box is
milestone 41's. Every Windows branch sits behind a platform check, and the Mac's build, release
and updater are as they were. What runs: the install, the window with its frame, the keys and
the update (seen in the rig, "Proof" below); threads, terminals and the harness CLIs run on the
host core, [windows-host.md](windows-host.md).

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

Milestone 13 finished the rest (the config dirs' file and directory links, copied generations,
a junction view through gc in the rig): [windows-host.md](windows-host.md) "Links and config dirs".

## The build

- **Config.** `electron-builder.yml` holds the `win` block (an `nsis` installer and a `zip`, both
  x64, the icon, the signing hook) and the `nsis` block (`oneClick: true`, `perMachine: false`).
  `build/electron-builder.win.yml` extends it with the file rules only a Windows pack needs, and
  **every Windows build passes it**: `electron-builder --win --config build/electron-builder.win.yml`.
  Never put a string under `win.files` in the main config: electron-builder folds the top-level
  `files` strings into one file set and a platform's strings become a second, wider one, whose
  union undoes every exclusion (the first Windows pack carried `src/`, `docs/` and `ios/`). Two
  configs joined by `extends` merge into one set.
- **Where it is built.** On the Mac by every publish, once the Mac's release is live (below), or on
  the box by hand (`bun scripts/release-win.ts`, after `electron-vite build`).
  electron-builder makes the NSIS installer anywhere, but it writes the uninstaller by running
  the half-built installer once: on a Mac it reads it out of the file in JavaScript instead
  (`UninstallerReader`), as LifeOS's release does, and on Linux it wants wine. The box has no
  wine, and electron-builder's own bundle (`toolsets.wine: 1.0.1`) does not start there (it
  carries no Windows DLLs of its own: `failed to load ntdll.dll`). So the box's build
  (scripts/release-win.ts `wineStandIn`, which the updater proof uses too) puts a `wine` first on
  PATH that calls the same `UninstallerReader` the Mac's build uses.
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

## The tools

tc-computer.exe, the Windows computer-use service (native/tc-computer-win, Rust), is cross-built
with cargo-xwin, which downloads Microsoft's CRT and Windows SDK headers and libraries on its first
run and links with lld. On the box: `~/.cargo/bin`, the SDK under `~/.cache/cargo-xwin`. On the
Mac, in the owner's account with no admin: rustup (`~/.rustup`, `~/.cargo`), the
`x86_64-pc-windows-msvc` target and `cargo install --locked cargo-xwin`, the SDK under
`~/Library/Caches/cargo-xwin` (1.1 GB; installed 2026-11-23, .temp-code/plans/landed/F-windows-installer.md).
The link step runs `lld-link`: on the box cargo-xwin's own, on the Mac Homebrew's `lld` formula
(`/opt/homebrew/bin/lld-link`, already there; `brew install lld` on a Mac without it). No clang-cl
or llvm-lib is needed while the crate compiles no C. The license question of the first download is
answered by `XWIN_ACCEPT_LICENSE=1`, which `buildCommand` sets.
`scripts/build-tc-computer-win.ts` puts `~/.cargo/bin` first on PATH, so a login shell without it
still finds them. Without cargo-xwin the Windows pass stops at its first step and says so.

## The release

Every `bun run release:publish` makes the Windows files, after the Mac's: the Mac zip and
`latest-mac.yml` go live first exactly as before, the `phase ✓ total` line comes, and only then
does `scripts/release-publish-win.sh --built` run (`windows_pass`, before the proofs, so the soaks
never share the Mac with the pack). It never holds back or fails the Mac's release:

- `scripts/release-win.ts` makes the files from the `out/` the publish just built: cargo-xwin there,
  the win32 Claude CLI staged, tc-computer.exe cross-built, one electron-builder call on the Windows
  config (a config file of the run's own carries the output folder and `tempcodeBuild.sha`), the
  packed app checked (`check-app`), its `resources/app-update.yml` read for github LandonDev/temp-code,
  the four files checked against `latest.yml` (`check-files`). It exits 1 with one line saying which
  step failed.
- `release-publish-win.sh` uploads to the live release: the installer, its blockmap and the zip, then
  `latest.yml` alone, so a Windows install never reads a feed whose installer is not there yet; then
  reads `latest.yml` back from the release (from `releases/latest/download/` when the release is
  Latest) once a second for a minute. It reads Latest before and after and puts it back with
  `gh release edit --latest` if it moved (adding files does not move it; publishing an older release
  again did, 2026-11-23).
- Its lines: `phase › windows`, then `phase ✓ windows 4m12s`, or `phase ✗ windows 3m02s` and
  `proof ✗ windows <why>, log <path>`. The app reads that proof line as it reads a red proof: a notice
  beside the live release ("The proofs after v1.0.N are red: windows (…). The release stays live."),
  and the publish's exit stays 0. The log is `<git-dir>/temp-code-gate/windows.log`.
- `--no-win` (or `TEMP_CODE_WIN=0`) leaves it out: `phase – windows skipped (--no-win)`. `--win` is
  the default and kept for old callers. `--dry-run` runs it too, with nothing uploaded.
- **A retry, or a release that went out without them:** check out its tag (`git checkout v1.0.N` in
  a clean clone) and run `scripts/release-publish-win.sh`: it builds `out/` itself (without `--built`),
  refuses a HEAD that is not the release's tag and a release that is still a draft, and adds the files.
- **"Restart to update" during the pass ends it**: the app's Publisher runs the script, and the
  restart stops the Publisher's process group. That release then has no Windows files until a retry
  or the next release; a Windows install's check fails quietly meanwhile.

The files:

| File | What |
|---|---|
| `temp-code-1.0.N-setup.exe` | the installer, about 300 MB |
| `temp-code-1.0.N-setup.exe.blockmap` | its block map, for differential downloads |
| `TempCode-1.0.N-win-x64.zip` | the app unpacked, for a PC that refuses the installer; a copy made this way does not update itself |
| `latest.yml` | the feed file a Windows install reads, beside the Mac's `latest-mac.yml` |

A release with no `latest.yml` (before 1.0.366, or one whose pass failed) leaves a Windows install's
check failing quietly until the next one that has it.

## Install

One click, per user: the installer writes `%LOCALAPPDATA%\Programs\TempCode` and asks for no
admin. `build/installer.nsh` names the folder after the product (electron-builder's default for
this mode is the package name, `temp-code`); an update keeps the folder the first install chose.
Silent: `temp-code-1.0.N-setup.exe /S`. The Start menu and the desktop get a shortcut, and the
shortcut's AppUserModelId is the app id (`dev.landon.tempcode`), which the app sets too
(`APP_USER_MODEL_ID` in src/main/windowFrame.ts) so toasts and the taskbar group find it.

The data (the database, checkpoints, logs) is `%LOCALAPPDATA%\temp-code` (the package's name, as the
Mac's `~/Library/Application Support/temp-code`), not Electron's default `%APPDATA%`: a managed PC copies the roaming profile at sign-out and this folder runs to gigabytes
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

Not seen: Snap Layouts on hovering maximise (milestone 43's pointer input can drive it, not yet tried); a
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
