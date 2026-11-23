# Work: conversions, import and export

Milestone 15 of the Work plan built the toolchain and the job runner (this
file's first two parts). Milestone 21 built import and export, the third. [work.md](work.md) says what is mounted for the `formats` pillar
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
  - `build`: a tool compiled on the host against a library tree of its own.
    Each file is put in place (a `.deb` extracted with `dpkg-deb -x`, an
    archive unpacked, a `raw` file kept), then the entry's `build` steps
    run in the tool's own folder, where it will stay, with the host's
    compiler. The steps take the probe's placeholders. Nothing is installed
    on the system and no root is used. The browser pillar's `screen-relay`
    tool uses it ([live-video.md](live-video.md)), and the Windows VM's
    `qemu-window`, whose one step puts QEMU's two window modules in a folder
    of their own ([work-winvm.md](work-winvm.md))
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
    run on that platform adds its line (the probe says so). A wheel PyPI does
    not carry is named by its https address, `name @ https://….whl
    --hash=sha256:…` (the CPU builds of torch, which only download.pytorch.org
    has; formats.json's `docling`), and locked by hand. Its folder is the venv's and its `bin` is the venv's
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
- **A renderer that is an app or a machine** (real Word, Excel and
  PowerPoint; [work-editors.md](work-editors.md) has the full account): a
  format's name may say who draws it after a plus (`pdf+word`; the file's
  extension is the part before it, `extOf`); a converter may give
  `ready(job)` (`ready`, `asleep`, `not open`, `none`), asked when the job
  comes and told in `work.formats.tools`; a job carries his press only as an
  object `pressOf(by)` made on this host for a person's window call, and only
  such a job may run a converter that is asleep; a job with `shared: true`
  (a shared library's file) is never carried to another host.
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
  host makes to the box) whose `work.formats.tools` lists the pair as ready
  (each host's answer, or its silence, kept a minute; a host that says the
  pair is asleep or not open is passed over, and named in the refusal when
  none is ready). What crosses is the pair, the file and the converter's own
  switches: never the press. `work.formats.convert`
  carries the input as base64 and the output comes back the same way,
  written where the job asked; either file is at most 64 MB, since the link
  is one frame each way (100 MiB) and a larger one would close it (the far
  host refuses its own output past the cap, and this host refuses one that
  came back past it before keeping any of it). The far
  host runs it itself or fails (`here`): a job is never forwarded twice. It
  writes the file under names of its own (`input.<from>`, `output.<to>`),
  never the name sent. The far side needs Work on and the key `operate`.
  A cancel stops this host's wait at once; the far host finishes the run
  (its converter's limit bounds it) and its answer is dropped, since a
  module's `handle` hears no signal from the socket.
- **The wire** (src/shared/contract-work-formats.ts): `work.formats.tools`
  (`read`) answers `ToolsReport`: the tools, the pairs this host runs itself
  (each with a `state` when it is asleep or not open), the queue. `work.formats.convert` (`operate`) is the forwarded job; it is
  never carried on a relayed lane.
- **Settings**: the pillar's `health` (work/formats/health.ts) answers for
  the toolchain on Settings → Connections ([work-connections.md](work-connections.md)):
  "Conversion tools", the usable tools by release, and a broken row for each
  that did not install, naming the command that installs it again.

**Not yet:** the box reaching a Mac-only tool. The box cannot dial a Mac;
that direction goes over `peer.call` (`ctx.peer`, built in milestone 6),
which the job runner does not use: it forwards only over links this host
made itself (`deps.peers`; the box has none), and every base tool is on the
box anyway.

Tests: `scripts/work-tools/installer.test.ts` (a fake download server;
the debs and dmg paths ran only for real, on the box and the Mac),
`work/formats/jobs.test.ts` (two runners as two hosts),
`work/formats/forward.server.test.ts` (a real server and a key's link; with
`TEMP_CODE_WORK_TOOLS_DATA=<a userData the installer filled>` it runs the
real LibreOffice), `work/formats/health.test.ts`.

## Import and export

Milestone 21. The readers and writers are work-kit's (`work-kit/src/formats`,
its README is the account): our own .docx reader and writer (the formats
report, `.temp-code/reports/hIIKbJY4UKbv.md`, picked both: no other pipeline
kept comments, replies, resolved state, tracked changes, notes, page breaks,
headers and columns, and every `@blocknote/xl-*` package is GPL), markdown
with front matter kept, HTML through DOMPurify and an Office clean-up, the
`.tcdoc` an import makes, and the export of a live document. The pillar's
files: `formats/pillar.ts` (the methods), `importer.ts`, `exporter.ts`,
`print.ts`, `pdfIn.ts`, `preview.ts`, `serviceRoutes.ts`; the window's in
`src/renderer/src/work/formats/` (`PreviewFrame.tsx`, `PagedView.tsx`, `preview.ts`, `previewContract.ts`, `command.ts`, `Import.tsx`, `model.ts`).

**In** (`work.formats.import`, `operate`, → `ImportAnswer`): from a file on
this host (`{at: 'source'}`: the canvas opened it; the path fence holds a
remote key to its roots), a dropped file's bytes (`{at: 'bytes'}`: kept in the
thread's Work workspace folder, or `<userData>/attachments/work-imports` for
a Work Chat), or HTML the window read into blocks (`{at: 'blocks'}`). The
document is `<name>.tcdoc` beside the original (`<name> 2.tcdoc` and on when
taken); the original is never touched. **An original that lies where others
can open it** (a Teams or OneDrive library, any cloud folder; `sharedOf`,
work/files/policy.ts) gets no file beside it: OneDrive would sync the copy to
the team. Its `.tcdoc` goes under `<userData>/work-files/imports/<hash>/`
instead, one folder per source file (work/files/imports.ts `importFolderOf`),
for every imported type and every opener, a thread's `canvas_open` included.
The opener may be a pane owner as well as a thread (the Files place's tab):
a dropped file's bytes are then kept in that pane's workspace folder, and
the item it replaces is swapped through `ctx.canvas.replace`, so a Files tab
follows to the document.
- `.docx`: `readDocx`. `.odt`, `.rtf`, `.doc`: LibreOffice to `.docx`
  (`ctx.convert`, the toolchain's pairs), then the same reader. `.md`:
  `readMarkdown`. `.pdf`: pymupdf4llm to markdown (`pdf → md`, `pdfIn.ts`);
  then Docling, where the host has it (the box), when pymupdf4llm reads next
  to no text (a scan: Docling's OCR reads the page pictures) or PyMuPDF finds
  tables on the pages (Docling reads tables and columns better, and keeps no
  bold or italic); the warning says which (`needsDocling`). `.html`: read in
  the window only.
- The live text is the original, before anyone's tracked change; an `import`
  version is cut of it; each author of tracked changes gets one pending branch,
  `external:<name>`, which the canvas steps and Accept and Reject decide.
  Comment threads go into `work_docs_threads` (authors `external:<name>`,
  Word's dates, replies, resolved), their marks on the words.
- With `sessionId` the document opens in that thread's canvas and `itemId`
  (the Word file's own item) closes. The answer says `outsiders` when the file
  carried other people's comments or changes: such a file is shared from the
  start (§3, §8.4), which `scope.shared` and `work.docs.open` must answer from
  M31's link rows; today a `.tcdoc` is `shared: false` everywhere.
- What could not be kept comes back as `warnings`, a person's words (a picture
  in a table cell, a nested table, a paragraph-format change); the window
  shows them in one toast.

- A mail's attachment (`{at: 'source'}` naming `{at: 'mail'}` and its `itemId`) is read from the copy the host fetched into the item's folder into `<name>.tcdoc` beside it, once (asked again, the answer is the same document), and nothing opens or closes: the docs pillar holds it read only (work-mail.md "Attachments").

**Out** (`work.formats.export`, `read`, → `ExportAnswer` with the file as
base64): main reads the thread rows and names and asks the Work service's
`/internal/formats/export`, which reads the live state, the pending branches
(`history.branches`) and the threads' marks and writes Word
(`documentForExport`, `writeDocx`: branches as `w:ins`/`w:del` with their
authors, threads as Word comments, a `.tcdoc`'s stored sidecar for notes and
the page) or markdown. OpenDocument and RTF are that Word file through
LibreOffice (RTF keeps no comment replies). HTML is made in the window
(`htmlDocument`, from the editor's blocks); PDF is the same page laid out for
paper (A4, or Letter in a US-style locale) and printed by
`work.formats.print` (`operate`) in a hidden Electron window with no script
and no network (`print.ts`; a test hands in its own printer). A LifeOS
document another host serves is asked of that host.

**Preview renders** (`work.formats.preview`, `operate`, → `PreviewAnswer`;
`work.formats.previewRead`, `read`; `formats/preview.ts`): the host side of a
document's Preview (work-editors.md "Preview: the contract"). Both hold the
caller to the document as Export does (`targetOf`: a file must be within the
caller's reach; a LifeOS document is held to the caller's sectors by the Work
service when it is read, as it always was, not by a path).
- Only the picture is kept, a PDF. The file itself is Export's to write
  (`work.formats.export`), which needs no renderer for Word: a host that
  cannot draw Word still exports it.
- `pdf` prints the window's print page as `work.formats.print` does
  (`drawnBy: 'tempcode'`); the picture is the file. `docx`, `odt` and `rtf`
  take Word from the Work service as Export does (`serviceExport`, shared
  with `exportDoc`); OpenDocument and RTF are converted from it, and
  LibreOffice draws the PDF from the exported file itself, never from the Word
  file (`drawnBy: 'libreoffice'`). Every job carries `shared` from
  `madeFromShared`. Warnings are Export's dropped words and each job's, once.
- A render is kept by `rev`, the first 32 hex of a sha256 over the format, a
  zero byte and what it was made from: the page and the paper, or what the
  Word file holds (`wordContent`: each zip entry by name, without the zip's
  times and core.xml's `dcterms:created` and `modified`, which change on every
  export). A render kept under that rev answers again without printing or
  converting.
- Kept under `<userData>/formats/.cache/preview/<thread>/<item>/<source>/`
  for a canvas item (an item not open is refused, and so is one that does
  not show this document: `NOT_THIS_ITEM`; a mail's attachment and the
  document read from it are one item), or `_/<source>/` with none, `<source>` being a hash of the source the caller was let through to
  (`sourceKey`): naming an item reads nothing made from another source. A
  file others can open (`madeFromShared`) has no render without an item
  (`NEEDS_ITEM`): nothing made from it may outlive its tab. Folders 0700, each
  part a plain name. The box's backup leaves
  out every `**/.cache`, so no render rides it. Per format:
  `<format>.<rev>.pdf` (the picture) and `.json` (the answer, written
  last), each through a temp name and a rename;
  a new render deletes that format's older ones, and a read of a rev that went
  is refused with "that preview is gone: draw it again".
- `previewRead` reads at most `PREVIEW_READ_MAX` (the schema refuses more)
  from an offset, without loading the whole file; past the end it answers
  empty. Pages are counted by pdf-lib, or by `/Type /Page` objects when it
  cannot read the PDF, never fewer than one.
- A deleted thread takes `<thread>/` (`sessionsRemoved`), a deleted item its
  folder (`itemsRemoved`); the pillar's `start` sweeps `_/` folders untouched
  for a day, then hourly.

**The window.** The document kind's ⋯ has Export…, which opens Preview on
the format he last used (work-docs.md "Preview"; the frame is
work-editors.md's): Word, PDF, Markdown, Web page, OpenDocument, Rich Text,
each drawn as the file it will be, with what it drops beside it and Export as
the one verb. A file dropped on an open document
opens beside it as a document (a muted wash says so while it is over). A copy
from a document is written for mail and sheets (`mailSafeCopy`): email-safe
`text/html` (styles inline, tables with borders, colours and widths as
attributes) and, for a copy that is one table, tab-separated `text/plain`; the
editor's own `blocknote/html` stays, so a paste back into a document is
unchanged.

**The tools.** `scripts/work-tools/formats.json`: pymupdf4llm 2.1 with PyMuPDF
2.1 (AGPL: a separate, unmodified Python process; the rest of the closure
is permissive), pinned by `pip-lock.ts`, 277 MB in the shared venv; and, on
linux-x64 only, Docling 2.151.0 in a venv of its own (`docling-venv`, since
its closure would fight the shared venv's pins) with the CPU builds of torch
2.14.1 and torchvision 0.29.1 from download.pytorch.org and 100 more wheels,
all permissive (MIT, Apache-2.0, BSD, PSF, MPL-2.0 for certifi), 1.6 GB; and
`docling-models` (397 MB): docling-layout-heron (Apache-2.0), TableFormer
accurate (CDLA-Permissive-2.0) and RapidOCR's PP-OCRv6 small torch weights
(Apache-2.0), each fetched by URL and checksum and read offline
(`--artifacts-path`, `HF_HUB_OFFLINE`). All installed and probed on the box
(2026-11-19; the models' probe converts a PDF offline). The Mac has neither:
its PDF imports read with what it has, or forward to the box.

Tests: work-kit's `formats/docx/matrix.test.ts` (the report's 16-file matrix,
no worse than its reader and writer), `formats/tcdoc/tcdoc.test.ts` (branches
per author through a real history; the export of a live document),
`formats/html/html.jsdom.ts`; here `work/formats/importExport.test.ts` (the
service in process; with `TEMP_CODE_WORK_TOOLS_DATA` the round trips through
the real LibreOffice, pymupdf4llm and Docling: a scan and a PDF of tables) and
`src/renderer/src/work/formats/formats.dom.test.tsx`.
