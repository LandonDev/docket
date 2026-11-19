# The iOS contract package is generated

- `ios/TempCodeContract` holds the Swift `Codable` types of the remote wire,
  generated from zod by `scripts/gen-swift-contract.ts` (`bun run gen:swift`).
  `src/shared/wireSchemas.ts` is the zod for every server → client shape,
  pinned to its interface by type-level checks that the typecheck runs; the
  generator's `SUBSET` array is the one list of what the phone speaks.
- Never edit `Sources/TempCodeContract/Generated/`. Change the contract,
  run `bun run gen:swift`, commit the output: `bun run check:swift-contract`
  (inside `bun run typecheck`) fails the gate when it is stale, and
  `bun run ios:test` (in the gate too) builds and tests the package.
  Fixtures under `Tests/Fixtures` come from a real server through
  `bun run script:capture-swift-fixtures`; re-record them when a captured
  shape changes (on the box, where the esbuild → node path fails:
  `bun --preload ./scripts/lib/electron-stub.ts scripts/capture-swift-fixtures.ts`).
  The capture reads a scratch deploy directory, never the machine's own log.
  The package README has the subset policy and what L2
  (the socket actor) builds on it. The subset covers the master, notes,
  project-plan, review, plans, resources, devices, deploy, Mac bridge and
  accounts methods and their pushes (`notes`, `batch`, `resources`,
  `boot-resume`, `accounts`, `host.devices`, `host-log`, `macBridge.held`);
  the README's table is the list, with the capability each needs.
  Work's names are in it too (docs/agents/work.md): `WorkspaceKind`,
  `SessionScope`, `WorkSettings`, `ContextChip` and `CanvasSource` (a
  seventh generated file, `CanvasSource.swift`), the optional `scope`,
  `kind`, `sector` and `lifeosProjectId` fields, and `work.get` and
  `work.set`. Milestone 46 added the phone's Work: the `work`,
  `work.outbox`, `work.outbox.result`, `work.lifeos` and `away` pushes are
  in `RemotePushSchema` (zod for `WorkResult`, `OutboxGrant`,
  `ToolRulesCard`, `LifeosStatus` and Away's snapshot in wireSchemas.ts,
  each pinned to its interface), and the subset carries the Outbox's list,
  get, send, discard, edit, grants, ungrant, rules, setRules, results and
  undo, `work.lifeos.status`, `away.get` and `away.set`, with `HeldRef`,
  `AwayState` and `AwayDecided` named. The client's switch over
  `ServerPush` is exhaustive: a new remote push lands with its case
  (EnvironmentClient.apply hands Work's to `WorkHost`). A union's inline object
  branch that pins a field to a literal is tried only for the values its
  literal and enum fields list (`branchGuard`), since a generated enum
  keeps a value it does not know and would take a later branch's known
  shape: a chip's `{at: 'lifeos', table: 'docs'}` is a `CanvasSource`. The
  generator refuses a `local` method (`jsonSchemas` throws), names
  `BuildFacts` and `NoticeKind` once, and `scripts/gen-swift-contract.test.ts`
  pins its rules; `DecoderRulesTests.swift` proves the decoder on
  hand-written JSON, so it passes before the fixtures are re-recorded.
  Milestone 47 added a Work thread's items and LifeOS's screens: the
  `work.canvas` and `work.routines` pushes, `CanvasItem` and `FrameTable`
  named, and `work.lifeos.jwt`, `work.mail.send`, `work.rules.forDraft`,
  `work.workspace.get/set`, `work.canvas.list/open/close`,
  `work.guests.ticket/create`, and each kind the phone draws (`work.pdf.open/read`,
  `work.slides.open/read/review`, `work.media.view/note/segment/tile`,
  `work.meetings.get`, `work.forms.responses`, `work.dashboards.open/review`,
  `work.history.versions/compare`, `work.browser.state/drive`,
  `work.routines.list/pause`). A phone view of a pillar's answer
  (`PdfPhoneView`, `DeckPhoneView`, `MediaPhoneView`, …) keeps only the
  fields the phone draws; its pin is `Reads` (every value of the server's
  type is one the schema reads), not `Mirror`. Two generator rules came
  with them: union branches that come out as one Swift case (a string or
  the literal `'live'`, two tuple shapes) are one case, and a field named
  `patch` gets the type name `Changes`, never `Patch` (the request wrapper).
