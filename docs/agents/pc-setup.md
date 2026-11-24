# Setting up a computer from the giver

The plan is .temp-code/plan-d9AVYMURpw9s.md. This page says what is built.

## The trust boundary

- **Trusted with his accounts:** the giver (his Mac) and the box. The box
  already holds the static tokens, refreshes Codex and add-on grants and runs
  his threads.
- **Defended against:** a given computer (a PC, a second Mac, or a key
  stolen from one), a leaked setup link, a replayed or reordered message, and
  the phone and relay lanes. None of them can gain an account they were not
  given, plant one anywhere, or keep one past Stop or Remove at their next
  contact, and none can make two computers refresh one grant.
- **Not defended:** a token copied off a given computer's disk while it was
  given, or held by a computer that never makes contact again (the 30-day
  lease bounds the second).
- **Accepted (final review H2):** a device key holds operate and approve, so
  a given computer's proved sockets run box threads, Work and Files like any
  client key: it is trusted like a shell on the box, and Stop takes back its
  accounts but not that reach. The owner works from the laptop in his
  box-held Purdue workspace and chose this.

## The giver and the caps (M2)

- `give` (src/shared/capabilities.ts) is credential control over other
  computers: introducing an account (`accounts.push`), handing one off and
  settling it (`accounts.confirm`, `accounts.released`), withdrawing one
  (`accounts.removed`) and a pull with `takeOver`. `admin` never implies it.
- No key row stores `give`. The box keeps one giver record (settings row
  `devices.giver`: key id, device identity, name; src/main/server/devices/giver.ts),
  and a principal acts with `give` while its key is that one and live
  (`Givers.withGive`, applied at the listener's gate).
- **The cut-over.** The first boot of this build stamps `devices.upgradeAt`
  and ends every open pairing offer. The Mac's desktop calls
  `devices.claimGiver` on each box link before it syncs: the box accepts while
  no giver is set, and only from an admin key made before the stamp. Repeats
  from the giver answer ok. A PC never claims. Only `tc-local
  devices.setGiver '{"keyId":"…"}'` on the box moves or clears it (a press in
  /ui would let any admin key take it). setGiver names a key with no
  identity; that key's first claim fills it in, or no letter it signed would
  verify. An isolated proof names its stand-in giver the same way
  (scripts/e2e-accounts-sync.ts); an isolated instance with
  `TEMP_CODE_BUILD_PLATFORM=darwin` claims as a Mac's desktop does.
- **Upgrade order.** A box with the cut-over refuses pushes from a Mac
  without it; both sides ship in one release.
- `device` is a given computer's key. Its admin-tier calls are the
  `DEVICE_METHODS` allowlist; `DEVICE_REFUSED` is refused whatever else it
  holds; operate and approve work as on any key, so the PC's window runs box
  threads (its sockets prove through `devices.ticket`, below). `capabilityRefusal` is the one check, at the listener and on
  relayed lanes. `peers.ts` opens links for admin or device keys
  (`opensPeerLink`).
- Each install has a device identity (Ed25519 to sign, X25519 to be sealed
  to; src/shared/devices/keys.ts), made on first need and kept in its own
  vault as the bare secret `addon/~device-identity`, never synced
  (devices/identity.ts).

## Accounts on many computers (M2)

- **One admission check** (devices/admission.ts) on every receive path (the
  giver's push, a pull's answer, a rotation push, askOwner, a takeover) and
  on the box's export: the exact service and account id (an email that names
  another row is refused), only a row on file under the peer policy, no
  refresh token unless it is a handoff where one may arrive, and on a given
  computer only what its manifest names, by kind and owner.
