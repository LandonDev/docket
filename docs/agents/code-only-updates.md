# Code-only updates: a green commit in the owner's app within minutes

A full release takes 30 to 40 minutes from a thread finishing to "Restart to
update": the gate, then the Mac's build, sign, upload and publish gate. Yet
the built code (`out/`) is platform-independent JavaScript, and the box's
commit gate builds it at every release. A code-only update sends that `out/`
to the installed Mac app over the peer link and runs it over the signed
bundle. No bundle is signed and no GitHub release is cut. The full release
stays the only way to change anything the code cannot carry.

## The time (2026-11-23)

| Step | Where | Time |
| --- | --- | --- |
| The commit gate: typecheck beside the build, then bundle-size | box | about 180 s, the build's own length |
| Bump, commit, tag, push | box | a few seconds |
| Pack `out/` (36 MB) and write the manifest | box | 3.2 s |
| Announce to the linked Macs | box | under 1 s |
| The bytes over the link | link | 12.9 s for 36 MB by scp from the box to the Mac (2.8 MB/s); the link's base64 adds a third |
| Check the sha256, count the unpacked size, unpack, check the entries, hand to boot | Mac | 1.0 to 1.8 s (measured with the bytes over loopback) |

So a master commit reaches "Restart to update" about three and a half
minutes after the release train starts on it, and the floor is the build
(180 s on the box) plus about 25 s. The steps from the announce on were
measured in the packaged proof over loopback; the whole path over the real
link is unmeasured until the first release after this lands, since the
installed app and the box both need this code first.

## The parts

| Part | File |
| --- | --- |
| What boot may run, the trial, the state on disk | `src/main/codeChoice.ts` (boot only) |
| The entry that picks, loads and settles | `src/main/boot.ts` |
| What boot picked, for the rest of the app | `src/main/codeBoot.ts` (`globalThis.__tempcodeCode`) |
| The base stamp of a tree | `scripts/lib/codeBase.ts`, written to `out/code-base.json` by `electron.vite.config.ts` |
| The pack | `scripts/lib/codePack.ts`, `scripts/code-pack.ts`, called by `scripts/release.ts` |
| The host's side: announce, manifest, bytes | `src/main/server/codeOffer.ts` |
| The Mac's side: the chosen host, fetch, check, stage | `src/main/server/codeUpdates.ts` |
| The words, the chosen host, the secure route, the offer decision | `src/shared/codeUpdate.ts` |
| The wire | `src/shared/contract-code.ts`, the `code-available` push in `contract.ts` |
| The restart and the status | `src/main/update.ts` (`setCodeStatus`, `restartIntoCode`) |
| The proof's stand-in host | `src/main/server/codeHarness.ts` |

## The box makes it

`scripts/release.ts` runs the commit gate, which builds `out/` in the
checkout, then bumps release.json and package.json, commits, tags
`release-N` and pushes when asked. Then it runs
`bun scripts/code-pack.ts --commit <built> --release N --announce`, where
`<built>` is the commit the gate built (the parent of the release commit).
Nothing is built a second time. The pack comes after the push, so a Mac
never runs a release that did not reach origin. The step never fails the
release, and its lines come before release.ts's last line, which batch.ts
reads.

The pack is `dist/code-update/<commit>/code.tar.gz` (the whole `out/` but the
source maps and bundle-map.json) and `code-manifest.json` beside it:

- `commit`, `release`, `subject`, `builtAt`;
- `tar`: the tarball's size and sha256;
- `entries`: the sha256 of every file directly in `out/main` and
  `out/preload` and of `out/renderer/index.html` (500 at most);
- `base`: the base stamp.

