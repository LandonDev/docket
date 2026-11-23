/**
 * Writes THIRD-PARTY-NOTICES.md: what the app ships from others, with each
 * package's licence and copyright lines, the NOTICE files Apache-2.0 asks
 * to be passed on, the Univer files work-kit changes, and the tools the host
 * installs and runs beside it as separate, unmodified processes.
 *
 *   bun scripts/third-party-notices.ts          write the file
 *   bun scripts/third-party-notices.ts --check  exit 1 when it is stale
 *
 * "Shipped" is the closure of package.json's `dependencies` (copied into the
 * app as they are) and of the devDependencies the bundler puts into the
 * app's own files (BUNDLED). scripts/thirdPartyNotices.test.ts holds the
 * closure to the licence rule.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
export const NOTICES_FILE = join(ROOT, 'THIRD-PARTY-NOTICES.md')

/** devDependencies whose code the bundler copies into out/ (main, renderer, the Work service, the hosted pages). */
export const BUNDLED = [
  'react', 'react-dom', 'pdfjs-dist', 'work-kit', 'y-prosemirror', 'y-protocols', 'convex',
  '@modelcontextprotocol/sdk', '@muse-code/sdk', '@base-ui/react', '@codemirror/autocomplete',
  '@codemirror/commands', '@codemirror/lang-css', '@codemirror/lang-html', '@codemirror/lang-javascript',
  '@codemirror/lang-json', '@codemirror/lang-markdown', '@codemirror/lang-python', '@codemirror/lang-rust',
  '@codemirror/language', '@codemirror/lint', '@codemirror/merge', '@codemirror/search', '@codemirror/state',
  '@codemirror/view', '@hugeicons/core-free-icons', '@hugeicons/react', '@lezer/common', '@lezer/highlight',
  '@shikijs/monaco', '@tanstack/react-virtual', '@xterm/xterm',
  'aliax-core', 'class-variance-authority', 'clsx', 'codemirror', 'cuelume', 'mermaid', 'monaco-editor',
  'motion', 'prettier', 'qrcode', 'react-material-icon-theme', 'recharts', 'rehype-harden', 'shiki',
  'simple-icons', 'sonner', 'streamdown', 'tailwind-merge', 'tailwindcss', 'tw-animate-css', 'unified',
  'zustand'
] as const

/** Licences allowed in what we ship (the master's ruling of 2026-11-19), SPDX ids. */
export const PERMISSIVE = new Set([
  'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'MPL-2.0', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense',
  'Python-2.0', 'Zlib', 'CC-BY-4.0', 'CC-BY-3.0', 'OFL-1.1', 'W3C', 'WTFPL', 'Artistic-2.0'
])

/** Packages whose licence is not on the list, each with the reason it may ship. */
export const ALLOWED_OTHERWISE: Record<string, string> = {
  '@anthropic-ai/claude-agent-sdk': "Anthropic's own terms (its LICENSE.md): the SDK and the Claude Code CLI it carries, used as Anthropic offers them.",
  'work-kit': "Landon Hale's own private package, shared with LifeOS."
}

export interface Pkg {
  name: string
  version: string
  licence: string
  dir: string
  copyright: string[]
  notice: string | null
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'))

/** Node's lookup: the nearest node_modules above `from` that holds `name`. */
function locate(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) return dirname(candidate)
    if (dir === ROOT || dirname(dir) === dir) return null
  }
}

/** SPDX from `license`, the old `licenses` array, or the licence file's first words. */
export function licenceOf(pkg: Record<string, unknown>, dir: string): string {
  const l = pkg.license ?? pkg.licence
  if (typeof l === 'string') return l.replace(/^\((.*)\)$/, '$1')
  if (l && typeof l === 'object' && 'type' in l) return String((l as { type: string }).type)
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((x: { type?: string }) => x.type ?? '?').join(' OR ')
  const text = licenceText(dir) ?? ''
  if (/MIT License|Permission is hereby granted, free of charge/i.test(text)) return 'MIT'
  if (/Apache License,?\s+Version 2\.0/i.test(text)) return 'Apache-2.0'
  if (/ISC License/i.test(text)) return 'ISC'
  return 'UNKNOWN'
}

const LICENCE_FILE = /^(licen[cs]e|copying)(\..*)?$/i
const NOTICE_FILE = /^notice(\..*)?$/i

function fileMatching(dir: string, re: RegExp): string | null {
  const hit = readdirSync(dir).find((f) => re.test(f))
  return hit ? join(dir, hit) : null
}

function licenceText(dir: string): string | null {
  const file = fileMatching(dir, LICENCE_FILE)
  return file ? readFileSync(file, 'utf8') : null
}