- **Handoffs** go between the giver and the box only (`give`). Each has an id;
  its release or confirm must name the id and the grant's refresh
  fingerprint, else `stale`. Each side keeps its half in a settings row
  (`accounts.handoff.`, `accounts.released.`, `accounts.taking.`) so a restart
  settles it. The sender's `accounts.released.` record is written before any
  token is stripped, on a push and a takeover; a confirm that matches it
  finishes what a crash left (the strip, the owner) and answers ok, and a
  confirm with no matching record is no release outside the legacy stretch.
  Neither side hands out the grant its CLI is signed in with, and
  a lineage check that fails counts as that grant. The check runs again
  under the handoff lock on the exported grant (a push falls back to an
  access copy); aliax-core's `liveFingerprint` answers null only for a
  confirmed absent login and throws when the store cannot be read.
- **Withdrawal.** The giver deleting a copy another host refreshes names
  that host in the removal (`withdraw`), keeps it in `accounts.withdrawals`
  and sends it first at every sync until that host answers. The host it
  names drops the grant, ends any handoff of it and leaves a tombstone, so
  its copies go too. Only `accounts.removed` (give) carries it; a pull
  answer's tombstones never withdraw; the host's CLI sign-in is kept.
- A new account never takes a storage name a row on file has, in any case
  (`name-taken`).
- **Every host decides for itself.** A relayed lane's principal carries
  `via`; its host runs only what RELAY_METHODS carries (devices/hostRules.ts).
  `work.lifeos.setToken` is local-only. On a given computer the LifeOS
  session and every credential method are refused to remote principals
  (`GIVEN_HOST_LOCAL`).

## The box's mailbox (M3)

- **Tables** (db.ts): `device_bindings` (one row per given computer, never
  deleted), `device_mail` (the queue), `device_state` (the newest verified
  letter, never swept) and `device_removals` (outlives the mail).
- **The binding** (devices/binding.ts). `devices.activate` (give) binds
  `{envId, keyId, identity, generation, name}` as `active` and turns the
  pending key's caps into `approve, device, operate, read`
  (`RemoteAuth.setCaps`). It refuses a retired env id, an env id bound under
  another key, identity or generation, the giver's key, a key with admin or
  give, and a key that binds another computer. The same binding again
  answers ok. The giver's sockets hear `device-joined`.
- **The proof.** A device key's socket asks `devices.challenge` for a nonce
  bound to that connection, then sends `peer.register` with `proof`: Ed25519
  by the binding's sign key over canonicalJson({nonce, from, keyId}). The
  nonce is spent on the try. Until a socket proves, it may call only those
  two methods (`socketRefusal`, at the gate in index.ts). A proved socket
  may ask `devices.ticket`: a ticket that carries its env id
  (`provedEnv`), so the socket it opens starts proved while the binding is
  live (`adoptProof`). The computer's window gets its box tickets this way
  (`remote.environments.ticket` → `GivenComputer.windowTicket`); a bearer's
  own `/api/ticket` proves nothing. A device key opens a relayed lane only
  with such a ticket (listener.ts). Its headroom lands under its proved env
  id (`speakerFor`). Any other key
  registering as a bound env id is refused, admin or not, and a device key
  may register only as its own env id, while active or stopped.
- **Letters** (devices/mailbox.ts). `devices.post` (give) checks the giver's
  signature first, then that the header names a bound computer (not pending,
  not retired; while removing, only its `remove` letter, which needs
  `devices.remove` first), its seal key and generation, a seq above the
  newest on file, and the 256 KB cap. The letter goes in the queue, every
  older row of that computer goes, `device_state` takes it, the binding
  takes its seq and kind (a `stop` makes it `stopped`, a `manifest` after
  one makes it `active`), and the computer's proved sockets hear
  `device-mail`.
- `devices.mail` (a proved socket) answers the newest letter from
  `device_state`, so a computer that crashed mid-apply reads it again;
  while removing, the `remove` letter and `{removal: {removalId}}`.
  `devices.ack` checks the computer's signature over every field but the
  signature, that its seq was sent, and that an ack of the newest letter
  names its id and header digest. It lands on the binding, empties the queue
  up to its seq and tells the giver (`device-acked`). `devices.list` is
  every binding.