The packer refuses an `out/` that is not that commit's clean build
(`out/bundle-map.json`'s stamp) and a tree whose base moved since the build.
Only the newest pack is kept.

`--announce` tells the headless host on the same machine through tc-local
(`code.announce { dir }`, the loopback socket only). With no host running
there (a Mac's own post-commit train) it says so and packs nothing.

### The base stamp

The stamp names what the code needs under it and cannot carry. The build
writes it to `out/code-base.json`, so every bundle holds its own, and a pack
holds the stamp of the tree it was built from. Five parts, each compared on
its own, so a refusal can say which one moved:

| Part | What it covers | The line when it differs |
| --- | --- | --- |
| `electron` | the version in node_modules/electron | needs a full release: Electron changed |
| `lock` | bun.lock, which is node_modules | needs a full release: node_modules changed |
| `beside` | every tracked file under `resources/` (the work templates, the blank files, the appshot helper's source), the `.mjs` and `.cjs` under `scripts/` (the app bridge), `electron-builder.yml` and `build/entitlements.mac.plist` (what ships, the Info.plist keys, the fuses, the entitlements), and package.json's `name`, `productName`, `main` and `type` | needs a full release: the files beside the code changed |
| `native` | the tc-computer Swift package and `scripts/lib/tcComputerBuild.ts` | needs a full release: a native helper changed |
| `boot` | `src/main/boot.ts`, `codeChoice.ts`, `compileCache.ts` | needs a full release: the boot code changed |

Files are hashed as git tracks them, by path and bytes, so a Mac and the box
agree on one commit. package.json's version, its script table and its
dependency list are left out: a release rewrites the first, a new script
changes nothing the app loads, and bun.lock already covers the third. A tree
with no git has no stamp, and a build with no stamp takes no code.
`scripts/lib/codeBase.test.ts` holds the `boot` list to boot.ts's own
imports.

One limit: `lock` is bun.lock's hash, not a reading of node_modules. A box
checkout whose node_modules lags its lock would build `out/` from older
bundled packages under a stamp that names the newer lock. The gate's
typecheck catches most such trees; nothing here does.

## The box hands it over

The host (`CodeOffers`) remembers the pack's folder in one settings row
(`code-offer`) and sends `code-available` down every registered Mac's
socket, the path `release-available` takes. The push names the commit and
carries nothing to trust. The Mac then asks over the link it dialed:

- `code.latest` → the manifest as written, or null (admin);
- `code.chunk { commit, offset, length }` → up to 2 MiB of the tarball,
  base64 (admin). A commit that is no longer the newest is gone.

A Mac that was asleep asks `code.latest` when its link comes up.

No key, ticket or pairing link is written anywhere: the bytes ride the
socket the Mac already authenticated with its saved key.

## Who can put code in the app

- **The one host the Mac's setting names**, over the link the Mac dialed to
  it. The setting (`code-updates`) holds a saved environment's id, or
  `off`. With nothing set, the Mac's only admin host is chosen at first use
  and written down; with several, none is taken until the owner picks one
  in Settings → Hosts. A host saved later is never taken on its own: a host
  states its own caps when it is saved (`remote/environments.ts` keeps what
  its hello says), so "admin" alone says only that the Mac holds an admin
  key to it. The host is the link's, never a frame's `from`. The Mac asks
  for the manifest and the bytes; no method on the Mac takes code from a
  caller. Another client of the Mac (the phone, a browser at `/ui`, a host
  with a key to the Mac) has no way in.
- **Only over a link the network cannot read or answer for**
  (`routeIsSecure`): a `wss://` route or loopback. The sha256 comes from the
  same host as the bytes, so on a plain `ws://` LAN route anyone who can
  answer for the host's name could serve both. Over such a route nothing is
  asked and the app says "Code updates need an encrypted link to The box."
  The box's route is its Cloudflare tunnel, which is TLS.
- **On the box, whoever can open its loopback socket.** `code.announce`
  takes any folder that holds a pack and asks for no token, and every agent
  thread on the box runs as the box's user. So a thread there (or anything
  that steers one) can offer a hand-made pack with no commit and no gate
  behind it. The box cannot tell its release train from its agents: they
  share one account, and a real wall needs a key the agents cannot read (a
  signed manifest, with the Mac pinning the public key at pairing). That is
  not built. What stands between such a pack and the app: the owner's
  press on Restart (below), the row naming the pack's subject, and the
  same reach those threads already have through the Mac bridge when it is
  on for the box.
- **On the Mac, the owner's own account.** The staged tree lies in userData,
  which his account can write, as it can write the bundle (`asar` is off and
  the app folder is his). boot's hashes catch a torn or half-written tree;
  they are not a defence against a process that already runs as him.
- **A proof's stand-in host** (`TEMP_CODE_CODE_HOST=self`) is honored only
  with `TEMP_CODE_USER_DATA` set to a folder that is not the app's own data
  (`isProdData`): the code it stages lands in that isolated userData and
  the real app never reads it.

## The Mac takes it

`CodeUpdates` runs these checks in this order. Each has a test.

1. **Who.** The offer came on the link of the chosen host, and that link is
   secure. Otherwise nothing is asked.
2. **Boot's word.** The manifest goes to `CodeBoot.refusal`: the bundle's
   own boot code says whether it would run it. A base that differs is
   refused with its line and nothing is fetched. A release no newer than the
   bundle is skipped.
3. **Already here.** The commit that runs, the commit already staged, and a
   commit older than either are skipped. A commit that did not start here is
   not taken twice. A pack that failed a check below is not fetched again
   until the host has another.
4. **The bytes.** Chunks are appended to
   `<userData>/code/incoming/<commit>.tar.gz.part`. A link that breaks off
   leaves the part file, and the next offer goes on from its size. The whole
   file must have the manifest's size and sha256, and must unpack to no more
   than 1 GiB, counted before anything is written.
5. **The tree.** The system tar unpacks it into an empty folder, its modes
   are opened (`chmod -R u+rwX`), and it may hold one `out/` of plain files
   and folders and nothing else. The manifest is written beside it and the
   folder moves to `<userData>/code/<commit>/`.
6. **Boot again.** `CodeBoot.offer(commit)` checks the manifest and every
   entry file's sha256 as boot will at launch, then writes
   `state.json` `{ current: { commit, state: 'staged' } }`.

Then the update status carries the offer and the rail's row reads "Restart
to update" with the commit's subject. A newer offer takes the place of an
older staged one, and the tree that is running is left alone until the
launch after.

**Nothing runs before the press.** A staged tree runs only once it is armed,
and only `restartIntoCode` arms it (`CodeBoot.arm`, inside the confirmed
quit). A quit and an open, a crash, a reboot or a release's own relaunch
leave it waiting, still offered.

A refusal is one plain line in the status (`CodeUpdateStatus.notice`), shown
once as a toast and on the setting's row: "Code update 3f9c2ab needs a full
release: node_modules changed."

## boot.js picks the code

`package.json` `main` is `out/main/boot.js`. It enables the compile cache,
asks `pickCode` and requires `<picked out>/main/index.js`. The staged tree
runs only when all of this holds:

- the build can take code: packaged, not Windows, with a base stamp;
- `state.json` names a tree that is armed or already good, and no other live
  process of this program is the state's `runner` (a second process beside
  a running app changes nothing and runs the bundle's code before it meets
  the single-instance lock; the check is made again at every write, so a
  process that outlives the first may write);
- the tree's manifest names its own commit, the bundle's base, and a release
  newer than the bundle's;
- every entry file hashes to the manifest's word (4.5 MB, a few
  milliseconds). The chunks, the renderer's assets and the hosted pages are
  covered by the tarball's sha256 at staging, not hashed at launch: harm
  there later shows as a broken feature, not a refused tree.