/** The licence file's own copyright lines, which MIT, BSD and ISC ask to be kept. */
export function copyrightLines(text: string | null): string[] {
  if (!text) return []
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(copyright\b|\(c\)\s|©)/i.test(l) && /\b(19|20)\d\d\b|©|\(c\)/i.test(l))
    .filter((l) => !/copyright (notice|holders?|owner|license)\b|license to|you must|\[yyyy\]|\{yyyy\}|<year>/i.test(l))
  return [...new Set(lines)].slice(0, 6)
}

/** Every package shipped: the closure of `dependencies` and of BUNDLED, sorted by name then version. */
export function shippedPackages(): Pkg[] {
  const root = readJson(join(ROOT, 'package.json'))
  const seen = new Map<string, Pkg>()
  const queue: Array<[string, string]> = [...Object.keys((root.dependencies ?? {}) as object), ...BUNDLED].map((n) => [n, ROOT])
  while (queue.length) {
    const [name, from] = queue.shift()!
    const dir = locate(name, from)
    if (!dir || seen.has(dir)) continue
    const pkg = readJson(join(dir, 'package.json'))
    const notice = fileMatching(dir, NOTICE_FILE)
    seen.set(dir, {
      name,
      version: String(pkg.version ?? ''),
      licence: licenceOf(pkg, dir),
      dir,
      copyright: copyrightLines(licenceText(dir)),
      notice: notice ? readFileSync(notice, 'utf8').trim() : null
    })
    // Optional dependencies are a package's builds for each platform, under the package's own licence; which are
    // installed depends on the host, so they are left out and the file reads the same wherever it is written.
    for (const dep of Object.keys((pkg.dependencies ?? {}) as object)) if (!((pkg.optionalDependencies ?? {}) as object).hasOwnProperty(dep)) queue.push([dep, dir])
  }
  const byKey = new Map<string, Pkg>()
  for (const p of seen.values()) byKey.set(`${p.name}@${p.version}`, p)
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

/** True when every alternative or every part of an SPDX expression is allowed: `A OR B` needs one, `A AND B` needs both. */
export function allowed(expr: string): boolean {
  const e = expr.replace(/[()]/g, ' ').trim()
  if (/\bOR\b/.test(e)) return e.split(/\s+OR\s+/).some((part) => allowed(part))
  if (/\bAND\b/.test(e)) return e.split(/\s+AND\s+/).every((part) => allowed(part))
  return PERMISSIVE.has(e.replace(/\s+WITH\s+.*$/, '').trim())
}

interface Tool {
  name: string
  version: string
  licence: string
  licenceNote?: string
  pillar: string
}

function tools(): Tool[] {
  const dir = join(ROOT, 'scripts', 'work-tools')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      const m = readJson(join(dir, f)) as { pillar?: string; tools?: Tool[] }
      return (m.tools ?? []).map((t) => ({ ...t, pillar: m.pillar ?? f.replace(/\.json$/, '') }))
    })
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

