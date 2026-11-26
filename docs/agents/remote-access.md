# Remote access: the fixed port behind the tunnel

- A second listener (src/main/server/remote/listener.ts) binds
  `127.0.0.1:7677` by default; the Cloudflare tunnel on the box maps
  `tempcode.landonhale.com` to it, TLS ends at Cloudflare, and
  `CF-Connecting-IP` / `X-Forwarded-Proto` are believed only from a loopback
  socket. The renderer's random-port loopback socket is unchanged and stays
  implicitly admin.
- `docket.landonhale.com`, the app's new name, answers beside the old one,
  which stays live for good. Both reach the same rules in the same order
  (scripts/box/ingress.yml), and every check that takes one public name
  takes the other the same way: one rule, `hostAliases` and `originAliases`
  in src/shared/publicHosts.ts. tempcodeOrigins.ts applies it when it
  matches, so the browser's Host check, the `/ws` upgrade, linked peers'
  names and the computer tools' self-guard (which refuses both) all see
  both names, and a peer's announcement stays as it is. `learnedOrigin` is
  not moved by a request through the other name, so pairing links keep the
  name they had. What is made from now on says `docket.landonhale.com`: the
  Work service's box origin (`BOX_PUBLIC_ORIGIN`, work/service/config.ts),
  forms' links, the guest links' fallback and the hosted pages' health
  probe. `remote.publicOrigin` is the owner's setting, set on the box by
  hand; links, keys and paired phones made under the old name keep it and
  keep working. `share.landonhale.com` is no alias.
- `TEMP_CODE_REMOTE_PORT=<n>` overrides the port for a dev instance (so it
  never fights the installed app for 7677); `0` turns the listener off. The
  settings `remote.enabled`, `remote.port`, `remote.publicOrigin` live in the
  settings table. Settings edits them under Advanced: this Mac's on Sharing (Let other
  devices reach this Mac, Port, Web address), another computer's on its own page. A port in
  use logs one `[remote]` line and leaves remote off; `remote.status` carries
  the error. `TEMP_CODE_REMOTE_TRACE=1` logs one line per request.
- Identity: `<userData>/environment.json` holds `env_<22 chars>`, created
  once and never copied with the database. Every socket's first frame is
  `{ push: 'hello', environmentId, contract, caps, key? }`.
- Keys (remote/auth.ts): `tc_<id>.<secret>`, scrypt at rest, each with an
  audience (`client` for phones, browsers and desktops on `/ws` and `/api/*`;
  `mcp` for bots on `/mcp`, capped at read,operate) and a capability set from
  read | operate | approve | admin | give | device. Every RPC has a row in
  src/shared/capabilities.ts (`local` rows, every `app.*`, lsp, dap, idea,
  providers.update, fim and stall.report, never run for a remote caller);
  `session.create` with `permission: 'auto'` and `session.permission` need
  approve. The gate is `capabilityRefusal`, run in `attach()` before any
  handler and again on every relayed lane (remote/relay.ts).
- **`admin` never implies `give` or `device`** (docs/agents/pc-setup.md).
  `give` is credential control: `accounts.push`, `.confirm`, `.released`,
  `.removed` and a pull with `takeOver`. No key row stores it: the box's
  giver record names one key (devices/giver.ts), and that key acts with
  `give` while the record stands. The Mac claims it on its first link after
  the upgrade (`devices.claimGiver`: none set, an admin key made before the
  upgrade stamp `devices.upgradeAt`; that first boot also ends every older
  pairing offer); only `tc-local devices.setGiver` on the box moves it. The
  box's admin keys on 2026-11-23: one, the Mac's.
- **`device`** is a given computer's key: its admin-tier calls are the
  `DEVICE_METHODS` allowlist (its peer link, presence, relayed lanes,
  forwarded ports, cross-host reports, the account pull and headroom, the
  rules exchange, its letters), `DEVICE_REFUSED` is refused whatever else
  it holds (LifeOS tokens, add-on grant writes, `linear.setToken`), and the
  rest follow its other caps (operate, approve), so its window still runs
  box threads. `peers.ts` opens a link for an admin or a device key.