- **The filter.** `admittedFor(envId)` is undefined for a host bound to
  nothing here, null for a computer that may hold nothing (not active, no
  manifest as its newest letter, or past the manifest's `leaseUntil`), else
  the manifest's grants. AccountSync's `admittedFor` dependency applies it:
  a pull from a given computer carries only access copies this box owns that
  a grant names (kind access, owner this box) and lists and tombstones only
  the named accounts; `account` and `accounts-removed` pushes to its socket
  follow the same rule. A given computer pulls as the env id its socket
  proved, never one it names.
- **Clients' Revoke** refuses a given computer's key, over HTTP and on a
  socket alike (RemoteAuth's `setRevokeGuard`, `revokeByOwner`): only Remove
  ends it, so it wipes and LifeOS is revoked. The box's own ends (a receipt,
  the sweep) call `revokeKey`. A retired computer leaves every workspace's
  `mayUseDesktop` for good (`WorkSettingsStore.dropHost`, on the box at
  retire and on the giver when it forgets the row), so the same install set
  up again reaches only what its new link names.
- **Remove** (devices/farewell.ts). `devices.remove` (give) writes a removal
  with a random id and sets the binding `removing` in one commit, and puts the key in
  farewell: its tickets go, its sockets (relayed lanes too) close with
  FAREWELL_CLOSE (4010), the calls out on its registrations fail
  (`PeerCalls.dropKey`) and its video streams end. A second Remove answers
  the same id. From then the key reaches only `POST /api/farewell` (bearer):
  `{op: 'mail'}` answers its mail, and `{op: 'receipt', removalId,
  signature}` (the device key over canonicalJson({removalId, envId}))
  records the receipt, revokes the key, retires the binding, empties its
  queue and tells the giver (`device-gone`). After a receipt the key is
  revoked, so a retry of it gets 401. The revoke mark, the key's revoke,
  the binding's retire (only under that removal's id) and its mail go in
  one commit. An hourly sweep does the same for a
  removal with no receipt 30 days on (FAREWELL_TTL_MS). Who is in farewell
  is read back from `device_removals` at boot, and a removal an older
  build left half written is finished there before any request.
- **Every route checks the binding.** `liveBinding(envId)` is true only for
  `active` or `stopped`; `mayRoute(envId)` is true for a host bound to
  nothing or a live one. A computer leaves every route at Remove, before
  its receipt: Work's `mayUseDesktop` as it is read (WorkSettingsStore, so
  Files reach and the Office tools with it), `ownerDesktops` for a new
  workspace, and the bridge (`PeerCalls.call`, `push`, `online`,
  `registeredIds`).
- A retired env id is never admitted again, so setting up the same install
  again needs a new env id. A `pending` row (a setup claim before Allow)
  blocks no route and no other key's registration.
## A given computer (M3)

devices/given.ts. A PC or a second Mac set up from the giver dials the box and
listens on nothing.

- **The pins.** Setup calls `pinGiver({giver, box, boxKey, generation})`. The
  giver's signing key, the box, the generation and the box's bearer key go
  into this computer's vault as the bare secret `addon/~device-pins`. The saved
  box environment keeps its routes, but its key leaves the settings row
  (`sealed`, read back through `sealedEnvironmentKeys` in remote/environments.ts;
  `addEnvironment` takes `sealed: true`). The settings row `devices.given` holds
  only what each letter changes: seq, lease, the given rows and their grants.
  A letter is opened against the pins alone. Pinning sets `givenHost`.
