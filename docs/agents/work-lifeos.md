# Work: the host's LifeOS connection

Milestone 7 of the Work plan; [work.md](work.md) says how a pillar mounts.
LifeOS is the owner's Convex backend on the box (`https://lifeos.landonhale.com`)
with its MCP worker (`https://lifeos-mcp.landonhale.com/mcp`). Two identities
reach it from TempCode (architecture §5): **the host, as the owner**, for
screens and for what a person presses; and **an agent, as a bot**, through a
draft-only key held to one workspace's sector. All of it is in
`src/main/server/work/lifeos/` and `src/shared/contract-work-lifeos.ts`.

## Where each secret lives

| Secret | Where | Never |
|---|---|---|
| The device token (`lo_…`), one per host | this host's Aliax vault, service `addon`, name `~lifeos-device`, sealed, **with no profile entry** (deviceToken.ts), kept with the LifeOS address that issued it | in a row, a log, a push, an answer, a thread; synced (the account sync walks profiles) or swept (so does the grant sweep); sent to any address but the one that issued it |
| A sector key (`lob_…`), one per linked scope | the grant of that scope's LifeOS add-on row (`Authorization: Bearer …`), written by `AddonGrants.setFields` straight from `bots:mint` | in the row, the `work_lifeos_keys` table (name and sectors only), a log or a model's context; the add-on host sends it as a header |
| A JWT (one hour) | memory, per sector set | anywhere but the answer to `work.lifeos.jwt` (approve) |
| A pairing poll secret (`lop_…`) | memory while a pairing waits | anywhere |
| A one-time sign-in code (`loe_…`) | the giver's answer from `auth:enrollCreate`, the sealed letter, the PC's enroll file until LifeOS reads it | in a log, a reason, an error |

Every line the pillar logs passes `redact` (transport.ts), which blanks each
of those shapes. `TEMP_CODE_LIFEOS_URL` and `TEMP_CODE_LIFEOS_MCP_URL` point
an **isolated** instance (one with `TEMP_CODE_USER_DATA`) at another LifeOS;
the installed app always talks to the owner's own.

## The session (session.ts)

One `LifeosSession` per host, made at boot and run only while Work is on
(`deps.whileOn`). It trades the device token for JWTs with `auth:token`
(open, over HTTP), keeps the owner's live Convex client (`convex/browser`,
bundled into main; a devDependency, so only its client code ships), whose
JWT it refreshes when the client asks or two minutes before the end, and
reattaches every subscription after a reconnect. States, as data
(`LifeosState`):

| State | When | A screen draws |
|---|---|---|
| `off` | Work is off here (the frame refuses `work.lifeos.*` then) | nothing of LifeOS |
| `signed-out` | no token here | Sign in (pair) |
| `pairing` | a code waits for approval in LifeOS (code to admin callers only, `expiresAt` to all) | the code and its countdown |
| `connecting` | a token, first trade not back | a spinner |
| `connected` | acting as the owner (`ownerId`, `since`) | the screens |
| `unreachable` | a trade failed on the network, or the socket was down 30 s; retried at 5, 15, 30, 60 s | "LifeOS is unreachable" and when since |
| `refused` | LifeOS refused the token (revoked) | Sign in again |

Every member answers a typed `LifeosUnavailable` (`.state`) while it cannot
reach LifeOS; no create is refused for it (a chip waits, below). A failed
trade for one screen's JWT answers `unreachable` and leaves the owner's
connection alone. Convex never asks for a token again once a refresh gave it
none, so the client's `onChange(false)` drops and reconnects the session on
its retry steps. A sign-out or a switch-off while a trade, a pairing or a
`setToken` waits wins: nothing it brings back is kept or handed out (an
epoch each of them checks). `auth:token` never follows a redirect. On
connect, the owner's name for the preamble (`work.ownerName`) is taken from
his default mail identity when the setting is empty.

## Sign-in

- **Pairing:** `work.lifeos.pairStart {name?}` (admin) → `auth:pairStart`;
  the host polls `auth:pairClaim` every 3 s and keeps the token; the owner
  approves the code in LifeOS desktop's "Approve a sign-in" (not in his
  installed LifeOS yet).
- **A minted token:** `sudo lifeos-deploy run <lifeos checkout> auth:mint
  '{"ownerId":"landon","name":"…"}'`, then `work.lifeos.setToken {token}`
  (admin, never relayed); it is kept only if LifeOS trades it, and the
  session it replaces is revoked in LifeOS. Pairing again is refused while
  signed in: sign out first.
- **Sign-out:** `work.lifeos.signOut` revokes this session in LifeOS
  (`auth:revoke`) and drops the token; the sector keys stay.
- **By a setup link** (a computer the Mac sets up): below, "A computer set
  up by link".

