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
`work.lifeos.status` lists each scope's key state (`ready`, `waiting`,
`elsewhere`, `failed`) beside the session's.

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
`{ok: true, jwt, expiresAt}` or `{ok: false, state}`, and is carried to a
far host only while its screen is unlocked (`'screen'`). The push
`work.lifeos {status}` carries no pairing code. A key paired at the pairing
dialog's default (`operate`) gets no JWT.

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

`lifeos.test.ts` with `fakeLifeos.ts` (unit). Against the built tree and
real LifeOS, run with bun from the repo root after `electron-vite build`:
`proof/firstStep.ts` (two isolated instances: a second host's add-on call
uses its own vault's key; a linked workspace shares the home's row) and
`proof/live.ts <token file>` (every done-when line, through a local
forwarder it can cut to show `unreachable`). Mint each proof's token with
its milestone's name, retire every key after (`bots:retire`), list them in
the landing note.
