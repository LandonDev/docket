# A new thread's access

Every new thread or chat, however it starts, takes the access his Thread defaults name (Settings →
Thread defaults → Access) for its own workspace on its own host; where he has set none, the app's one
built-in (`DEFAULT_THREAD_DEFAULTS.permission`, `edits`, src/shared/defaults.ts). No start path
carries a fallback of its own. The table of every path and what it did before is
`.temp-code/plans/landed/F-full-access-everywhere.md`.

## One rule on each side

- **The host** (`newThreadPermission`, src/shared/defaults.ts, called once in `SessionRegistry.create`):
  what was asked, else `resolveThreadDefaults(workspace)`, never above a `ceiling`. A paired key
  without `approve` is held to `edits` (`accessCeiling`, shared/capabilities.ts, judged as the door
  judges an asked `auto`, so a device key's admin counts for nothing) on every start it reaches:
  `session.create` and `plan.implement` (index.ts), remote MCP `start_session` (remote/facade.ts), and
  Work's starts it presses for (a play, Run now, a capture, a nudge, a meeting brief:
  `threads.start({by})`). `requiredCapability` refuses an ASKED `auto` on `session.create`; everywhere
  else the ceiling lowers it, and it holds the default too. A key's build also holds to the plan
  thread's access.
- **The window** (`newThreadAccess`, lib/session.ts; the workspace store answers through
  `setNewThreadAccess`): every draft built by `newSession`/`newDefaultSession` shows his defaults for
  its host and workspace (the project's workspace for a project thread), else the built-in. The
  composer shows that live on an unsent draft he did not pick (threadChat.tsx `useShownAccess`), so a
  draft made before the defaults loaded catches up.
- **A draft sends no access unless he picked it** (`accessPicked`, set by the composer's picker;
  `accessParams`, carried by `ensureCreated`). The host then decides from its own copy of his
  defaults: right host, right workspace, whatever the window had loaded. A remembered draft
  (lib/projectDrafts.ts) keeps a pick; a mode only seeded is re-read at rebuild.

## What inherits, and why

- An agent's child (spawn_agent, an orchestrator's children, `app_start_thread`, a master's batch,
  threads across hosts, the merge reviewer) takes its starter's access: the grant he gave that thread,
  never more. These are the only host starts that pass `permission`, as `<starter>.permission`.
- A plan's build (Start build…, the phone's Implement) is a new thread: his default, or his pick in
  the dialog; never the planning thread's. The host's own start on `plan_complete` holds to the plan
  thread's access as a ceiling (a plan an agent started at `edits` builds at `edits` at most).
- Work threads the host starts (routines, plays, meeting prep, the Waiting on nudge, digest, review)
  take his default for their workspace. They used to be fixed at Full access. Their provider, model
  and effort are his Thread defaults for the workspace too (work/threads.ts passes none), unless a
  routine names its own model or effort; the per-workspace Work model they used to read is unread.
- His own pick on a thread (the picker on a thread, or on a draft before its first send) stays.
  A thread that is lower only because an old build fell back stays as it is; he raises it with the
  composer's access picker on that thread.

## What access never changes

Full access releases nothing Work holds (every outward act waits for his press in the Outbox; no
grant is made), loosens no narrowed thread (`WorkModule.callRefusal`, `harnessDenied`,
work/narrowing.ts), and changes no Mac bridge or computer-use gate (confirm cards, the session tier,
`WINDOWS_ALWAYS_ASK`, credential paths that always ask). Away answers what it answered before. Every
provider has a mode for each policy (Claude `bypassPermissions`, Codex `never` + `danger-full-access`,
Cursor `force` with no sandbox, Muse `:unrestricted`); FX has no access picker.

## The model: the same rule

A new thread's provider, model and effort follow the same shape as its access. His Thread defaults
(provider, model, effort) for the thread's own workspace on its own host decide, unless he picked.

- **A draft sends no model unless he picked it** (`Session.modelPicked`, set by the composer's model
  picker and effort control; `modelParams` in lib/tcserver/commands.ts, carried by `ensureCreated`):
  provider, model and reasoning go together, or none of them go. The context window is the
  window's own choice, which no Thread default holds: `context1m` goes as the draft shows it,
  picked or not. A remembered draft
  (lib/projectDrafts.ts, lib/workspaceSnapshot.ts) keeps the pick.
- **The window shows what the host will use** (`withNewThreadModel`, lib/session.ts; the workspace
  store answers through `setNewThreadModel` with `modelSeed`, lib/tcserver/defaults.ts): every
  unpicked draft is set to his defaults for its host, workspace and type, else the built-in. When
  the defaults load or change, `sessionStore.reseedDrafts` (subscribed in App.tsx) sets every
  unsent, unpicked draft again, so the composer's harness, tools and slash commands follow. His
  last context window (1M) and speed pick (fast) still ride where the model offers them
  (`mergeModelSettings`); his last effort no longer leaks into a new draft. A draft's own rule holds
  over every re-seed (`sessionStore.keepDraftRule`, set by the dock from its subject's `seed`): a
  mail chat's draft that becomes Muse when his defaults land moves to Claude, as a pick.
- **The host decides** (`SessionRegistry.create`): `params.provider ?? d.provider`, the model or the
  provider's catalog default, a research thread on Claude whatever the default, an effort clamped
  to the model it resolved to (`clampReasoning`, src/shared/catalog.ts), so a named model of
  another provider never carries an effort its harness refuses, and `context1m` stored only for a
  model that offers the 1M window (`supportsContext1m`; one the catalog does not know keeps what
  was asked).
- **After the create** the store takes the host's provider, model, effort and window (and access)
  for whatever the draft did not pick (`mergeMeta`), and the first `session.send` switches nothing.
  Before this, draft adoption kept the draft's own values, so a dock draft made on the built-in kept
  showing Auto-accept edits on a thread the host had made at Full access (commands.test.ts runs the
  writes `onSubmit` makes after the create).
- **What the window has heard**: it reads his defaults when a link opens and after its own save
  (workspaces.ts `refresh`, `loadDefaults`). `defaults.set` from another client sends no push, so
  until this window reconnects, an unpicked draft shows (but never sends) the defaults it last read.
- **Picked on purpose**: a second opinion and a hand-off (he chose the harness and model in the
  menu), the Mail chat's move off Muse (MailDock.tsx `onClaude`, a rule of the product, kept over a re-seed). Start
  build's dialog sends the model it shows (the plan thread's, by the product's rule) to
  `plan.implement`. A new tab opened by moving a thread to another project takes his defaults.

## The guard

`src/renderer/src/lib/accessGuard.test.ts` fails on a create that sends a model other than his
pick (`...modelParams(session)` alone), on a Work path in the window that names a provider, model or
effort (MailDock's `onClaude` is allowed, with its reason), and on a literal mode or a fallback of its own in the
window, a `policyForMode` outside a pick or an existing thread's change, a create that sends an
unpicked mode, a host start that passes a `permission` other than its starter's or his pick, and a
second `?? d.permission`. The paths with his default at Full access: lib/newThreadAccess.test.ts
(window), server/newThreadAccess.test.ts (host); on a host of its own:
`bun --preload scripts/lib/electron-stub.ts scripts/proof-full-access.ts`. The model's paths:
lib/newThreadModel.test.ts (window), server/newThreadModel.test.ts (host).
