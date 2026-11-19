# Work: conversions, import and export

Milestone 15 of the Work plan built the toolchain and the job runner (this
file's first two parts). Milestone 21 (import and export) adds its own part
after them. [work.md](work.md) says what is mounted for the `formats` pillar
and how a pillar registers.

## The toolchain

The tools pillars convert with live on each host, outside the app bundle,
under `<userData>/work-tools/`, installed with no root and nothing
registered with the system:

| Tool | Version | Licence | How it is used |
|---|---|---|---|
| `libreoffice` | 26.8.3, The Document Foundation's official build (Carlito and Caladea inside) | MPL-2.0 | a separate `soffice --headless` process |
| `python` | CPython 3.12.16 (python-build-standalone 20261110) | PSF-2.0 | runs the venv |
| `venv` | a virtual environment of `python`, with its pip | PSF-2.0 (pip MIT) | pillars add packages to it |
| `ffmpeg` | 9.0.2 static (`ffmpeg`, `ffprobe`) | GPL-3.0-or-later | separate processes only |
| `ironcalc` | `@ironcalc/nodejs` 0.9.1 and its platform package | MIT OR Apache-2.0 | may be loaded in process |

Nothing under the GPL or AGPL is linked into our code: such a tool runs as a
separate, unmodified process, and its manifest says so (`licenceNote`). The
base manifest offers every tool on linux-x64, darwin-arm64 and darwin-x64,
and all but LibreOffice on win32-x64 (an MSI's admin-install layout is
unproven, so a Windows host forwards LibreOffice jobs). Installed and probed
on the box (linux-x64) and on the owner's Mac (darwin-arm64) on 2026-11-19;
the win32 and darwin-x64 entries have not run.

### Manifests

`scripts/work-tools/base.json` is the toolchain's own. Every other
`scripts/work-tools/<pillar>.json` is one pillar's, and a pillar adds a tool by
adding its file: neither the installer nor `base.json` changes. The schema is
`ToolManifestSchema` in `src/main/server/work/formats/tools.ts`:

- `pillar`, then `tools`, each with `name` (one name across all manifests),
  `version`, `licence` (SPDX), `licenceNote` (how it may be used),
  `homepage`, `needs` (tools installed first), `threads` (what one job with
  it uses; the runner's cap counts it) and `platforms`.
- A platform entry (`linux-x64`, `linux-arm64`, `darwin-arm64`,
  `darwin-x64`, `win32-x64`) has a `kind`, its `files` (each an https `url`
  with a `sha256` or npm's `integrity`, and its `size` when the publisher
  gives one), `bin` (the main program or module inside the tool's folder),
  `bins` (its other programs) and `check` (files that must be there).
  - `archive`: each file unpacked (tar, zip) into the folder, `strip`
    leading folders dropped, `into` a subfolder; `raw` keeps a file as it is
  - `debs`: a tarball of .deb packages, each extracted with `dpkg-deb -x`
  - `dmg`: mounted read-only and hidden (`hdiutil attach -nobrowse`), its
    `app` copied out
  - `npm`: package tarballs, each into its `into` (`node_modules/<name>`)
  - `venv`: made in place by the python tool it `needs`
  - `pip`: `packages` added to the venv it `needs`, one line per package of
    the whole closure, each `name==version --hash=sha256:…` with every
    wheel's hash; the installer runs `pip install --require-hashes
    --only-binary=:all: --no-deps`, so nothing unhashed and no build code
    runs. `bun scripts/work-tools/pip-lock.ts --data <userData> pkg==v …`
    writes the lines; it resolves the closure on the platform it runs on, so
    a dependency only another platform needs is missing there until a lock
    run on that platform adds its line (the probe says so). Its folder is the venv's and its `bin` is the venv's
    python
- `probe.steps`: commands that must exit 0, match `expect` (a regular
  expression over stdout and stderr) and leave `expectFile`. Placeholders:
  `{bin}`, `{bin:<program or tool>}`, `{dir}`, `{tmp}` (a fresh folder,
  removed after), `{tmpUrl}`, `{node}` (the installer's runtime). `probe.write`
  puts files in `{tmp}` first. LibreOffice's probe writes a PDF, which the
  AppImage the formats research tried could not.

A worked example, a pillar adding python-pptx to the shared venv
(`scripts/work-tools/fixtures/demo-slides.json` is this in full, with the
five lines pip-lock.ts wrote; the hashes are cut here):

```json
{
  "pillar": "slides",
  "tools": [{
    "name": "python-pptx", "version": "1.0.2", "licence": "MIT",
    "licenceNote": "python-pptx and its dependencies, into the shared venv",
    "homepage": "https://github.com/scanny/python-pptx",
    "needs": ["venv"],
    "platforms": {
      "linux-x64": { "kind": "pip", "packages": ["lxml==6.1.3 --hash=sha256:…", "pillow==13.0.0 --hash=sha256:…", "python-pptx==1.0.2 --hash=sha256:…", "typing_extensions==4.16.0 --hash=sha256:…", "xlsxwriter==3.3.1 --hash=sha256:…"], "bin": "bin/python" },
      "darwin-arm64": { "kind": "pip", "packages": ["…the same lines…"], "bin": "bin/python" }
    },
    "probe": { "steps": [{ "run": ["{bin}", "-I", "-c", "import pptx; print('python-pptx', pptx.__version__)"], "expect": "^python-pptx 1\\.0\\.2" }] }
  }]
}
```

### The installer

```bash
bun scripts/work-tools/install.ts --data <userData>            # every manifest, gently
bun scripts/work-tools/install.ts --data <userData> --plan     # what it would fetch, and how big
bun scripts/work-tools/install.ts --data <userData> --list     # what state.json says
bun scripts/work-tools/install.ts --data <userData> --only libreoffice --force
```

`--data` defaults to `TEMP_CODE_USER_DATA`. Children run at nice 19 (and
idle disk priority on Linux) unless `--not-gentle`. For each tool offered on
this platform, needs first: download into `work-tools/downloads/` (a wrong
size or hash installs nothing), unpack into a `.partial-*` folder, move it to
`work-tools/<name>/<version>/` (a copy already there moved aside), check,
probe, then remove the copy aside, other versions and the download. A check
or probe that fails puts the old copy back and keeps the download for the
next try; a tool that worked before keeps working, with the failure noted on
it (`error: "<version> did not install: …"`). A tool already in place at its
version, on disk, and not older than what it needs is left alone, so a
second run fetches nothing. `--only` takes what the named tools need and
what is built on them (a new venv means its pip tools again). One installer
at a time per userData (`work-tools/.install.lock`, taken over only from a
pid that is gone). Everything it found goes to `work-tools/state.json`
(`ToolchainStateSchema`): per tool `ok`, `dir`, `bin`, `bins`, `bytes`, the
probe's first line or the `error`, the licence. It exits 1 when a tool that
is offered here did not install this time.

`bytes` is what the tool alone holds, so the sizes add up to the folder.
A pip tool shares its venv's folder: after each pip install the venv and
every pip tool in it are measured again (`venvShares`), each pip tool by
the files pip recorded for its packages (their `.dist-info/RECORD`), a
package two tools both list counted once, for the first in manifest order,
and the venv tool by what is left (its interpreter, pip, setuptools).
Every run ends by measuring each venv again, so a record an older
installer wrote (a pip tool at 0 bytes) is put right without a reinstall.

On a packaged Mac the installer is run from a bundle, since the app does not
carry `scripts/`: `bun build scripts/work-tools/install.ts --target=bun
--outfile install.js`, then `bun install.js --data … --manifests <dir with the
json files>`. `scripts/work-tools/convert.ts` (bundled the same way) runs one
job through the runner outside the app: `--data <userData> --from odt --to
docx <input>`.

The host never downloads, unpacks or probes. `Toolchain`
(work/formats/tools.ts) reads `state.json` again whenever its mtime moves, and
a tool is usable when its probe passed and its `bin` is still on disk.

## Jobs

`ctx.convert(job)` (work/formats/jobs.ts) turns `job.input` (a path on this
host) from `job.from` into `job.to` (formats by extension) and resolves to
`{ output, ranOn, warnings }`.

- **Converters** come from every module's `convert` list, keyed by
  `(from, to)` case-insensitively; a second converter for a pair is refused by
  name and the first stays. A `Converter` names the tool it `needs` and its
  `threads`, and its `run(job, run)` writes `job.output` with what `run`
  gives: `tools` (`run.tools.bin('libreoffice')`), the threads granted, a
  `slot` no other running job holds, a scratch `tmp` and `run.run(cmd, args)`
  for a child that the job's signal kills.
- **The toolchain's converters**: LibreOffice between the members of each
  family (text: docx, odt, rtf, doc; slides: pptx, odp, ppt; sheet: xlsx,
  ods, xls, csv) and from each to PDF, every job with its slot's own profile
  (`work-tools/run/libreoffice-profile-<slot>`) so two never share one.
  `options.filter` names a LibreOffice filter (a name, refused otherwise),
  `options.timeoutMs` the limit (5 minutes, at most 10). Each slot's profile
  (`libreoffice-profile-v1-<slot>`) is seeded before its first job with
  macros off, macro security at its highest and untrusted referer links
  blocked (`LIBREOFFICE_PROFILE`). Checked on the box: 26.8 headless leaves a
  linked `file://` or `http://` image and a linked section out of .docx and
  PDF output and fetches nothing.
- **The queue**: a job runs when the host has fewer than its job cap running
  and its threads fit the thread cap (a quarter of the cores in jobs, at most
  4; half the cores in threads; a job asking more than the cap gets the cap).
  The head waits rather than being passed. A job's signal takes it out of
  the queue or kills its child (a forwarded job: see below); turning Work
  off cancels what waits. A slot comes back whatever the job throws.
  Outputs with no `output` named go to `work-tools/jobs/<id>/` and are swept
  after a day.
- **Forwarding**: when the pair's tool is not here, the job goes to the first
  host this one holds a link to (`deps.peers`, the links a Mac or a Windows
  host makes to the box) whose `work.formats.tools` lists the pair (each
  host's answer, or its silence, kept a minute). `work.formats.convert`
  carries the input as base64 and the output comes back the same way,
  written where the job asked; either file is at most 64 MB, since the link
  is one frame each way (100 MiB) and a larger one would close it. The far
  host runs it itself or fails (`here`): a job is never forwarded twice. It
  writes the file under names of its own (`input.<from>`, `output.<to>`),
  never the name sent. The far side needs Work on and the key `operate`.
  A cancel stops this host's wait at once; the far host finishes the run
  (its converter's limit bounds it) and its answer is dropped, since a
  module's `handle` hears no signal from the socket.
- **The wire** (src/shared/contract-work-formats.ts): `work.formats.tools`
  (`read`) answers `ToolsReport`: the tools, the pairs this host runs itself,
  the queue. `work.formats.convert` (`operate`) is the forwarded job; it is
  never carried on a relayed lane.
- **Settings**: `ToolchainRow` (src/renderer/src/work/formats/ToolchainRow.tsx)
  is the one row Settings → Work's "Where it runs" shows: "Conversion tools",
  the usable tools by release, what did not install in red, the size on disk.
  The Work page (milestone 8) mounts it with the host's link.

**Not yet:** the box reaching a Mac-only tool. The box cannot dial a Mac;
that direction goes over `peer.call`, which `ctx.peer` (milestone 6) builds.
Until then the box forwards only over links it made itself (none today), and
every base tool is on the box anyway.

Tests: `scripts/work-tools/installer.test.ts` (a fake download server;
the debs and dmg paths ran only for real, on the box and the Mac),
`work/formats/jobs.test.ts` (two runners as two hosts),
`work/formats/forward.server.test.ts` (a real server and a key's link; with
`TEMP_CODE_WORK_TOOLS_DATA=<a userData the installer filled>` it runs the
real LibreOffice), `ToolchainRow.dom.test.tsx`.