- **The link.** On link up to the box, peer.register carries `proof`: the
  device key's signature over canonicalJson({nonce, from, keyId}), the nonce
  from `devices.challenge` (MacBridge's `proof` dep; no other link waits).
  Then an owed ack goes, then `devices.mail`; a `device-mail` push reads the
  mail again.
- **Apply**, under one lock: deny markers (`devices.deny.<service>:<account>`)
  for every given row the letter drops, and the rows it will write recorded
  as given; then the vault: each dropped row by the drop sequence (held out
  of routing, `rebootOnAccount` ends its handles at their next turn, the row
  deleted, the gateway's credential cache cleared, its generation-tagged files
  deleted); each static grant saved, each access grant's profile added with
  the box as owner and no secret; the snapshot rebuilt; then the commit; then
  the signed `devices.ack` with holds, own and paused. A refused letter is
  logged by seq and reason alone. A crash before the commit re-runs on the
  same letter, which the box hands out again; a crash after it sends the owed
  ack at the next link up; deny-marked rows still in the vault go at start.
- **Admission.** AccountSync's `admitted` is the committed grants, less any
  deny-marked one and any that matches a row this computer refreshes itself.
  A late pull, rotation or askOwner never lands a dropped grant, nor
  anything past the lease; the lease timer, which wakes early past the
  longest timeout, waits again for the lease's real end. The box's
  tombstones and lists prune given rows alone, and a given row is dropped
  by its recorded name (a repair may relabel its account).
- **Own rows** (there before setup) are listed in the ack's `own` and never
  touched; a grant whose account is already an own row is not applied. A
  given row is never pushed, exported, handed off, deleted by hand or made the
  CLI's live sign-in (AccountSync `givenRow`, the Accounts page's switch).
  Its link to the box (a device key) pulls and never pushes. A given row a
  local sign-in took over (a grant this computer refreshes: not static, not
  the box's) is its own from then: no letter, Stop or Remove drops it, and no
  box copy of its account is admitted. A given row's name is free of every
  row's name in any case (Windows keeps such names in one vault file).
- **The lease.** Past `leaseUntil` the given rows join AccountsService's out
  list (`held`, also in `outMarks` for the gateway), and the Accounts page
  says "Paused: <giver> has not been in touch since <date>"
  (`AccountsSnapshot.given`). A newer manifest lifts it.
- **Tagged files.** A given Muse account's config dirs live under
  `muse-accounts/given/g<generation>/` (and `muse-work/config/given/…`), are
  never recaptured into the vault, and go with `removeGivenMuseDirs`. A
  dropped Muse account's handles end before its files go and the drop is
  acked, a turn in flight stopped first (`SessionRegistry.endOnAccount`),
  since Muse's serve holds the credential in memory; Claude and Codex reach
  accounts through the gateway, whose cache is cleared.
- **Remove**: a `remove` letter, or the box's FAREWELL_CLOSE and then the
  letter from `POST /api/farewell {op: 'mail'}`. Journaled in `devices.wipe`,
  part by part: setup's steps stopped and those under way waited for
  (`SetupThisPc.halt`), every given row and tagged file, TempCode's LifeOS
  sign-in, then `givenSetupHooks.removeSetupFolders` (M6) and
  `lifeosReaderOff` (M5). The Work sign-in and the reader go only when setup
  made them (`devices.setup.gave`, devices/setup/gave.ts: the digest of the
  token setup saved, signed out through the running session only while it
  is the token held; the reader only when setup's own LifeOS sign-in turned
  it on). A part that fails runs again a minute later and at the next start,
  and no receipt is signed until every part is done. The
  receipt (device key over canonicalJson({removalId, envId})) posted to
  `/api/farewell` until the box records it (a 401 or 403 means the box already
  ended the key); then the box environment, the pins and the identity.
  A computer away when Remove was pressed hears it at its next contact: the
  box answers its `/api/ticket` 401 or 403, PeerLink's `onRefused` makes it
  ask `/api/farewell` (`onRefused` → `farewellMail`), and the wipe starts on
  the letter, or on the removal id when no letter is there, or with no
  receipt on a 401 (the box ended the key). "Not in farewell" changes
  nothing; a pending key is never asked. `lifeosReaderOff` on Windows writes
  `read: false` into `%APPDATA%\lifeos\purdue.json` (lifeosInstall.ts). Start
  fresh on a locked vault (`vaultStartFreshHooks`) forgets the same way, with
  no receipt; it moves a migration's half-made set aside with the vault
  (vault.key.next, secrets.next, secrets.old), under aliax-core's
  `vault.key.lock`, refusing while a live process holds it. The last step of
  both clears setup's progress, codes and record. The box binding and the
  LifeOS enrollment stay until the giver's Remove: the vault that could sign
  for them is gone.
- **The activate letter's codes** are saved before its seq is committed; a
  save that fails fails the apply, which runs again.
- A new generation drops every row the old one gave and every deny marker.

## The setup link (M4)

- **The link** is `<box origin>/setup#v1.<code>.<secret>` (shared/devices/setupLink.ts):
  a box pairing code and 32 secret bytes. From the secret come the bundle key
  and the Ed25519 link verifier (`deriveLinkKeys`). `https://` only; `http://`
  only under the harness marker (TEMP_CODE_USER_DATA). The secret never reaches
  the box; no log line, error text, settings row or push holds the link, the
  code, the secret or a LifeOS code (setupLink.test.ts "never logged").
- **The giver** (devices/setup/makeLink.ts, `devices.setup.make`): seals the
  bundle `{giver, box, items, workspaces, seeds}` with the bundle key, mints a
  setup pairing on the box (`remote.pairings.create` with `setup`, give), and
  keeps the secret in its vault (`addon/~setup-<pairingId>`) until the link is
  used, cancelled or ends (the sweep). `devices.setup.links` lists the open
  ones and those waiting for Allow.
- **The box** (devices/setupPairings.ts): a setup pairing has the pending caps
  and 15 minutes, and the `/api/pair` exchanges refuse it. `POST
  /api/setup/peek` answers the sealed bundle, `/challenge` a challenge of its
  own for each ask (16 live per code, in a rate bucket apart from the
  claim's), `/claim` checks the verifier's signature before anything is claimed,
  then the device's; then one transaction claims the code, mints the
  `pending` key, stores the claim and a `pending` binding, and the giver hears
  `device-joined {envId, pairingId}`. Every setup request counts against the
  address and the code (auth.ts's failure limiter). `/status` (the key's
  bearer) says `pending` or `active`. `GET /setup` is a static page with no
  script. A lost claim reply: the same device and identity, signing a fresh
  challenge asked after the claim, get the same key id under a new secret
  (the answer names the claim's own challenge, for the words); the box never
  keeps a token to hand out twice, and only while the claim is pending, the
  link open and the claim under five minutes old. The claim's own body
  replayed re-keys nothing, before Allow or after. While a claim may be
  recovered, `/peek` answers with the claimer's public key, so the PC that
  lost every reply goes on from the same link and another computer hears
  "used". A claim
  never binds the box's own env id, one it saved, or one registered under a
  key that is no device's (`taken`). The re-key checks the binding again
  after its hash, so an Allow that lands meanwhile is never re-keyed. Setup
  requests follow no redirect, the bundle's box origin must be the pasted
  one, and the box is saved only under the id the bundle pinned
  (`addEnvironment`'s `expectId`). A claim under a new identity for an env
  id whose removal waits on a receipt (Start fresh) ends that removal at
  once (`Farewell.finish`) and binds at the next generation. Cancel
  (`remote.pairings.revoke`) and the link's end take the pending
  key and binding with them in one commit; a retired row the claim replaced
  comes back. `devices.activate` asks `taken` again and commits the binding
  and the key's caps together.
- **The `pending` cap** reaches `/api/setup/*` alone over HTTP, opens no
  socket, and `capabilityRefusal` passes it only `devices.mail` and
  `devices.challenge`. `admin` never implies it. `devices.activate` makes it a
  device key.
- **Finding a claim.** The giver asks the box for the claim of each open
  link at the box link's next up, on a window's read and each minute, so a
  `device-joined` push it missed still raises Allow.
- **Allow** (`devices.setup.allow`): one attempt per link, written to the
  link's record before its first await: a second Allow is refused, Cancel
  waits for it and, once the computer joined, answers no; the enrollment
  LifeOS minted is on the attempt before the computer row; an attempt a
  crash cut short runs again at the box link's next up (`resume`), owing a
  revoke for an enrollment whose codes were lost. The giver checks the claim from
  `devices.setupProof` with the verifier its secret makes (an identity the
  box swapped in fails) and the device's signature, then shows the three
  words (`setupWords`, the same on both screens) in a `device-allow` push. On
  Allow: `devices.activate`, the computer kept with its `activate` letter (the
  box, the giver, and LifeOS's codes from `mintEnrollment` when given), the
  computer added to each chosen Work workspace's `mayUseDesktop` (here or over
  the box link), the secret deleted. The first manifest waits for the
  activate letter's ack (`firstManifestAfterAck`, `acked`), so it never
  supersedes the letter that carries the codes. Remove revokes those LifeOS
  enrollments through this Mac's Work session; one that fails stays owed in
  `devices.enrollments.owed`, past the box's retire, and goes again each time
  this Mac's Work reaches LifeOS (`revokeOwed`, `lifeosConnectedHooks`).
  LifeOS lets any live, all-sector, non-enrolled TempCode or app session of
  the owner revoke, so a re-paired Work session can. The debt is written
  before the box hears Remove. `auth:enrollCreate` and `bots:mint` from a
  TempCode session need its own device token beside the JWT
  (`LifeosSession.localProof`), so a JWT a remote window holds mints nothing
  lasting (bots:mint enforces it once LifeOS's `f02-enforce-bots` lands,
  after a TempCode release that sends it). A given Claude grant carries only
  `keychain`, `oauthAccount` and `tokenKind` (`givenBlob`, after aliax-core's
  `forTransfer`): never the desktop app's session cookies. An activate, stop or
  remove letter is saved sealed with its state and seq before the box is
  asked (`unsent`), and posted again
  at the box link's next up and on Retry (`catchUp`), which also releases the
  first manifest when the box holds the activate letter's ack.
- **The giver record follows a re-pair:** once its key is revoked, a claim
  from a new admin key with a proof by the giver's identity
  (`giverMoveBytes`) moves it.
- **A removed install set up again** comes back only under a new identity at
  a higher generation (binding.ts `readmits`); the box gives the claim
  `nextGeneration`.
- **The computer being set up** (devices/setup/useLink.ts): `devices.setup.peek`
  opens the bundle and moves nothing; it refuses a link while this host is
  set up (another giver or box, or the same) and a box already saved here
  with its own key. `devices.setup.start` claims, pins the giver and box with
  the pending key (given.ts `pinGiver`; the key lives in the pins alone until
  Allow, when the box environment is saved sealed), then reports each step as
  a `device-setup` push: link, allow (with the words), accounts (the first
  manifest applied), lifeos (Windows only, `installLifeos` with the activate
  letter's `desktop` code), work (`signInWork` with the `tempcode` code),
  folders (`devices.setup.folders` → `addSetupFolders`). LifeOS's codes wait
  in the vault (`addon/~setup-codes`) until every step is done, with the
  Work redemption's `attempt`, saved before its first try: Retry sends the
  same one, and LifeOS answers a lost reply again for the same session
  (LifeOS 132f18c). The LifeOS step hands its code only to LifeOS 0.1.10 or
  later (`MIN_ENROLL_VERSION`, the first release that answers the enroll
  file): an older one is installed over from the checked feed, a feed still
  older fails the step in words, and the program run is where its folder
  really leads, never through a link out of the user's programs folder.
  `devices.setup.state` answers the steps, the words and the seeds (appearance
  and default models, for the window to write once); the Work switch is set
  to the giver's. A link that ends before Allow drops the pins
  (`GivenComputer.abandon`). No platform rides the flow: a second Mac gets the
  same steps less LifeOS's install.
- Accounts → Refresh on a given computer polls its own rows and never asks
  the box (`accounts.refreshLocal` is refused to a device key); the box's
  own sweep keeps the copies it hands out fresh.

## The proof (M3)

`bun run script:e2e-given-computer` (scripts/e2e-given-computer.ts; build
first): three isolated headless instances on the box with the fake provider:
a giver playing the Mac, a stand-in box and a given computer. Until the setup
link (M4) exists, the local `devices.proof` seam (TEMP_CODE_E2E_DEVICES=1,
isolated only) does its part: the giver binds and activates a computer, the
computer pins the giver and adds the box sealed, a letter is posted or fed in
again. `TEMP_CODE_E2E_APPLY_CRASH=<deny|reconcile|commit>` kills an isolated
given computer (SIGKILL) after that apply step. Its checks: a static account arrives
and routes; Codex arrives as an admission, its copy and a rotation come from
the box with no refresh token; a removal on the giver reaches the computer;
Stop empties it and Start fills it; a replayed letter is dropped by the box
and by the computer; a crash after the deny markers finishes the same letter
at the next start; Remove wipes the computer, the box records the receipt
and the key gets 401. The run of record is
.temp-code/plans/landed/pc-setup/given-computer-proof.md.
## The screens (M4)

Every name the window calls lives in one module, `src/renderer/src/lib/devicesClient.ts`:
`devices.computers` and `devices.computer`, the setup methods (`devices.setup.make`,
`.cancel`, `.allow`, `.deny` on the giver; `.peek`, `.start`, `.state`, `.retry`,
`.folders` on the computer), and the pushes `device-acked`, `device-joined`,
`device-gone`, `device-allow` and `device-setup`. All are local; the web page shows
none of them. The link rides request bodies alone and lives in component state
until the setup starts. Shapes: `SetupItems`, `SetupStep`, `SetupPeek`,
`SetupState`, `SetupSeeds`, `ComputersAnswer` in contract-devices.ts.

- **Computers** (Settings → Hosts, under Clients; `surfaces/settings/hosts/Computers.tsx`).
  The giver's row ("Giver"), the box's row (what it holds, from the giver's rows
  alone, `boxHolds` in giverDevices.ts, and the box link's `lastSyncAt`; no
  actions), then each given computer: what it holds by provider ("2 Claude, 1
  Codex"), paused, when it synced, Stop or Start, Remove behind a confirm. While
  a removal waits the row says "Waiting for <name> to be in touch" and has no
  actions. A refusal is the row's red line. Read again on each computer push.
  The heading's verb is **Set up a computer…** on the giver (its saved box key
  is the giver record's, `isGiverHere`) and **Use a setup link…** anywhere else.
- **Sign in to LifeOS** (work/shell/settings.tsx) offers the device token
  field for the window's own host alone: `setToken` is local-only.
- **Set up a computer…** (`dialogs/SetupComputerDialog.tsx`): Name; Link to the
  box (ticked, not his to untick); Your accounts; LifeOS signed in, off with a
  tip while this Mac's Work is not signed in (`work.lifeos.status`), and Outlook
  and Teams reader under it; Folders in Files with each Work workspace, all
  ticked. **Make link** shows the link with Copy and "Ends in m:ss"; Cancel
  withdraws it (`devices.setup.cancel`), Done and Escape keep it.
- **The Allow notice** (`chrome/ComputerAllowToasts.tsx`, with the first screen in
  `surfaces/setup/SetupHost.tsx`, the `setupHost` chunk App mounts on the desktop; none of the setup's
  modules is in the first paint, `NEVER_IN_ENTRY` in scripts/check-bundle-size.ts): on
  `device-allow`, a held toast "<name> wants to join", the three words, Allow
  (`devices.setup.allow`) and Remove (`devices.setup.deny`).
- **On the computer** (`surfaces/setup/`, the `setup` chunk): one dialog that
  goes from the paste ("Paste the link from your Mac", Continue, and Skip on
  the first screen or Cancel from Settings) to "From <giver> at <host>: link to
  the box, …" with **Set up this PC** (this Mac on a Mac) and Cancel, then the
  steps, then **Ready**. Each step row shows its state; a failed one says its
  reason in red with Retry; the Allow row shows the three words until it is
  done; Folders in Files offers **Add folders…** (the native picker, several at
  once, `pickFolders` in lib/fs.ts) once Allow is done. The steps follow
  `device-setup` and read `devices.setup.state` again after a Retry or a pick.
- **The first screen** (`SetupFirstRun.tsx`): opens by itself once, on a fresh
  install (no saved hosts, no workspaces, no accounts; `isFreshInstall`), and
  at every launch while a setup is under way, on its steps. Closing it sets
  `monocode.setupOffered`.
- **Seeds**: the first state that carries them writes the theme per kind of
  place and the default models into the window's storage once
  (`writeSeedsOnce`, marked by `monocode.setupSeeded`), then applies the theme.
  The Work switch is the host's to set.
- **Previews**: `Computers.tsx#ComputersBlock`,
  `dialogs/SetupComputerDialog.preview.tsx#SetupComputerPreview` and
  `surfaces/setup/UseSetupLink.preview.tsx#SetupLinkPreview`, each with its
  fixtures beside it; the two dialogs draw their real body in the Modal's box.

## What moves to a computer

| Item | PC or second Mac | Why |
|---|---|---|
| Claude one-year tokens, Muse login, Meta keys | In the sealed manifest, after Allow | static grants with no refresher; the giver's file is the truth |
| Codex | Admitted by the manifest; access copies from the box | the box refreshes it; no refresh token leaves it |
| Add-on OAuth and typed grants | Not given | a grant follows a registry row an admin host can rewrite |
| Cursor | Never | its IDE keeps its own tokens |
| Add-ons (registry), skills | Already sync from the box's store | unchanged |
| Rules, thread defaults, project settings, linked projects | Already sync | the box is home; a new computer never seeds over it |
| Harness settings | Never | POSIX paths; the box refuses a Windows home |
| Memory | Off on Windows | POSIX path map; less Purdue exposure |
| Away | Already syncs | unchanged |
| Appearance, default models, the Work switch | Written once by the link | per window, per host |
| LifeOS sign-in (LifeOS app and TempCode's Work) | Two enrolled sessions made for that computer after Allow | never the Mac's own token |
| Outlook and Teams reader | Reading on (Windows); sending stays his switch | his own Outlook and Teams sign-ins stay his |
| Folders in Files | Picked on the computer (Add folders…) | the paths are its own |

## The rig run (M7)

`bun scripts/e2e-pc-setup-rig.ts --installer <release-win's temp-code-1.0.N-setup.exe>` runs the whole setup in
the Windows rig from a fresh install as tcuser: stand-ins on the box (scripts/lib/pcRigStandins.ts: a headless box,
a windowed Mac that is the giver with two dummy Claude accounts and the box's lent one-year Claude token, a fake
provider, LifeOS's feed; every instance with an empty `WINVM_DIR`), J: mapped from a user-space SMB share through
`up.sh --guestfwd 10.0.2.100:445=44500`, the link made in the Mac's dialog and pasted on the PC, Allow with the
words matching, every step, a Sonnet turn on the lent account, LifeOS against a local backend
(`TEMP_CODE_LIFEOS_URL` and `TEMP_CODE_LIFEOS_FEED`, honoured under the harness marker alone), J: listed and a file
opened from the Mac's window through the box, a removal on the Mac, the vault copied to a second user
(scripts/win-vm/dpapi-try.ps1, a task with the batch right on the throwaway overlay) and Remove. It needs a local
LifeOS backend on :3330 and the SMB share on :44500 running (the script's header). The run of record, with its
pictures and times, is .temp-code/plans/landed/pc-setup/rig/.

What the run showed that setup does not do: the PC's bridge for the box stays Off, so the box cannot read J: until
he sets Settings → Hosts → Mac bridge for the box → Access → Read on the PC; and Add folders… opens the native
picker, which the run did not drive (it sends the same pick through `devices.setup.folders`).

