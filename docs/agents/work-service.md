# The Work service

The Work service is the utility process that serves live editing: documents
and sheets (sheets: [work-sheets.md](work-sheets.md)), published forms
([work-forms.md](work-forms.md)), guest links, the Office add-in and the full editor. Milestone 18 built it; the contract is architecture
§8.1 to §8.3 and §19 (`.temp-code/plans/work-architecture.md`).

## The process

- `src/main/workServiceProcess.ts` is the entry (`out/main/workService.js`,
  the `workService` build input). It runs `startWorkService`
  (`work/service/serve.ts`) and talks to main over its parent port
  (`work/service/wire.ts`).
- `work/service/supervisor.ts` forks it inside `deps.whileOn`, so it runs
  only while Work is on. A child that dies or does not answer in 20 s is
  started again after 1 s, doubling to 30 s; the wait starts over only once
  a child has stayed up a minute. A spawn that throws is logged and tried
  again. Nothing in main waits on it, so a faulty service never stops the
  host. Turning Work off stops it and removes its socket and secret. Starts
  and stops run one after another, so a quick off and on leaves one child
  and its own files.
- It opens neither the app's database nor the vault, and imports no
  Electron (`work/service/boundary.test.ts` walks its imports). Main sends
  it a config at start: the port, the socket path and secret, its own data
  folder, `out/hosted`, which host serves LifeOS documents, the trusted
  issuers' public keys and the guest link rows. The signing key stays in
  main: the process the tunnel reaches cannot mint a token. Pushes that come
  while it starts are applied before it says it is ready. It asks main for a LifeOS JWT
  (`ctx.lifeos.jwt()`, the owner's whole session) when it needs one and keeps
  it until a minute before it runs out. Main pushes link rows
  (`supervisor.setLinks`) and trusted issuers (`refreshTrusted`) as they
  change.
- One service per store (§8.1, §19). `config.ts` `lifeosServerOf`: a Linux
  host serves LifeOS documents; a host with a saved Linux host is that
  host's client; a host with no box serves them itself. An isolated
  instance (`TEMP_CODE_USER_DATA`) serves none, so a dev instance is never a
  second writer to the owner's documents, unless
  `TEMP_CODE_WORK_LIFEOS_SERVER` says `here` (or names the host that does). A client host refuses a LifeOS document's socket, answers
  `/internal/doc/read` with the stored projection (`stored: true`), and
  refuses writes with the name of the host that serves them. A `.tcdoc` is
  served by the host it is on.

## Where it listens

| What | Where |
|---|---|
| Public listener | `127.0.0.1:<port>`. `TEMP_CODE_WORK_PORT`, else 7695 for the installed host, else any free port for an isolated instance |
| Internal routes | Unix socket `<userData>/work-service.sock` (0660); every call carries `Authorization: Bearer <secret>`, compared in constant time |
| Secret | `<userData>/work-service.secret` (0600), new each time Work turns on, removed when it turns off |
| Its own files | `<userData>/work-service/journal/`: each document's update segments and its `.book.json` (who wrote what) |

On the box, userData is `/srv/agents/temp-code-data`, where the LifeOS worker
looks (`WORK_SERVICE_SOCK`, `WORK_SERVICE_SECRET_FILE`; M17). A userData path
too long for a socket (over 100 bytes) puts the socket in the temp dir under
a hash of the path; the secret stays in userData.

## Routes

`work/service/routes/index.ts` is the closed list. The public listener
answers these paths and nothing else (404); `/internal/*` is not among them.
Each milestone filled its own file and edited no other; every route is
built. A route still to come is a `stubRoute` (route.ts): it answers
`not built: <what> (milestone N)` with 501, and refuses a socket.

| Route | File | Milestone |
|---|---|---|
| `wss …/w/doc/<docId>` | `routes/doc.ts` | 18, built |
| `GET …/w/hosted/*` (`out/hosted`) | `routes/hosted.ts` | 18, built |
| `wss …/w/sheet/<sheetId>` | `routes/sheet.ts` | **27, built** |
| `GET`/`POST …/w/open` (the owner's hosted editor) | `routes/item.ts` | **31, built** ([work-guests.md](work-guests.md)) |
| `…/g/*` (guest links) and internal `/internal/guests/seen` | `routes/guests.ts` | **31, built** ([work-guests.md](work-guests.md)) |
| `wss …/w/office`, `GET …/w/addin/*` | `routes/office.ts` | **29, built** (work-office.md, "The add-in") |
| `GET`/`POST …/f/<publicId>` (published forms; [work-forms.md](work-forms.md)) | `routes/form.ts` | **36, built** |
| `…/w/full/<token>/*` | `routes/fullEditor.ts` | **40, built** ([work-sheets.md](work-sheets.md) "The full editor") |
| internal `/internal/doc/{read,write,create,comment}` | `routes/internal.ts` | 18, built |
| internal `/internal/sheet/{read,write}` and main's `/internal/sheet/<op>` | `routes/internalSheet.ts` | **27, built** |

A socket upgrade is refused (503) past 512 open sockets, or 48 from one
caller, counted by the tunnel's `CF-Connecting-IP`, else the peer's address:
the owner's own editors on this host share one bucket, and so does
everyone behind one home address. A socket message may be
4 MiB at most.

Every public answer carries `Cache-Control: no-store`, `nosniff`,
`no-referrer`, `X-Frame-Options: DENY`. A hosted file also gets a CSP of its
own origin's scripts and styles and `frame-ancestors 'none'`; a page's meta
CSP can only narrow it.

The internal document routes take the bodies M17's worker sends
(`.temp-code/plans/landed/M17.md`, "The loopback routes"). Each reads the row
with `docs:get` as the owner and answers 404 when the body's `fence` does not
hold its sector. Writes are credited to `agent:<origin.host>:<origin.threadId>`,
or `lifeos:bot:<botId>` with no origin. A 4xx answer's `error` is words for
the bot; anything else is logged and answered "the Work service failed;
nothing changed".

- `read` → `{markdown, plain, seq}` from the live document.
- `write` → `{mode: 'direct', versionId?}` or `{mode: 'branch', branchId,
  versionId}` (milestone 19, [work-history.md](work-history.md)). An agent's
  own change (`because: 'own'`) to a shared document goes into that agent's
  branch and the live text waits; every other write is direct and cut as a
  version, with a "before agent" version first on a shared document.
- `create` → `{docId}`: `docs:create` with no seed, then the creator's own
  write, stored at once.
- `/internal/history/*` (list, compare, cut, restore, branches, decide) are
  history's, in `work/history/serviceRoutes.ts`; see work-history.md.
- `comment` → `{threadId}`: `docs:createThread` (the body wrapped as one
  paragraph of block JSON), then the thread's mark on the first place the
  words stand.

## Live documents

The engine is `work-kit/collab-server` (its README has the detail):
Hocuspocus 4.4 with garbage collection off, behind our own listener (`ws` in
`noServer` mode hands each socket to `Hocuspocus.handleConnection`).

- **Names.** A LifeOS document is its Convex id. A `.tcdoc` is
  `fileDocName(path)` (`file:` and a hash of the path), and its path rides in
  the signed token, never in the socket.
- **Tokens.** ES256, at most 15 minutes. This host signs with
  `aud: tempcode-work-collab` and `iss: tempcode:<host id>`; LifeOS signs
  with `aud: lifeos-work-collab`, owner only. The key pair is made each time
  Work turns on and lives in main's memory. A token is checked on connect,
  on every message and once a second, and must name the document the URL
  names. View and comment are read-only connections. A guest's token must
  name their own link (`principal: guest:<id>`, `link: <id>`), and only a
  guest's token names one. A token without an issue time, or longer than 15
  minutes, is refused. An expired or revoked connection's socket is closed
  with 4401 or 4403 and the reason.
- **LifeOS's public key** is not published by LifeOS yet. The service
  trusts LifeOS's tokens only when the setting `work.lifeos.jwks` holds its
  JWKS, as JSON or as LifeOS keeps it (a `data:` URL); an isolated instance
  may pass `TEMP_CODE_LIFEOS_JWKS` and `TEMP_CODE_LIFEOS_ISSUER`. The setting
  is read when the service starts. Until then LifeOS's own apps cannot open a
  socket here.
- **Stores.** A document is stored only when it changed: a read or a
  viewer's visit stores nothing. `ConvexDocStore` stores compare-and-set on
  `seq`. Told someone else stored first, it merges their state in and stores
  again, never overwriting. Every call to LifeOS ends at 30 s. `FileDocStore` rewrites `state.yjs` and `preview.md` in the
  `.tcdoc` and keeps every other entry. Stores are debounced (1 s, 5 s at
  most). Each store writes the markdown and plain projections.
- **No acknowledged edit is lost.** Every update is appended to a journal
  before Hocuspocus acknowledges it. A store drops the segments it covers. A
  failed store keeps them and tries again in 5 s (a "not found" is not tried
  again), a load replays them, and at start the service stores every journal
  a killed process left for documents nobody has opened since, and again
  every minute (a store that failed as its last editor left is taken up
  there). A write that would take a document's journal past 256 MiB, or all
  of them past 1 GiB, is refused (the socket closes with 4503, "try again
  later") until a store lands. The journal survives a killed process, not a power
  cut: it is not synced to disk on every write.
- **Principals.** Each Yjs client id that writes is recorded against its
  connection's principal (`collab.clients(name)`), kept in the document's
  book beside its journal, so it outlives a restart. A writer whose update
  carries a client id another principal holds is closed, so nobody writes
  under another's name: an update that adds items under a client id another
  principal holds closes the socket with 4403 (items the document already
  holds may come back, as an offline copy sends them). An id nobody holds is
  taken for its writer before the update applies. A host-side edit runs on a
  fresh client id each time, so it is credited to its principal alone and a
  stored state put back in time (a restored `.tcdoc`) still merges. In that
  case, an editor that saw the lost items holds items under other
  principals' ids the document no longer has, and is refused until it
  reloads; the log names the ids.

## `ctx.service`

- `url(route)`: `ws://127.0.0.1:<port><route>` for a socket route, `http://`
  otherwise. Throws while Work is off or the service is not running.
- `token(claims)`: signs for `{item: {doc}, role, principal, source?}`, five
  minutes long. A `.tcdoc` source on this host signs with its resolved path
  (`canonicalPath`: links followed, one spelling), and the item's `doc` must
  be `fileDocName(canonicalPath(path))`. A file on another host, or a
  LifeOS document while another host serves them, throws
  `ServedElsewhere {host}`: the caller (the docs pillar, M20) routes it with
  `ctx.peer`. A sheet (`{item: {sheet}}`, a LifeOS sheet) signs where
  LifeOS's documents are served and throws `ServedElsewhere` elsewhere
  (M27). There is no
  `work.collab.token` wire method: method names are `work.<pillar>.<verb>`,
  and the docs and sheets contract files are M20's and M27's.
- `internal(route, body)`: a POST over the socket with the secret; a 4xx or
  5xx comes back as a thrown error with the service's words.
- `token` and `internal` wait up to 20 s (`STARTING_WAIT_MS`) for a service
  that is still starting (Work just turned on, the host just booted) before
  they throw; `url` is synchronous and throws at once. A service waiting
  to start again after a crash (`waiting`) is not waited for: the call
  throws at once. Turning Work off does not cut a wait short: it ends at
  its 20 s and throws that Work is off. Milestone 49's
  document proof found an agent's first `doc_read` refused as "not running
  (starting)" a few seconds after Work came on.

## The tunnel

`scripts/box/ingress.yml` sends `tempcode.landonhale.com` paths matching
`^/(g|w|f)/` to the installed host's port, 7695, before the remote
listener's rule. Milestone 18 wrote the rule and proved on a quick tunnel
that a path rule carries a WebSocket upgrade. It is not applied to the live
tunnel: the owner applies it (`scripts/box/apply.sh --from 60 --through 60`,
docs/box.md). Proofs use a quick tunnel to an instance's own port, never the
public one.

## Proofs

- `work-kit`: `bun test src/collab-server` (tokens, journal, stores, the
  Hocuspocus wiring, markdown with no DOM).
- `NODE_ENV=test bunx vitest run src/main/server/work/service`:
  `service.test.ts` (both listeners, every route, live documents against a
  fake Convex, the internal routes, the restart), `ctx.test.ts` (Work off
  means no process; restarts; two instances), `boundary.test.ts`.
- On the built tree, with real LifeOS and a quick tunnel:
  `env -u ELECTRON_RUN_AS_NODE bun src/main/server/work/service/proof/live.ts <token file> <token file> [--wait-mac]`
  (tokens from `sudo -n lifeos-deploy run <lifeos checkout> auth:mint
  '{"ownerId":"landon","name":"<milestone> proof"}'`; the proof removes its
  document and revokes the keys its instances mint).