### Paths

A staged tree is made to look like the bundle's app folder with `out/`
swapped. At every launch boot links each other entry of the bundle
(package.json, node_modules, resources, scripts) into
`<userData>/code/<commit>/` (`mirrorBundle`). So:

- Node resolves a package from the staged code through `node_modules` to
  its real file in the bundle, native modules included;
- `appRoot()` (server/appRoot.ts) walks up from the running code to
  package.json and finds `resources/` through the link; a program started
  from there (tc-computer, the appshot helper) is named by its real path in
  the bundle (`bundleFile`), the path its signature and privacy grants were
  given under;
- every entry under `out/` comes from the same tree, because each is found
  from the code that runs: `__dirname` for the preload, the renderer
  (`tempcode-app://`), the gateway, the exec broker, the add-on host, the
  stats worker and the sheet worker; `appRoot()` for the Work service, the
  hosted pages, the `/ui` handler and the app bridge.

`app.getAppPath()` stays the bundle. Only boot.ts and the harness block
read it. `src/main/codePaths.test.ts` holds the main process to four
rules: no other `getAppPath()`, no runtime import of codeChoice.ts outside
boot.ts, no path counted up from `__dirname` to `resources/`, and every
`app.relaunch` naming its arguments (below).

`buildInfo()` answers with the staged code's release and commit when one
runs, and the server says `build.version` wherever it names its version.
The numbers baked into a staged `out/` are its parent's, since the gate
builds before the bump.

