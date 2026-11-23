# work-kit: the shared private package and its pin

`LandonDev/work-kit` (private) holds the code TempCode, LifeOS and both phone
apps share: one npm package of TypeScript source at its root, with subpath
exports and no build step, and one SwiftPM package beside it (`Package.swift`,
products `LifeKitCore`, `LifeKit` and `LifeKitUI`). Its README is the rule book: how to add a
folder, when to bump `WORK_KIT_API`, what a host must add. The box keeps a clone
at /srv/agents/work/work-kit. The Work plan's architecture §2 says what goes in
it and who owns each folder.

## The pin

```json
"devDependencies": { "work-kit": "git+https://www.github.com/LandonDev/work-kit.git#<40-hex sha>" }
```

- **The `www.` form is the only one that works.** Bun fetches a `github:`
  spec, and any `git+https://github.com/…` URL, as a tarball from
  api.github.com with no token (it ignores `GITHUB_TOKEN`), and a private repo
  answers 404. Bun does not take `www.github.com` for GitHub, so it runs
  `git clone`; GitHub answers that host with a 301 to github.com, and git signs
  in there with its credential helper. On the box `agents` has
  `gh auth setup-git` (docs/box.md), so box-update's
  `bun install --frozen-lockfile` fetches it; the Mac (bun 1.3.12, gh as the
  helper) fetched it frozen from a fresh cache on 2026-11-19. It rests on bun
  not learning `www.github.com` and git following redirects: after a bun
  upgrade, run a clean frozen install before trusting it. aliax-core is
  public, which is why its `github:` pin never hit this. temp-code itself is
  public, and a clone without access to work-kit can no longer `bun install`.
- **A devDependency, like React.** electron-builder copies only `dependencies`
  into the app, so neither work-kit nor its packages (Tabler icons,
  react-day-picker) ship; the renderer and main bundles in `out/` carry what
  the app uses of it, compiled. Belt and braces: `electron-builder.yml` leaves
  out `node_modules/work-kit/**`, and `electron.vite.config.ts` lists it in the
  main process's `externalizeDepsPlugin` exclude beside aliax-core.
- **Tailwind** skips `node_modules`, so a work-kit component's classes reach
  the renderer's one stylesheet only through an `@source` line. The lines
  live in `src/renderer/src/work-kit-sources.css`, which `index.css` imports
  and `bun scripts/gen-work-kit-sources.ts` writes: one line per work-kit
  file the renderer imports (every `work-kit/…` specifier under
  `src/renderer/src`, and each work-kit file those reach), and the probe.
  Never the whole package: that put 89 KB of every primitive's classes in
  the first paint with none of them on screen (328 KB to 239 KB without).
  **A thread that starts importing a work-kit module runs the script and
  commits the file**; the pin test fails until it does. The classes do land
  in the first-paint stylesheet: a second Tailwind sheet for Work would put
  utilities in two sheets, and the later one's copies would override the
  first's in the wrong order across the whole app.
- **Host rules.** The primitives take some classes from the host's stylesheet
  (`HOST_RULES` in `work-kit/ui/host-rules`: Kobra's raised button, check
  badge, toggle, spinner bar, ring transition, two type steps). TempCode
  defines them all, on its own tokens and motion values: `t-raise` and its
  kinds with `t-raise-outline` and `t-flat` in `index.css`, the rest in
  `assets/components.css`, and `text-lead` (15/24) and `text-sheet-title`
  (16/24) as theme steps. The check badge's arc does not turn by CSS here (a
  new keyframe needs a row in `lib/motionGuard.test.ts`); work-kit's own
  animation moves it.
- **A script bundle** that imports work-kit with `--packages=external` needs
  `--alias:work-kit=./node_modules/work-kit/src`, as aliax-core does; a subpath
  maps to the same path under `src` (`work-kit/lifeos` is `src/lifeos/index.ts`).
- `overrides` holds `yjs` at 13.6.31, `prosemirror-model` at 1.25.13 and
  `@tiptap/pm` at 3.34.0: the one Yjs and the one ProseMirror the shared editor
  (`work-kit/editor`, BlockNote 0.57.0) runs on. The two ProseMirror versions are
  what BlockNote 0.57.0's ranges resolve to; move them only with BlockNote.
- **The editor's peers.** work-kit's `y-prosemirror` and `y-protocols` are
  optional peers, so this repo names them itself: `y-prosemirror` 1.3.7 and
  `y-protocols` 1.0.7 in `devDependencies` (exact, as work-kit names them), or an
  import of `work-kit/editor` does not resolve.

Imports are by subpath; there is no root export: `work-kit/ui/<name>`
(`work-kit/ui/cn` for the kit's `cn`),
`work-kit/<folder>`, `work-kit/lifeos/types`, `work-kit/editor/styles.css`,
`work-kit/api` (`WORK_KIT_API`) and `work-kit/guards`.

## The guard

scripts/workKitPin.test.ts checks the pin's form and commit against bun.lock,
the interface version this tree was built for (`WORK_KIT_API` 3), the Swift
revision in ios/TempCode/project.yml, the builder
rule, the exclude, that `work-kit-sources.css` is what the generator writes
for today's imports, and a render of `KitProbe` from
`work-kit/ui/kit-probe`, compiles index.css with Tailwind scanning only its
`@source` globs and finds the probe's `[--work-kit-probe:1]` class, and holds
TempCode to defining every host rule the primitives use. It runs `lockProblems` (`work-kit/guards`) on bun.lock:
one copy each of yjs, y-prosemirror, y-protocols, prosemirror-model and
@tiptap/pm, and no `@blocknote/xl-*` (GPL) or `@y/*` (Yjs v14) package. LifeOS
runs the same guard on its own lock.

## Bumping the pin

A bump is one commit that changes three files: package.json, bun.lock and
`ios/TempCode/project.yml` (the phone's WorkKit `revision:` is the same commit,
and the pin test holds them equal). Push and tag (`vN`) the work-kit commit, set
the sha in both, `bun install`. When the new commit adds a file the renderer's
imports reach, `bun scripts/gen-work-kit-sources.ts` writes
`work-kit-sources.css` again and that file rides in the same commit. A bump that
moves Swift (LifeKit) is parse-checked for the phone on the box
(`swiftc -parse` from `~/toolchains`) or its commit says it was not. The pin
moves forward only. On a rebase conflict in bun.lock, take the incoming side and
run `bun install` again; after the merge, `bun install --frozen-lockfile` in the
main checkout. While iterating, rsync work-kit's `src` into a node_modules of
your own (never the main checkout's link) as with aliax-core, then commit, bump
and install for real.