export function render(pkgs = shippedPackages()): string {
  const out: string[] = []
  out.push(
    '# Third-party notices',
    '',
    'TempCode is Landon Hale\'s own code and carries no licence of its own. This file lists what it ships from others, with each licence and copyright line, and the tools it runs beside it. `bun scripts/third-party-notices.ts` writes it from `node_modules` and the tool manifests; `scripts/thirdPartyNotices.test.ts` checks that it names every shipped package and that each licence is allowed.',
    '',
    '## Changed files we carry',
    '',
    'work-kit (bundled into the app) changes Univer 1.5.2\'s formula engine (`@univerjs/engine-formula`, Apache-2.0, Copyright 2023-present DreamNum Co., Ltd.) by replacing two of its services in `work-kit/src/sheet/engine/`: `dependency-generator.ts` subclasses `FormulaDependencyGenerator` and plans a calculation from the cells an edit can reach in place of the whole workbook, reading three of its private members; `dependency-manager.ts` and `dedup-rtree.ts` replace `DependencyManagerService`\'s index with one that removes exactly what it inserted. `plugin.ts` registers both in place of Univer\'s own. These files are our changes to Univer; Univer\'s own files ship unmodified. Univer\'s licence is Apache-2.0, given below.',
    '',
    'pdf.js\'s character maps, two standard fonts and two image decoders ship as lazy assets, each beside its own licence notice (`src/renderer/src/work/pdf/pdfjsData.ts`). The JetBrains Mono font ships under the SIL Open Font License 1.1 (`src/renderer/src/assets/fonts/JetBrainsMono-OFL.txt`). Electron carries its own notices for Chromium and Node.js inside the app (`LICENSES.chromium.html`).',
    '',
    'A file\'s fonts ship as twenty WOFF2 files from work-kit (`work-kit/src/fonts/files`), each the TrueType file LibreOffice 26.8.3 carries, re-encoded and otherwise unchanged, so each keeps its name and the copyright and licence lines in its name table: Carlito (drawn for Calibri; SIL Open Font License 1.1; Copyright (c) 2010-2013 by tyPoland Lukasz Dziedzic with Reserved Font Name "Carlito"), Liberation Sans, Serif and Mono 2.1.5 (drawn for Arial, Times New Roman and Courier New; SIL Open Font License 1.1; Digitized data copyright (c) 2010 Google Corporation, Copyright (c) 2012 Red Hat, Inc.) and Caladea (drawn for Cambria; Apache-2.0, given below; Copyright (c) 2012 Huerta Tipografia). The licence texts are beside the files (`work-kit/src/fonts/licences`), with a note on why the names are kept: nothing is subsetted or renamed, and anyone who changes these files must rename them.',
    '',
    'Live video speaks screen-relay\'s wire (github.com/vercel-labs/screen-relay, version 0.1.2, Apache-2.0, given below). `src/shared/video/nsl1.ts` is ported from its `src/protocol/index.ts` and PROTOCOL.md and says in its head what was changed: only the frame, the ack and the input message are kept, and a frame encoder is added. screen-relay\'s engine itself is not in the app: it is a tool, below.',
    '',
    '## Tools run as separate processes',
    '',
    'The host installs these on demand under `<userData>/work-tools/` (scripts/work-tools/*.json) and runs each as its own process; none is linked into TempCode, bundled with it or changed. ONLYOFFICE (AGPL-3.0), PyMuPDF (AGPL-3.0), ffmpeg (GPL-3.0) and x264 (GPL-2.0-or-later, behind screen-relay\'s engine on the box) are among them: each runs unmodified as a separate program, and ONLYOFFICE\'s editor is never offered to a guest.',
    '',
    '| Tool | Version | Licence | Pillar | How it is used |',
    '|---|---|---|---|---|'
  )
  for (const t of tools()) out.push(`| ${cell(t.name)} | ${cell(t.version)} | ${cell(t.licence)} | ${t.pillar} | ${cell(t.licenceNote ?? '')} |`)
  out.push(
    '',
    'The speech models credit their makers as CC BY 4.0 asks: Parakeet TDT 0.6B v2 by NVIDIA (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/), converted to ONNX int8 by the sherpa-onnx project; the WeSpeaker ResNet34-LM speaker model by the WeSpeaker project, trained on VoxCeleb (CC BY 4.0), as exported by sherpa-onnx. Neither is changed.',
    '',
    '## Packages shipped in the app',
    '',
    `${pkgs.length} packages. A package's builds for each platform (its optional dependencies) ship under its own licence and are not listed apart.`,
    '',
    '| Package | Version | Licence | Copyright |',
    '|---|---|---|---|'
  )
  for (const p of pkgs) out.push(`| ${p.name} | ${p.version} | ${cell(p.licence)} | ${cell(p.copyright.join('; '))} |`)
  const withNotice = pkgs.filter((p) => p.notice)
  if (withNotice.length) {
    out.push('', '## NOTICE files', '', 'As Apache-2.0 asks, each NOTICE a shipped package carries, as it is.')
    for (const p of withNotice) out.push('', `### ${p.name} ${p.version}`, '', '```text', p.notice!, '```')
  }
  out.push('', '## Licence texts', '', 'Each package\'s full licence is in its folder under the app\'s `node_modules`. The texts most of them use:')
  const apache = locate('@univerjs/engine-formula', locate('work-kit', ROOT) ?? ROOT)
  const apacheText = apache ? licenceText(apache) : null
  if (apacheText) out.push('', '### Apache-2.0', '', '```text', apacheText.trim(), '```')
  out.push(
    '',
    '### MIT',
    '',
    '```text',
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
    '```',
    ''
  )
  return out.join('\n')
}

if (import.meta.main) {
  const text = render()
  if (process.argv.includes('--check')) {
    const now = existsSync(NOTICES_FILE) ? readFileSync(NOTICES_FILE, 'utf8') : ''
    if (now !== text) {
      console.error('THIRD-PARTY-NOTICES.md is stale: run bun scripts/third-party-notices.ts')
      process.exit(1)
    }
  } else {
    writeFileSync(NOTICES_FILE, text)
    console.log(`wrote ${NOTICES_FILE}`)
  }
}