## It can never lock the owner out

- **One trial.** boot writes `trying` (a temp file, flushed, renamed) before
  it requires the tree. A marker that cannot be written means the bundle's
  code.
- **Good is boot's call, not the tree's.** The app says `started` when two
  things are true: its own window mounted its app shell (the shell's effect
  sends `window:close-subscribe`) and that window got its first
  `session.list` answer from the local server. Then boot.ts, which is
  bundle code, turns the tree good only when the launch has lived a minute
  more (`GOOD_AFTER_MS`) or quits cleanly (`will-quit`). A tree that dies in
  its first minute (the resume of cut threads, a first query over the real
  database) never settles, whatever it said.
- **A crash or a hang.** A launch that finds `trying` runs the bundle's
  code, records the tree as failed and says so once ("Code update 3f9c2ab
  did not start. Running 1.0.371."). The sweep removes the tree.
- **A good tree that stops starting.** A tree that was good can break later
  (a file gone, data it cannot read). Every launch of a good tree counts a
  strike before it is required, and settling clears it. Two launches in a
  row that never settled (`GOOD_STRIKES`) drop the tree like a failed trial.
  One could be a force quit in the first second, so one is not enough. A
  strike that cannot be written means the bundle's code.
- **A throw at require.** boot catches it, records it, and starts the app
  again with `--tempcode-bundle-code`. That launch runs the bundle's code
  whatever the state says, so the fallback does not depend on the record
  having reached the disk. The second index.js is never loaded into the
  process that ran half of the first: its handlers would be registered
  twice.
- **The flag does not ride along.** boot takes it out of `process.argv`,
  but Electron keeps its own copy of the command line and a bare
  `app.relaunch()` copies that. So every relaunch in the app names its
  arguments from `process.argv` (the guard test). Without that, the first
  "Restart to update" after a fallback would land in another bundle-only
  launch and never run staged code: the packaged proof caught exactly this.
- **Any other fault in boot's own choice** (a state it cannot read, a link
  it cannot make) runs the bundle's code. `pickCode` never throws.
- **The way back by hand.** Choosing Off forgets the tree; the next launch
  runs the bundle's code. If Settings itself is broken,
  `open -a TempCode --args --tempcode-bundle-code` runs the bundle's code
  for one launch, and removing `<userData>/code/state.json` does it for
  good. A rollback to an older full release on the same base should remove
  that file too, or the newer staged tree keeps running over it.

## A full release wins

boot compares at every launch. A bundle whose release is as new as the
tree's, or whose base differs, drops the tree without a word, and the sweep
removes it. The database rule already holds (master only adds tables and
defaulted columns), so code may move forward and back across one release.

A downloaded release and a staged code offer can both wait. "Restart to
update" installs the release; the code offer is still there after it, if it
is the newer and on the same base, and waits for its own press.

## The setting and the line of truth

Settings → Hosts, This Mac, the Release group under Publish: **Code
updates**, a choice of host or Off (`code.settings.get`,
`code.settings.set { host }`, loopback only;
surfaces/settings/hosts/CodeUpdates.tsx). With one admin host it is chosen
by default. The row is absent on a build that cannot take code and on a Mac
with no admin host. Off, or another host, forgets the staged tree. Main's
one line (a fallback, a refusal, an unencrypted link) is the row's state
line, and a toast once per line per launch (lib/updater.ts `firstSaying`).

The rail's row for a code offer is the release's own "Restart to update",
with the commit's subject on hover; Settings → General's Release row reads
"Code update: <subject>. Restart to finish." A downloaded release outranks
a code offer on both, and a code offer outranks a release that is only
available.

