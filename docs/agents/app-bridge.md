# The app bridge: a thread's own tools, and only its own

`scripts/app-mcp-bridge.mjs` is the app's MCP server for every harness that
cannot take an in-process one: Codex (`mcp_servers.app` in the thread's
config) and Muse (`session/start`'s `config.mcpServers.app`). Claude's app
tools are in process and bound to the thread; this file is about the bridge.
It is a stdio MCP server with no imports that connects back to the app's
loopback WebSocket and sends each tool call as an `app.*` method
(`METHOD_FOR`), a `mac.*` method (the Mac bridge's tools), `app.computer*`
or `app.work*`.

## Who a call is from

The loopback socket takes anyone on the machine, and every `app.*` method
answers as the thread its `sessionId` names. So a call proves which thread
it is from (since F1, 2026-11-19):

- **The token.** `bridgeMcpConfig(sessionId)` (src/main/server/apptools.ts)
  gives the bridge `TEMP_CODE_APP_TOKEN`: an HMAC of the thread's id under a
  key made at boot (`MacThreadTokens`, purpose `app-bridge`). The bridge will
  not start without it. Every request it sends carries `appToken`.
- **The check.** `bridgeCallRefusal` runs in index.ts for every `app.*`
  request, after the remote capability gate and before any handler: the
  token must be the named thread's own, or the answer is `forbidden: <method>
  needs the calling thread's own app token`. With no bridge set up, every
  `app.*` call is refused. No other method is touched.
- **The bridge's own thread last.** `callParams` puts `sessionId` and
  `appToken` after whatever a tool was given, so no argument can replace
  them.
- **No undeclared arguments.** `argumentRefusal`: a call to one of the
  bridge's own tools that names an argument its schema does not declare is
  refused with the list of what the tool takes, and nothing is sent. The
  computer and Work tools carry their arguments nested (`args`) and the app
  checks them against its own schemas.

The `mac.*`, `app.computer*` and `app.work*` calls keep their own per-thread
tokens (`TEMP_CODE_MAC_TOKEN`, `TEMP_CODE_COMPUTER_TOKEN`,
`TEMP_CODE_WORK_TOKEN`) beside the app token; each is a different purpose in
the HMAC, so one never opens another.

Before F1 the bridge sent `{ sessionId: SESSION, ...params }`: a tool
argument named `sessionId` replaced the thread's own, and any Codex or Muse
thread could list, read, start, message, wait on, answer and interrupt
another thread's agents, write its notes and decisions, merge as it and call
its add-ons. It cannot now.

`batch_rules` takes flat fields as a tool and sends them under `rules`, as
`app.batchRules` takes them (`wireArgs`); before F1 the schema dropped them
and a Codex master could not set its rules.

**What the token does not stop:** the thread's own shell. A process on the
machine can still open the loopback socket and call the methods the
renderer calls (`session.send` and the rest); those take no token, as the
desktop's own window uses them. And a process running as the same user can
read another bridge's environment (`/proc/<pid>/environ` on Linux), token
included. The token closes the tool path, not the shell. A proof's token
seeds (`*_TOKEN_SEED`) are stripped from every harness child's environment
(`harnessEnv`, drivers/binaries.ts), so a seed set on an instance never
reaches an agent.

## Proof scripts

A proof that calls `app.*` as a thread gives its isolated instance
`TEMP_CODE_APP_TOKEN_SEED` (hex; honoured only with `TEMP_CODE_USER_DATA`
set) and adds the token with `withAppToken` from `scripts/lib/appToken.ts`.
In process, after `startServer`, `bridgeMcpConfig(id).env.TEMP_CODE_APP_TOKEN`
is the thread's token.

## Tests

- `src/main/server/app-bridge.server.test.ts`: a real server and the real
  bridge script; a call naming another thread's id is refused, by the server
  with A's token and by the bridge as an undeclared argument; the bridge's own
  call lands in its own thread.
- `src/main/server/app-bridge.test.ts`: every forwarded request carries the
  bridge's own thread and token; undeclared arguments refused; no start
  without a token.
- `src/main/server/apptools.test.ts`: `bridgeCallRefusal` itself.