- **Setup links** (docs/agents/pc-setup.md): `<box origin>/setup#v1.<code>.<secret>`. The box holds
  the pairing code, the link verifier's public key and the sealed bundle, never the secret; `/setup` is
  a static page with `script-src 'none'`; `/api/setup/peek`, `/challenge`, `/claim` are their own
  exchange (the legacy `/api/pair` refuses setup rows), rate-limited by address and by code, and the
  claim is checked against the verifier before it is made. A claim mints a `pending` key, good only
  for `/api/setup/*` and its own letters for 15 minutes, which the giver's Allow turns into a `device`
  key. **Farewell**: a removed computer's key gets close code 4010 (not 4001, so it retries) and from
  then reaches only `POST /api/farewell`, for its last letter and its signed receipt.
- **The destination decides.** A relayed lane's principal carries `via`
  (relayServe.ts); its host runs a request only when RELAY_METHODS carries
  the method, whatever caps the box named (devices/hostRules.ts
  `relayedRefusal`). `work.lifeos.setToken` is local-only. On a given
  computer `GIVEN_HOST_LOCAL` (the LifeOS session, every credential method)
  is refused to every remote principal.
- A host numbers its `relay.frames` batches per lane. If the ACK goes
  missing, the host retries with the same number and the box ACKs it
  without forwarding the frames twice. Older hosts can still send
  batches without a number. Phone requests use the existing relay path.
- `work.reveal` is a `screen` call to the destination host. It checks
  `approve`, the saved destination's read fence and `admin` for admin pages.