Wherever the app says its version it says the bundle's version plus the
commit when staged code runs: "1.0.371 + 3f9c2ab" (`versionLine`), in the
About panel, the rail's update row and Settings → General's Release row.

## What it does not do

- Windows takes none (links are junctions there and the installer owns the
  folder). The box keeps `box-update`.
- A window reload for a renderer-only change is not built. Every release
  bakes release.json into `out/main`, so no two releases share main bytes,
  and telling them apart would need a diff of sources.
- A staged tree that starts, lives its minute and then misbehaves is not
  caught. The trial proves the launch, not the feature.
- There is no watchdog on a trial that hangs with no window. The owner
  quits and opens the app, and that launch runs the bundle's code.
- The box's agents are not walled off from `code.announce` (above).

## The first time, once

The installed app gets this boot.js only through one ordinary signed
release, and the box answers `code.announce` only once it runs this code.
After this lands: deploy the box (`box-update`), publish one release, and
restart the Mac app into it. From then on every `release-N` the box cuts
reaches the Mac as a code-only update, until a commit changes the base. The
app says that in one line, and that commit needs the next full release.

## Proofs

- Unit: `src/main/codeChoice.test.ts` (the choice, the armed tree, the
  trial, boot's settle, both fallbacks, the strikes, a full release wins, a
  second process, the mirror), `scripts/lib/codeBase.test.ts`,
  `scripts/lib/codePack.test.ts`, `src/main/server/codeUpdates.test.ts`
  (the host, the Mac, the one chosen host, the secure link, the refusal, a
  broken link, tampered bytes, a locked archive, the choice turned off
  mid-fetch), `src/shared/codeUpdate.test.ts`,
  `src/main/codePaths.test.ts`, `src/main/server/appRoot.test.ts`,
  `src/main/buildInfo.test.ts`, and the renderer's `updater.test.ts`,
  `updateStore.test.ts`, `UpdateRow.test.ts`, `General.dom.test.tsx`,
  `CodeUpdates.dom.test.tsx`, `HostsPage.dom.test.tsx`.
- Packaged, on the Mac: `bun scripts/e2e-code-update.ts` builds one signed,
  un-notarized copy (bundle id dev.landon.tempcode.e2ecode, product
  TempCodeCodeE2E, under /private/tmp/tc-code-update-e2e, CDP 9232). The
  copy takes code from its own server over a loopback socket
  (`TEMP_CODE_CODE_HOST=self`), so a test pack is never announced on the
  real box, which would offer it to the owner's app. It takes a good pack,
  leaves it waiting across a plain quit and launch, restarts into it and
  watches boot settle it; then a pack that throws at require; then, from
  that fallback launch, one that ends the process in its trial.

Run on the Mac on 2026-11-23, from a scratch clone, on the tree one small
change before this one landed (the arming made unable to throw): **46 of 46
checks passed** in one full run (build 71 s, the whole run 404 s with the
pack, the signing and the minute's wait for the trial). The build wrote its
base stamp, and the Mac's stamp equalled the one the box computes for the
same tree, part by part. The good pack was staged 1.0 s after the announce
and the row read "Restart to update". A plain quit and launch ran the
bundle's code and kept the offer. After the Restart, main, the gateway's
utility process, the preload and the page all came from the staged tree,
node_modules and resources resolved through the links, and boot turned the
trial good a minute after the window was up. The pack that throws brought
the app back by itself on the bundle's code with its one line, and the same
commit was refused. The pack that ends the process was restarted into from
that fallback launch, and the next launch ran the bundle's code with its
line. An earlier run of the same proof caught the relaunch that carried
`--tempcode-bundle-code` along; the guard test holds it now.

## Unproven

- The bytes over the real peer link, from the box's own `code.announce` to
  the installed app: the proof's link is a loopback socket to the copy's own
  server, which runs the same `code.latest` and `code.chunk` handlers. The
  first real crossing is the first release after this lands.
- tc-computer's privacy grants under staged code. It is started by its real
  path in the bundle, the same path as before; the proof checks only that
  the file is found.
