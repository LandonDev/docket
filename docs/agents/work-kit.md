# work-kit: the shared private package and its pin

`LandonDev/work-kit` (private) holds the code TempCode, LifeOS and both phone
apps share: one npm package of TypeScript source at its root, with subpath
exports and no build step, and one SwiftPM package beside it (`Package.swift`,
products `LifeKit` and `LifeKitUI`). Its README is the rule book: how to add a
folder, when to bump `WORK_KIT_API`, what a host must add. The box keeps a clone
at /srv/agents/work/work-kit. The Work plan's architecture §2 says what goes in
it and who owns each folder.

## The pin

```json
"devDependencies": { "work-kit": "git+https://www.github.com/LandonDev/work-kit.git#<40-hex sha>" }
```

- **The `www.` form is the only one that works.** Bun 1.4 fetches a `github:`
  spec, and any `git+https://github.com/…` URL, as a tarball from
  api.github.com with no token (it ignores `GITHUB_TOKEN`), and a private repo
  answers 404. With `www.github.com` bun runs `git clone`, which signs in
  through git's credential helper. Every machine that installs this tree needs
  one: on the box `agents` has `gh auth setup-git` (docs/box.md), so
  box-update's `bun install --frozen-lockfile` fetches it; the Mac's release
  build and any Mac worktree use the Mac's git credentials. aliax-core is
  public, which is why its `github:` pin never hit this.
- **A devDependency, like React.** electron-builder copies only `dependencies`
  into the app, so neither work-kit nor its packages (Tabler icons,
  react-day-picker) ship; the renderer and main bundles in `out/` carry what
  the app uses of it, compiled. Belt and braces: `electron-builder.yml` leaves
  out `node_modules/work-kit/**`, and `electron.vite.config.ts` lists it in the
  main process's `externalizeDepsPlugin` exclude beside aliax-core.
- **Tailwind** skips `node_modules`, so `src/renderer/src/index.css` has
  `@source "../../../node_modules/work-kit/src";`. Today that adds about 89 KB
  (10 KB gzipped) to the renderer's one stylesheet, the classes of every
  primitive in `src/ui` whether used or not.
- **A script bundle** that imports work-kit with `--packages=external` needs
  `--alias:work-kit=./node_modules/work-kit/src`, as aliax-core does; a subpath
  maps to the same path under `src` (`work-kit/lifeos` is `src/lifeos/index.ts`).
- `overrides` holds `yjs` at 13.6.31, the one Yjs the shared editor runs on.

Imports are by subpath; there is no root export: `work-kit/ui/<name>`,
`work-kit/<folder>`, `work-kit/lifeos/types`, `work-kit/editor/styles.css`,
`work-kit/api` (`WORK_KIT_API`) and `work-kit/guards`.

## The guard

scripts/workKitPin.test.ts checks the pin's form and commit against bun.lock,
the interface version this tree was built for (`WORK_KIT_API` 1), the Swift
revision in ios/TempCode/project.yml once the phone app pins one, the builder
rule, the exclude, the `@source` line, and a render of `KitProbe` from
`work-kit/ui/kit-probe`. It runs `lockProblems` (`work-kit/guards`) on bun.lock:
one copy each of yjs, y-prosemirror, y-protocols, prosemirror-model and
@tiptap/pm, and no `@blocknote/xl-*` (GPL) or `@y/*` (Yjs v14) package. LifeOS
runs the same guard on its own lock.

## Bumping the pin

A bump is one commit that changes package.json and bun.lock and nothing else:
push and tag (`vN`) the work-kit commit, set the sha, `bun install`. On a rebase
conflict in bun.lock, take the incoming side and run `bun install` again. While
iterating, rsync work-kit's `src` into node_modules/work-kit as with aliax-core,
then commit, bump and install for real.