- The path fence (remote/fence.ts, R2 H1/H2): for every remote principal,
  each method that names a path or cwd (`fs.*`, `git.*`, `github.*`,
  `search.project`, `workspace.create`, `session.create`'s cwd, logo and
  command-list paths) must point, by real path, under a project cwd, a
  workspace path or the configured/box work root (never the bare home
  directory); the refusal is `forbidden: <method> is outside app-managed
  roots` and never logs the path. Roots are resolved too, so a root saved
  by an old name (`~/.temp-code/worktrees/…`, a link to `~/.docket` since
  the move, [docket-data-move.md](docket-data-move.md)) admits its files. The loopback socket is unfenced. Nothing
  was demoted to `local`: the /ui bundle and the desktop's remote-host
  flows call the whole donor family, and the phone calls `fs.readPreview`,
  `search.project` and `github.*`. `fence.test.ts` asserts every
  path-taking contract method has a row. A Work method (`work.*`,
  `app.work*`) has no path param of its own: a file reaches it inside a
  `CanvasSource` (`{ at: 'file', path }`, or a Microsoft file's `ref:
  { kind: 'path', path }`), anywhere in its params, and `session.create`
  carries one in `about`. Which roots judge such a file turns on the host
  its source names: [The Work fence, by the host a source
  names](#the-work-fence-by-the-host-a-source-names) below. A Work
  workspace names no folder, so `workspace.create` fences only a path it
  is given. Inside the roots one directory
  is denied to every remote file method: the computer history
  (docs/computer-protocol.md §17.9), by a path named outright
  (`fenceRequest`'s `denied`), by one named through a project id or
  inside a `cwd`, and by a copy or a move whose source holds it
  (`fenceDenied`, which covers `file.read` too and reads each string of a
  request normalized, as the handlers will, whatever its length or
  lines); `fsMedia` and project search leave it out for every caller.
- Pairing: an admin makes a code (`XXXXX-XXXXX`, 10 minutes, single use) in
  the pane or over `POST /api/pairings`; the link is `<origin>/pair#<code>`.
  `<origin>` is the host's public origin, else the one it learned, else
  `http://127.0.0.1:<port>`. Add a computer…'s device way
  (`surfaces/settings/computers/device.tsx`) asks the computer's `remote.status`
  first and builds the link and its QR on the outside origin alone (Web
  address, else the one learned from the tunnel: `outsideOrigin`, `pairLink`).
  With neither it says so before the link is made, in one muted line ("Other
  devices cannot reach this Mac yet. Set its Web address in Sharing, under
  Advanced."), and offers the code with Copy code, no link and no QR. The host does not tell
  an address on the local network alone from one on the internet, so the
  dialog says nothing of an address's reach. Only where the host did not
  answer its status does the dialog show the host's own link, and say in one
  line when it is a loopback address that opens only there. The dialog is
  "Sign a device in to <computer>": Name; For (a device, or a bot: then the
  dialog is "A key for a bot", offers the two levels a bot may hold and says
  why in one line, and makes a key instead); It may (Look only `[]`, Run
  threads `[operate]`, Run threads and approve `[operate, approve]`, Manage
  <computer> `[operate, approve, admin]`, which asks first); then the code,
  its QR, Copy link, "One use. Ends in 10 minutes." (whole minutes, rounded
  up) and Cancel the link (`remote.pairings.revoke`). It is made on the
  computer the title names, over that computer's own link (`hostRequest`), so a
  key here that holds `admin` on the box makes the box's sign-ins
  (`openAddComputer({ way: "device", computer })`).
  Redemption claims the row in one conditional UPDATE before minting, so
  concurrent redeems answer one key (R2 M1). The link's origin is learned
  only from an admin's own authenticated request, never from the Host of an
  anonymous loopback request (L1); `/api/hello` without a key answers only
  the environment id and contract (L2); the `/pair` page's script and style
  run under a per-response nonce, the policy on the meta tag and the
  response header alike (`pairPageCsp`), no `'unsafe-inline'` anywhere (L3).
  `POST /api/pair` with `kind: 'key'` answers the raw key once, and keeps
  what paired it when the body says (`client: 'desktop' | 'phone'`, the
  `remote_keys.client` column, `Principal.client`): the desktop's
  `pairEnvironment` says `desktop`, the phone says `phone`, and a key from
  before says nothing. Only `video.size` reads it (a phone's key never sizes
  the Windows VM, live-video.md "The size ask"); with
  `kind: 'session'` it sets the HttpOnly `tc_session` cookie that `/ui` and
  cookie upgrades of `/ws` use. The page (remote/pairPage.ts, on the app's
  tokens: `PAIR_TOKENS`, held equal to index.css by its test) shows the
  link's code and one Pair button, redeems nothing on load and strips the
  fragment before its first request; a bot pairing is refused a session
  before its code is spent (`SESSION_NEEDS_CLIENT`, 400), so the page
  redeems it as a key and shows that once with Copy. Any 401 reads one
  sentence: the wire never says whether a code existed. Bearer clients mint a 30 s ticket at
  `POST /api/ticket` and upgrade `/ws?ticket=…`; nothing else ever rides in
  a socket URL but a live video stream's own single-use ticket
  (`/video/<stream>?ticket=…` for a viewer, and
  `/video-publish/<id>?ticket=…` for a machine of his sending a window's
  video up to this host, which it does only when this host asked it over
  the peer link; [live-video.md](live-video.md)). Revoking a
  key closes its sockets, its sessions and its video streams at once.
  A key may also mint its next ticket over its own socket, `remote.ticket`
  (capability `read`, what `/api/ticket` gives it; refused to this
  machine's sockets, a cookie session, a relayed lane, a bot key, a pending
  key and a key in farewell: remote/windowTicket.ts `socketTicket`); a host
  that has it names `remote.ticket` in its hello's features. `/api/ticket`
  answers `Server-Timing: mint;dur=<ms>, loop;dur=<ms>` (its own time, its
  loop's worst lag that second).
- A window's ticket to a saved host (`remote.environments.ticket`, asked of
  this machine's own server) goes first over the socket this host already
  holds to that host (the peer link, same saved key), and `POST
  /api/ticket` starts beside it when the peer has not answered in 500 ms or
  failed; the first ticket back is used (windowTicket.ts `windowTicket`;
  the route is checked against the saved row first, either way). A given
  computer's window still asks its box over the proved socket
  (`devices.ticket`). Each ask writes one stall line: `ticket env= via=
  ms= wait= peer= https= connect= answer= box= boxloop= outcome=`: `wait`
  is the window's wait for this machine's own link, `connect` DNS, TCP and
  TLS (`reused` on a kept socket, from undici's diagnostics channels),
  `answer` the request out to its headers in, `box`/`boxloop` from the
  box's `Server-Timing`. Why: from his Mac 16 asks in a day passed 500 ms,
  11 passed 1 s and two met the 4 s deadline, each a reconnect that
  waited; one met a 2.6 s block of the box's loop (the box's stalls.log at
  the same second), two fell in the Mac's dark wakes, and the rest were the
  cold HTTPS setup through the tunnel on Wi-Fi.
- `/ui` serves the BUILT renderer (out/renderer, so `electron-vite build`
  first in a dev tree) behind the cookie; the bundle detects a missing
  `window.api` and runs in web mode (src/renderer/src/lib/nativeWeb.ts: no
  terminal, no Aliax pages, its own `web` workspace slot). A desktop-only
  control goes through `desktopOnly(handler)` (undefined at /ui, so its row
  is not drawn: the terminal's entry points, Choose logo…, the Updates
  row, the rail's Accounts and Stats, every Reveal row; a settings section
  or keybinding group marked `desktopOnly` in lib/settings.ts, Appshots and
  Terminal, is left out of the list); a desktop-only surface reached anyway
  (a stored Appshots route) shows `DESKTOP_ONLY_LINE`
  ("Available in the desktop app") in `Empty`; Open project browses the
  host's folders (`folderPickOn` in lib/fs.ts), titled with the caller's act
  ("Open a project on the box", `remoteFolderTitle`); the page's one host
  takes its own name from its hello (`Hello.name`, `webEnvironmentNamed` in
  lib/connection/registry.ts), never the page's address; a native ask is the app's
  confirm dialog (`askRequest` → `confirmAction`) and a native message a
  sonner toast, never the browser's confirm or alert. A signed-out tab: `/ui`
  answers a refused cookie `302 /pair?signed-out` (no cookie: `/pair`), and
  the cookie route asks `/api/hello` before its socket (`checkCookie` in
  lib/connection/registry.ts; a hello without `key` is `unauthorized:
  signed out`), on which tcserver/link.ts replaces the page with
  `/pair?signed-out`. `/asset/<host>/…`
  mirrors `tempcode-asset://` for logos, media and agent pages.
- A window's link (lib/connection/supervisor.ts): the host's ping finds a
  silent socket only at its third 30 s tick, so a visible window beats its
  own heartbeat. When 10 s pass with no frame in, it asks `away.get` (from
  memory, no effect, `read`); 5 s with nothing at all in after the ask is a
  miss, and two misses in a row close the socket (`local`) and redial at
  once: a dead link is found 20 s after its last frame. Any frame counts,
  a push or part of a long answer. A hidden window sends no heartbeat
  (`ConnectionRegistry.setVisible`, from the window hooks), and coming on
  screen probes as before. A dial that reached no hello, or a socket the
  link took (no close code of the host's own), waits at most
  `VISIBLE_RETRY_MS` (2 s, jittered) for its next dial while the window is
  visible, so the link's return is met within that, not after a doubled
  backoff; a hidden window keeps the 1 s to 5 min backoff, and a host that
  pushed back (1008, 1011, 1013, 4xxx) keeps it in either. A redial never
  sends a write again: a press cut by the close fails with
  `connection closed` (registry.test.ts), and only `SAFE_READS` are asked
  again (link.ts).
- Webhook targets (remote/addressGuard.ts, R2 M3): a key's webhook URL and
  a hub subscription URL must be https to a public host; loopback, RFC 1918,
  CGNAT, link-local (169.254.169.254), v6 unique-local/link-local, `.internal`,
  `.local` and bare names are refused when made, the host is resolved then,
  and each delivery pins the socket's lookup to re-checked addresses (the hub
  resolves over DNS-over-HTTPS before every POST). `TEMP_CODE_WEBHOOK_ALLOW_LOOPBACK=1`
  admits a 127.0.0.1 receiver for a proof script; nothing else private, ever.
- Proof: `bun run script:e2e-remote` (the bearer flow against a temp
  server), `bun run script:e2e-remote-fence` (in the release gate: the fence
  for a read and an operate key on every path-taking method, the concurrent
  pairing redeem, refused webhook targets, the learned origin, the anonymous
  hello and the pair page CSP) and `bun scripts/e2e-remote-ui.ts` (an
  isolated preview instance plus a real Chrome profile over CDP through
  `/pair`, `/ui`, a thread, a reply, the cookie and the CSP rewrite).

## Guest pages share nothing with `/ui`

The session cookie (`tc_session`: HttpOnly, `SameSite=Lax`, `Path=/`, set for
this hostname alone) and the `/ws` origin check both pass for any page of
this origin. Guest pages and the owner's hosted editor were pages of this
origin (the tunnel sends `^/(g|w|f)/` to the Work service). They now have a
hostname of their own, `share.landonhale.com`, served by the Work service
alone: no route of this listener answers there, the cookie is never sent to
it, and a socket here from a page of that origin is refused by `/ws`'s own
check. Once the host's `work.guests.origin` is set, a guest's address asked
for on this hostname answers 308 to the same path there
([work-guests.md](work-guests.md) "The guest origin").

## The Work fence, by the host a source names

This is the one account of it; work.md, work-teams-files.md and CLAUDE.md link
here. The code is `fenceRequest` in src/main/server/remote/fence.ts, called
by the listener with this host's own id as `self` (server/index.ts, the id
Work calls `ctx.host`).

- **What is read.** `workSources` collects every `CanvasSource` in a Work
  request's params (`session.create`: in `about`; its `items`, a draft's
  folded first send, are fenced step by step as the `work.office.filesCopy`
  and `work.canvas.open` the host runs for them, src/main/server/createSteps.ts,
  and its `attachments` as a `session.send`'s), each path with the
  `host` its source names (null when it names none); `workSourcePaths` is
  the same list, paths alone. It reads `SOURCE_DEPTH_MAX` (64) levels deep;
  a deeper request is refused whole, never passed unread. A sheet's edit of
  a rich-text cell goes past 12, which once refused every such edit from
  his Mac's window. fence.test.ts holds both: the rich
  cell passes, the deeper request fails.
- **Each path is judged alone**, and passes one of three ways; one that
  fails refuses the whole request.
  1. *In this host's Windows VM* (`guestPath`): a guest path (`C:\…`, no
     `/`) in a verb `GUEST_METHODS` lists, on a host that is not Windows.
     The handler holds it to a library OneDrive syncs in the guest
     (work/files/policy.ts `locate`, office/files/handle.ts `admitted`).
  2. *On another host* (`elsewherePath`): the source's `host` is a host's
     id (`ENVIRONMENT_ID`: no other word, no `:`) and not `self`, in a verb
     `ELSEWHERE_METHODS` lists. No path of this host's disk is opened. The
     verbs, one at a time:
     - sent to the host it names: `work.office.filesCopy` (the bytes come
       over the host link, `copyIn`; that host holds the path to a library
       it syncs), `work.files.open` (the same copy, `openCopy`),
       `work.files.across` (a listing from that desktop; refused for this
       host), `work.files.saveAs` and `saveAsWord` (that host makes
       the file in its own folder through its own door), and
       `work.files.trash`, `rename` and `move` (sent to that host on his
       press, a move only inside it: work/files/across.ts; `restore` names
       Trash ids, no path);
     - kept or matched as words alone: `work.office.filesThreads` and
       `work.files.threads` (matched against the canvas's items),
       `work.files.tabOpen`, `tabSet`, `star` and `seen` (a tab or a mark
       keeps its address), `work.office.live.address` (matched to that
       host's list of libraries), and `work.files.copiesMoved` (re-points
       the workspace's records of that host's file; refuses this host's).
  3. *Otherwise* by the roots and the denied directories, as any path
     param: a source with this host's id, with no host, with no `self`
     given, or in any verb not listed (`work.canvas.*`, `filesList`,
     `filesRead`, `filesFetch`, `filesOpen`, `work.files.list`, `stat`,
     `fetch`, every change), whatever host it claims. The roots a remote key
     is fenced by are the managed roots and each Word file's kept document
     in the hidden Word store, file by file (server/index.ts `remoteRoots`,
     work/files/imports.ts `wordStoreDocs`): the documents it reached in a
     workspace's folder before the store took them, and nothing else of the
     app's data. The Mac bridge's roots stay `managedRoots`, without them.
- A verb that reads or changes a file here is never on either list; moving
  the depth, a list or a root is a rule change, not a fix. Proven by
  fence.test.ts, the "his window on the box" tests in
  work/office/files/files.test.ts, and live by
  `scripts/e2e-files-open-remote.ts`.
