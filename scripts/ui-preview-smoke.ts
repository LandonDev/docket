import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { JSDOM } from 'jsdom'
import ts from 'typescript'

const renderer = 'src/renderer/src'
const fixturesSuffix = '.fixtures.tsx'
const previewSuffix = '.preview.tsx'
const componentName = (name: string) => name === 'default' || /^[A-Z][\w$]*[a-z][\w$]*$/.test(name)
const legacyTargets: Record<string, string> = {
  'accounts.tsx': 'AccountsView',
  'stats.tsx': 'StatsView',
  'Computers.tsx': 'ComputersBlock',
  'AgentRow.tsx': 'AgentRowView',
  'FleetPanel.tsx': 'FleetSectionsView',
  'MacBridgeRunning.tsx': 'MacBridgeRunningList',
  'status.tsx': 'StatusMark',
}

function exportsOf(path: string, text: string): string[] {
  const names: string[] = []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      names.push('default')
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) names.push(element.name.text)
      }
    } else if (ts.canHaveModifiers(statement)) {
      const modifiers = ts.getModifiers(statement)
      if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
      if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
        names.push('default')
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        names.push(statement.name.text)
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
        }
      }
    }
  }
  return [...new Set(names)]
}

export type PreviewPage = { path: string; name: string }

export function listPreviewPages(files: ReadonlyMap<string, string>, only = ''): PreviewPage[] {
  const pages = new Map<string, PreviewPage>()
  const prefix = only.replace(/^\.\//, '').replace(/^src\/renderer\/src\/?/, '')
  const relative = (path: string) => path.startsWith(renderer + '/') ? path.slice(renderer.length + 1) : path
  const add = (path: string, name: string, discoveredIn = path) => {
    if (relative(path).startsWith(prefix) || relative(discoveredIn).startsWith(prefix)) pages.set(`${path}#${name}`, { path, name })
  }
  const normalize = (name: string) => name.replace(/[^a-z0-9]/gi, '').toLowerCase()

  for (const [path, source] of files) {
    if (path.endsWith(previewSuffix)) {
      for (const name of exportsOf(path, source).filter(componentName)) add(path, name)
    }
    if (!path.endsWith(fixturesSuffix)) continue

    const sibling = path.slice(0, -fixturesSuffix.length) + '.tsx'
    const self = exportsOf(path, source).filter((name) => name !== 'default' && componentName(name))
    const siblingSource = files.get(sibling)
    const siblingNames = siblingSource === undefined ? [] : exportsOf(sibling, siblingSource).filter(componentName)
    const targets = new Set<string>()
    // A fixture can document an alternate export, or carry a frame of its own.
    for (const match of source.matchAll(/([\w./-]+\.tsx)#([\w$]+)/g)) {
      const [, target, name] = match
      if (basename(target) === basename(sibling) && siblingNames.includes(name)) targets.add(name)
      if (basename(target) === basename(path) && self.includes(name)) add(path, name)
    }
    if (sibling.endsWith(previewSuffix) && siblingNames.length) {
      for (const name of siblingNames) add(sibling, name, path)
      continue
    }
    if (!targets.size && self.length) {
      for (const name of self) add(path, name)
    } else if (!targets.size) {
      const stem = normalize(basename(sibling, '.tsx'))
      const matching = siblingNames.find((name) => normalize(name) === stem)
      const legacy = legacyTargets[basename(sibling)]
      if (legacy && siblingNames.includes(legacy)) targets.add(legacy)
      else if (matching) targets.add(matching)
      else if (siblingNames.includes('default')) targets.add('default')
      else if (siblingNames.length === 1) targets.add(siblingNames[0])
      // Report an unmapped fixture instead of silently dropping it.
      if (!targets.size && !self.length) add(path, '(fixture target missing)')
    }
    for (const name of targets) add(sibling, name, path)
  }
  return [...pages.values()].sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name))
}