## Sector keys (keys.ts)

A scope that should hold a key: every workspace with a `sector` (a Work
workspace's is set when it is made; a code workspace links with
`work.lifeos.link {workspaceId, sector | null}`, admin), and the Work Chats
(`"~work"`, every sector `sectors:list` names). For each, on the host that
holds the scope's add-ons (`storeSync.homeFor(scope) === null`), a pass:
mints `bots:mint {name, sectors, client: 'tempcode', draftOnly: true}`
(LifeOS forces both from a TempCode session anyway), writes the add-on row
`lifeos` in that scope (http, the MCP URL, header `Authorization`, auth
`fields`) through the store's RPC as this host, marks it `role: 'lifeos'`
and puts the key in its grant. A pass runs at connect, on a `workspaces`
change, on an add-on change, after a link, every 5 minutes; it mints nothing
when a scope's row, sectors and grant stand, puts a lost role mark back,
and retires a key (`bots:revoke`) whose scope lost its link, its sector or
its workspace. A key is named `TempCode <host>: <workspace> <6 hex>`
(≤ 40, one per host and scope). A row named `lifeos` that is not this
host's (the person's own) is never written over: that scope reads `failed`.
A linked workspace homed on another host (two hosts with one Work workspace
name are linked by folder name) reads `elsewhere`: the home mints its key and
this host uses that row and a copy of its grant from its own vault; a key
this host minted before the scope was shared is revoked and forgotten, and
`work.lifeos.link` there is refused ("link it there"). Each pass checks a
row is still the one it wrote (LifeOS's MCP address, the one header, typed
values, on): a row someone pointed elsewhere has its key revoked and is
minted again. A mint's name is kept before LifeOS is asked, so a key whose
answer was lost is still retired later.
A key LifeOS revoked is not ready: keys die with the session that minted
them (a `setToken` or a sign-out ends it), so a pass reads `bots:list` once
and mints again into the same row when a scope's key is no longer live.
A session made by a setup link (`enrolled` in LifeOS) may mint no key:
`bots:mint` answers `forbidden`, every scope this host would mint for reads
`enrolled` with `ENROLLED_WORDS`, Connections shows one row ("Agents' LifeOS
keys"), and no pass asks again until the host holds another session.
`work.lifeos.status` lists each scope's key state (`ready`, `waiting`,
`elsewhere`, `failed`, `enrolled`) beside the session's.

## A computer set up by link (src/main/server/devices/setup/)

Main-process modules with no screens; the setup dialogs call them (plan
d9AVYMURpw9s §5, §6). LifeOS's side is `auth:enrollCreate`,
`auth:enrollRedeem`, `auth:enrollRevoke` (lifeos main `0ca9360`) and the
desktop's enroll file (`5dfb592`; a LifeOS desktop release is still needed).

- **lifeosEnroll.ts, on the giver:** `mintEnrollment({name, uses, ttlMs?},
  enrollDepsOf(host))` calls `auth:enrollCreate` through this host's own
  Work session and answers `{ok: true, enrollment, expiresAt, codes}`, or
  `{ok: false, reason: 'not-signed-in'}` when Work holds no live session
  (the dialog turns the LifeOS row off). `revokeEnrollment(enrollment, deps)`
  is Remove's and Cancel's `auth:enrollRevoke`. A minted or enrolled session
  is refused by LifeOS (`forbidden`): pair again.
- **workSignIn.ts, on the PC:** `signInWork({code, owner},
  workSignInDepsOf(host))` checks the session first (a token LifeOS has not
  refused is his, so `already-signed-in` and the code is not used), trades
  the `tempcode` code with `auth:enrollRedeem {code, owner}` over the host's
  open transport (`LifeosHost.open`), checks the owner, checks the state
  again, and keeps the token with `session.setToken`, the handler's own call.
- **lifeosInstall.ts, on a Windows PC:** `installLifeos({code, owner, reader,
  attempt?}, windowsInstallDeps(), onStep)` reads LifeOS's `latest.yml`,
  follows a redirect only over https to github.com,
  objects.githubusercontent.com or release-assets.githubusercontent.com,
  checks the installer's sha512 and runs it `/S`. It finds LifeOS by its
  HKCU uninstall entry (`reg.exe query`, no PowerShell): name `LifeOS
  <version>`, publisher `Landon Hale`, a folder under
  `%LOCALAPPDATA%\Programs` holding `LifeOS.exe`. electron-builder keeps
  `InstallLocation` under its own `Software\<guid>` key, not the uninstall
  entry, so the folder is the uninstaller's when the entry names none. One
  already there skips the download and the install. The enroll file is
  written as `.enroll-<attempt>.json.tmp` and renamed into place, LifeOS is
  started (a second launch makes a running one read it), and the step waits
  two minutes for `enroll-<attempt>.result.json` with its own attempt;
  "already signed in" is a done sign-in, his reader left as he set it. Each
  step reports `{step: 'download' | 'install' | 'sign-in' | 'reader', state,
  reason?}`.

