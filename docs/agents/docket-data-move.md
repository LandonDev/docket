# The move to Docket's names

The app's own folders and database files take Docket's names. One rule for
every part: the thing moves to its new name by one rename on the same disk,
and a link at the old name points to it. Nothing stored is rewritten and
nothing is copied, so every path saved by an old name (thread rows, project
cwds, git's worktree records, `/etc/temp-code.env`, the unit) still resolves,
and an older build still finds everything. A rename the system refuses leaves
the app on the old names, and says why in the log (`[boot] data, not moved:`)
and in `doctor.get`'s `dataMove.held`.

The code is src/main/dataMove.ts (`moveData`, pure and synchronous, its
changes behind a `MoveOps` seam the tests use to refuse a rename or stop dead
after any step). boot.ts runs it; index.ts and doctor.get read the outcome
from `globalThis.__tempcodeDataMove` through src/main/dataMoveBoot.ts.

`TEMP_CODE_*` variables, the `tempcode-app://` scheme, the bundle id, the
package name (`temp-code`), Keychain items and wire names keep their names.

## What moves

| Where | Folder | Database | Home folder |
| --- | --- | --- | --- |
| Mac | `~/Library/Application Support/temp-code` → `Docket`, a symlink at the old name | `temp-code.db` → `docket.db`, `temp-code-cold.db` → `docket-cold.db`, with their `-wal`, `-shm`, `-journal`; a symlink at each old name | `~/.temp-code` → `~/.docket`, a symlink |
| Windows | `%LOCALAPPDATA%\temp-code` → `Docket`, a junction | keeps its names | `~\.temp-code` → `~\.docket`, a junction |
| Linux, installed | `~/.config/temp-code` → `Docket`, a symlink | as the Mac | as the Mac |
| Any override (`TEMP_CODE_USER_DATA`, a bundle's baked harness folder: the box, `dev:prod`, dev instances) | never moved | as the Mac, on unix | never moved |
| Dev build with no override | nothing: such a build refuses to run | | |

- The folder moves only for a packaged app with no override whose own folder
  is `temp-code`. `~/.temp-code` moves only after the data folder's move
  finished. The code keeps spelling it `~/.temp-code`: the link serves it.
- The database step runs on whichever folder the launch uses, unix only.
  SQLite's unix VFS names `-wal` and `-shm` from the real file behind a link,
  so the old name opens the same database and the same WAL; no sidecar
  needs a link. Windows keeps `temp-code.db`: a file symlink there needs a
  privilege, and a hard link would give each name its own WAL.
- A folder held by another live process (its Chromium `SingletonLock` names
  a pid that answers `kill(0)`, any program, since `dev:prod` runs another
  binary on the same data) waits for a later launch.
- Two real folders, or two real databases, are never merged. A folder pair
  runs on the new one only if it carries this move's mark (`.docket-move`)
  or is ours and newer; a database pair runs on the newer. Either way
  `held` says so and nothing changes.
- Per-project `.temp-code/` folders in a repo stay as they are: they are
  tracked in the owner's repos (89 files in this one), named in ignore rules,
  and live in other people's checkouts. Moving them is a change to each repo,
  not to the app.

## Launch order

1. boot.ts, before anything opens a file in the folder: the database, the
   single-instance lock, Chromium's profile, the staged code's pick
   (`pickCode` reads `<userData>/code`). `moveData` runs, and for an
   installed app `app.setPath('userData', …)` names the folder it settled on.
2. Each change is logged as `[boot] data: …`, each refusal as
   `[boot] data, not moved: …`. Any throw is caught: the app starts on the
   old names.
3. index.ts opens `dataMoveBoot().db` (`docket.db`, or `temp-code.db` on
   Windows or after a held move). Its old copy of the database from
   `TempCode/` on a first packaged Mac launch is gone; that would have put a
   second database beside the moved one.
4. doctor.get answers `dataMove: {userData, db, did, held}`.

boot.ts imports dataMove.ts, so it is in `BOOT_SOURCES`
(scripts/lib/codeBase.ts): the boot base changed, and the first build with
this needs a full signed release ([code-only-updates.md](code-only-updates.md)).

## A crash at each step

The folder (a launch takes its mark first, a file `{pid, at}` in the folder):

| Stopped after | On disk | The next launch | An older build |
| --- | --- | --- | --- |
| the mark | `temp-code/` with `.docket-move` | the mark's pid is dead or a minute old: it takes the mark and moves | runs on `temp-code/` |
| the rename | `Docket/` with the mark, no `temp-code` | links `temp-code` to it, drops the mark | **starts on a new, empty `temp-code/`**; this build's next launch finds two folders, runs on the marked `Docket/` and holds |
| the link | both names, the mark still in `Docket/` | drops the stale mark | runs through the link |

A database (in this order, each a rename or a link):

| Stopped after | On disk | The next launch | An older build |
| --- | --- | --- | --- |
| a hard link `docket.db` to `temp-code.db` | one file, two names | carries on: the pair is one file | opens `temp-code.db`, the same file and its WAL |
| `-shm` renamed | as above, no old `-shm` | carries on | rebuilds the `-shm` |
| `-journal`, `-wal` renamed | `docket.db-wal` holds the newest rows | carries on | **opens `temp-code.db` without its WAL** and sees older rows; the only unsafe instant |
| `temp-code.db.docket-link` renamed over `temp-code.db` | done | nothing to do | opens through the link |

Both unsafe instants last between two renames and do harm only if the app
dies in one and an older build is the next to open the folder. This build's
next launch finishes either: a marked `Docket/` with no link, or an old name
still a real file with the new name the same inode beside it.

## Readers and fences

- src/main/index.ts: the database name from the move; the Mac copy block
  removed.
- src/main/server/gateway.ts `mayClaimShim`: `TEMP_CODE_USER_DATA` naming
  either `temp-code` or `Docket` under the app-data folder is prod.
- src/main/server/processGuard.ts `isProdData`: by name or real path; the
  guard's instance id hashes `…/Docket` as `…/temp-code`, so the last boot
  under the old name still owns its orphans.
- src/main/server/remote/macBridge.ts: `Library/Application Support/Docket`
  and `AppData/Local/Docket` on the deny lists beside the old names.
- src/main/server/threadResourcesRemove.ts `PROTECTED_USER_DATA`: `Docket`.
- src/main/server/build.ts: a build worktree is matched by real path, since
  git records the real one (`~/.docket/builds/…`).
- remote/fence.ts needed nothing: `insideRoots` compares real paths with
  real roots, so a root saved as `~/.temp-code/worktrees/…` still admits
  its files.
- computer/policy.ts and appshots.ts needed nothing: they match the bundle
  and the process, not the data folder.
- scripts/bench-boot.ts: its guard refuses `Docket` too.
- Backups: scripts/mac/backup.sh resolves the folder (`cd -P`) and skips a
  database that is a link; the box's sqlite-snapshot.sh skips links, so each
  database is copied once, under its new name. The restore drill compares
  whatever names the snapshot's manifest holds, so it finds `docket.db`.
  70-backups.sh and 75-backup-maintenance.sh exclude the new folders' live
  databases, builds and previews.
- The box: box-update resolves the builds folder before it prunes and writes
  each `current`/`previous` link by the build's bare name, so it holds
  through the folder's rename either way; 85-temp-code.sh's AppArmor grant
  covers `docket-builds/*` (AppArmor matches the real path) and its checks
  follow links (`stat -L`), as do 90-verify.sh and box-probe.mjs;
  import-history.sh's guard compares real paths.
- Left as they are: the history move's one-shots (scripts/mac/split-data-dir.sh,
  cutover-run.sh, [history-move.md](../history-move.md)) take `temp-code/` to be
  the real folder. Run them before the Mac's first launch of a build with the
  move, or teach them the link first: after it, `split` would rename the link.

## What an older build sees

Everything, by the old names. On a Mac or Linux it opens
`…/temp-code/temp-code.db`, which is two links to `Docket/docket.db`; SQLite
writes `docket.db-wal`, the same WAL the new build uses. Its worktrees, its
attachments and its staged code resolve through `~/.temp-code` and
`temp-code/`. It never moves anything back. On Windows it opens
`%LOCALAPPDATA%\temp-code\temp-code.db` through the junction. Going back to
v394 needs no undo.

## The box

The service runs on an override, so the app moves only its database files
there. The folders move by a root script with the service stopped:

```bash
bash /srv/agents/temp-code-builds/current/scripts/box/docket-move.sh --dry-run
bash /srv/agents/temp-code-builds/current/scripts/box/docket-move.sh --stop-service
```

It moves `/srv/agents/temp-code-data` → `docket-data`,
`/srv/agents/temp-code-builds` → `docket-builds` and
`/srv/agents/home/.temp-code` → `.docket`, each by one rename with a relative
link at the old name. Before the moves it widens AppArmor's grant, adds the
restic excludes and installs box-update and box-sqlite-snapshot from the same
build. It checks all three pairs before it changes one, refuses two real
folders, refuses while `temp-code.service` runs unless `--stop-service`
(then it stops, moves, starts, and prints the app's `[boot] data` lines), and
holds the maintenance and backup locks. A second run prints `ALREADY:` and
changes nothing; a run cut off between a rename and its link is finished by
the next. `--undo` gives the folders and both databases their old names back
(the WAL emptied first) and leaves a link at each new name, so a worktree git
recorded under `.docket` still resolves. `/srv/agents/work/temp-code` is not
touched. scripts/box/docketMove.test.ts rehearses every case on a scratch
tree (`DOCKET_MOVE_REHEARSAL`).

## Proofs

- `NODE_ENV=test bunx vitest run src/main/dataMove.test.ts src/main/dataMoveBoot.test.ts scripts/box/docketMove.test.ts src/main/server/buildDir.test.ts`:
  real temp folders and real SQLite with a WAL, a crash after every step,
  a refused rename, a refused link, a live holder, two launches at once, two
  folders, two databases, Windows junctions by the seam.
- `bun scripts/e2e-docket-move.ts [--old <build dir>] [--keep]` on the box
  after `electron-vite build`: the built app run as an installed one on a
  scratch HOME and XDG (see its header). The deployed build lays down the old
  layout with a workspace, a worktree project and two threads; this build
  moves it, keeps every thread and the worktree, takes a new thread, moves
  nothing on its second start; the older build then reads all of it through
  the links and writes to `docket.db`; and an unpackaged build on an
  override that is itself a link renames only the database.
- Not run: the Mac's packaged path (`~/Library/Application Support`), and
  junctions on a real Windows machine. `e2e-updater.ts` runs on an override,
  so it moves no folder. On the rig, with the installer built
  (`bun scripts/win-stage.ts stage`, `bunx electron-vite build`,
  `bunx electron-builder --win --config build/electron-builder.win.yml`):
  `scripts/win-vm/up.sh`; `scripts/win-vm/run-in-session.sh` the old
  release's installed app once to lay down `%LOCALAPPDATA%\temp-code`;
  `scripts/win-vm/scp.sh dist/temp-code-1.0.N-setup.exe guest:Downloads/`;
  `scripts/win-vm/ssh.sh 'Downloads\temp-code-1.0.N-setup.exe /S'`;
  `scripts/win-vm/run-in-session.sh "%LOCALAPPDATA%\Programs\TempCode\TempCode.exe"`;
  then `scripts/win-vm/ssh.sh 'dir /AL %LOCALAPPDATA%'` must show
  `temp-code [<JUNCTION>] …\Docket`, and the old threads must list.