export function previewVerdict(html: string): string | null {
  // The styles and scripts never contribute fixture markup.
  const body = html.indexOf('<body>')
  const dom = new JSDOM(body === -1 ? html : html.slice(body))
  try {
    const fixtures = [...dom.window.document.querySelectorAll('.preview-fixture')]
    if (!fixtures.length) return 'no fixtures'
    for (const fixture of fixtures) {
      const label = fixture.querySelector('.preview-label')?.textContent ?? 'unnamed fixture'
      const content = fixture.lastElementChild
      if (!content || content.matches('.preview-label') || (!content.children.length && !content.textContent?.trim())) {
        return `${label}: no markup`
      }
      const failed = [...content.querySelectorAll('[data-chunk-failed], [role="alert"]')].find((element) =>
        !element.closest('[data-preview-expected-error]') &&
        (element.hasAttribute('data-chunk-failed') ||
          (element.querySelector('[data-slot="empty-title"]')?.textContent === 'Something broke' &&
            element.querySelector('button')?.textContent?.trim() === 'Reload window')))
      if (failed) return `${label}: React error boundary`
    }
    return null
  } finally {
    dom.window.close()
  }
}

async function sourceFiles(): Promise<Map<string, string>> {
  const entries = await readdir(renderer, { recursive: true })
  const paths = new Set<string>()
  for (const entry of entries) {
    if (!entry.endsWith(fixturesSuffix) && !entry.endsWith(previewSuffix)) continue
    paths.add(join(renderer, entry))
    if (entry.endsWith(fixturesSuffix)) paths.add(join(renderer, entry.slice(0, -fixturesSuffix.length) + '.tsx'))
  }
  const sources = new Map<string, string>()
  await Promise.all([...paths].map(async (path) => {
    try {
      sources.set(path, await readFile(path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.endsWith(fixturesSuffix)) throw error
    }
  }))
  return sources
}

async function renderPage(page: PreviewPage, output: string, shot: boolean): Promise<string | null> {
  if (page.name === '(fixture target missing)') return 'fixture target missing'
  const folder = join(output, dirname(page.path), basename(page.path, '.tsx'))
  const args = ['scripts/ui-preview.ts', `${page.path}#${page.name}`, '--out', folder]
  if (shot) args.push('--shot', '--fresh')
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000) })
  const code = await new Promise<number | null>((done, reject) => {
    child.on('error', reject)
    child.on('close', done)
  })
  if (code !== 0) {
    const error = stderr.split('\n').find((line) => /^(?:\w*Error:|error:)/.test(line.trim()))
    return `exit ${code ?? 'by signal'}${error ? ` (${error.trim()})` : ''}`
  }
  const stem = (page.name === 'default' ? basename(page.path, '.tsx') : page.name).replace(/[^a-zA-Z0-9_-]/g, '_')
  for (const suffix of ['', '.light']) {
    const verdict = previewVerdict(await readFile(join(folder, stem + suffix + '.html'), 'utf8'))
    if (verdict) return verdict
  }
  return null
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { only: { type: 'string' }, shot: { type: 'boolean' }, out: { type: 'string' } }
  })
  const pages = listPreviewPages(await sourceFiles(), values.only)
  const output = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), 'ui-preview-smoke-'))
  let next = 0
  let failures = 0
  try {
    await Promise.all(Array.from({ length: Math.min(8, values.shot ? 2 : 4, pages.length) }, async () => {
      for (;;) {
        const page = pages[next++]
        if (!page) return
        const failure = await renderPage(page, output, !!values.shot).catch((error: unknown) => String(error))
        if (failure) failures++
        console.log(`${failure ? 'FAIL' : 'OK'} ${page.path}#${page.name}${failure ? ` — ${failure}` : ''}`)
      }
    }))
    console.log(`${pages.length} pages, ${failures} failed${values.out ? ` (${output})` : ''}`)
    if (failures || !pages.length) process.exitCode = 1
  } finally {
    if (!values.out && !values.shot) await rm(output, { recursive: true, force: true })
    if (!values.out && values.shot) console.log(output)
  }
}

if (import.meta.main) await main()