## Links (links.ts)

`ctx.links.link(about, sessionId, title)` ties a thread to the task, mail
thread or event its chip names (`workLinks:link`, milestone 4's); a chip
that is not LifeOS's links nothing. M6's registry calls it once a created
thread's row exists. While LifeOS cannot be reached the link waits in
`work_lifeos_pending_links` and is made at the next connect.
`forThread` is `workLinks:byThread`; `completeFor(sessionId, reason)`
completes every open linked task with `tasks:complete {id, reason,
threadLink}`, never one of another sector than a Work thread's own. Only
LifeOS's own refusal (a ConvexError) drops a link; any other failure queues it.

## The wire

`work.lifeos.status` (read), `pairStart`, `pairCancel`, `setToken`,
`signOut`, `link` (admin), `jwt {sector?}` (**approve**: a LifeOS JWT can do
what the owner does there, `compose.send` included). `jwt` answers
`{ok: true, jwt, expiresAt, url}` (the Convex address the JWT is good for,
where a screen opens its own client: work/shell/lifeos.ts) or
`{ok: false, state}`, and is carried to a far host only while its screen is
unlocked (`'screen'`). The push `work.lifeos {status}` carries no pairing
code. A key paired at the pairing dialog's default (`operate`) gets no JWT.
`link` writes the sector through `registry.setWorkspaceSector`, which sends
the `workspaces` push, so every client's rail and menus see it.

## What Files asks of LifeOS

The Files place reads LifeOS through the host's own session
(`ctx.lifeos.owner()`) and changes it only after its one door
([work-files.md](work-files.md) "LifeOS, From mail and Projects"). These
LifeOS functions were made for it (lifeos main `12929f1`, deployed
2026-11-23):

| Function | What it is |
|---|---|
| `docs:remove`, `sheets:remove` | now a **soft delete**: the row stays with `deletedAt`, and every reader leaves it out (`readDoc`, `readSheet`: the catalog, `docs:list`, `sheets:list`, the project page, the guest view, the MCP tools, People's shared items, collab tokens), so its guest pages stop at once; nothing writes it. A note's document takes its note row with it |
| `docs:restore {id}`, `sheets:restore {id}` | out of the trash, in its project while the project stands (a note's document as its note again), else loose in its sector |
| `catalog:trash {sector}` | the sector's trash, newest delete first, each row as `catalog:list` gives it plus `deletedAt` |
| `catalog:purgeDeleted` | the daily cron: what has been in the trash 30 days goes for good |
| `mail:attachments {sector, since?, paginationOpts}` | the files of the sector's received mail, newest first, less pictures set in the text and mail in the trash or spam: `{ parts: { threadId, messageId, partId, name, contentType, size, sentAt, from, subject }[], isDone, continueCursor }`. A page looks through 50 threads, so a page may be empty and not the end |
| `projectItems:bySource {source}` | which projects a file is linked to: `{ id, projectId, name, title }[]` |
| `projectItems:repoint {from, to, title?}` | every link to `from` names `to`; a link titled by the old name takes `title` |

Until `catalog:trash` answers on a host's LifeOS, Files refuses a LifeOS
delete in the grammar's sentence ("LifeOS cannot put a document back yet.
Delete it in LifeOS."); it asks again every 30 seconds.

## What this does not stop

A Work thread's shell is not fenced (architecture §6.8). On a host, its
user can read the vault's files, and on a headless host the local socket
(`server.json`) answers as the implicit admin, `work.lifeos.jwt` included: a
shell that looks can get the owner's JWT, which can send. The add-on row is
guarded by each pass, not by the store: an approved `addon_add` that
rewrites it holds the key until the next pass (at most half a second after
the change). The account sync sends a static add-on grant to every host
subscribed to accounts, whatever its scope.

## Proofs

`lifeos.test.ts` with `fakeLifeos.ts` (unit; it also answers the
enrollment functions and an `enrolled` session); the setup modules'
`devices/setup/*.test.ts` on the fake and a fake feed. Against the built tree and
real LifeOS, run with bun from the repo root after `electron-vite build`:
`proof/firstStep.ts` (two isolated instances: a second host's add-on call
uses its own vault's key; a linked workspace shares the home's row) and
`proof/live.ts <token file>` (every done-when line, through a local
forwarder it can cut to show `unreachable`). Mint each proof's token with
its milestone's name, retire every key after (`bots:retire`), list them in
the landing note.
