import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'

const root = resolve(import.meta.dirname, '..')
const script = join(root, 'scripts/ui-preview.ts')
const dirs: string[] = []
const pages: string[] = []

const clear = (): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const page of pages.splice(0)) rmSync(page, { force: true })
}
afterEach(clear)
// A run cut short (a timeout, a gate that stops the worker) skips afterEach; the worker's exit still clears what it made.
// A kill with no exit can still leave one: .gitignore holds scripts/.ui-preview-test-*/, so it never makes the tree dirty.
process.once('exit', clear)

function run(args: string[], cwd = root) {
  return spawnSync('bun', [script, ...args], { cwd, encoding: 'utf8', timeout: 60_000 })
}

function output(name: string) {
  const dark = `/tmp/ui-preview/${name}.html`
  const light = `/tmp/ui-preview/${name}.light.html`
  pages.push(dark, light)
  return { dark: readFileSync(dark, 'utf8'), light: readFileSync(light, 'utf8') }
}

function temporaryComponent(source: (name: string) => string) {
  // Keep imports under the repo so Bun can find React and the root tsconfig.
  const dir = mkdtempSync(join(root, 'scripts/.ui-preview-test-'))
  dirs.push(dir)
  const name = `Preview${randomUUID().replaceAll('-', '')}`
  writeFileSync(join(dir, 'sample.tsx'), source(name))
  return { dir, name, target: `sample.tsx#${name}` }
}

describe('ui-preview and import.meta.glob', () => {
  it('expands an eager glob into the files it names, keyed as written', async () => {
    const { expandGlobs } = await import('./lib/previewGlobs')
    const dir = mkdtempSync(join(root, 'scripts/.ui-preview-test-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'fonts'))
    for (const name of ['a.woff2', 'b.woff2', 'c.txt']) writeFileSync(join(dir, 'fonts', name), '')
    const source = [
      'const found = import.meta.glob("./fonts/*.woff2", { query: "?url", import: "default", eager: true }) as Record<string, string>;',
      'const two = import.meta.glob<string>(',
      '  ["./fonts/c.txt", "./fonts/a.woff2"],',
      '  { eager: true },',
      ');',
    ].join('\n')
    const out = expandGlobs(source, join(dir, 'module.ts'))
    expect(out).not.toContain('import.meta.glob')
    const maps = [...out.matchAll(/\((\{.*?\}) as Record<string, string>\)/g)].map((match) => JSON.parse(match[1]) as Record<string, string>)
    expect(Object.keys(maps[0])).toEqual(['./fonts/a.woff2', './fonts/b.woff2'])
    expect(maps[0]['./fonts/a.woff2']).toBe(`file://${join(dir, 'fonts/a.woff2')}`)
    expect(Object.keys(maps[1])).toEqual(['./fonts/c.txt', './fonts/a.woff2'])
  })

  it('lists every renderer module that calls it, so a page that reaches one draws', async () => {
    const { GLOB_MODULES } = await import('./lib/previewGlobs')
    const found = spawnSync('grep', ['-rl', '--include=*.ts', '--include=*.tsx', '--exclude=*.test.ts', '--exclude=*.test.tsx', 'import\\.meta\\.glob', 'src/renderer/src'], { cwd: root, encoding: 'utf8' })
    expect(found.stdout.trim().split('\n').filter(Boolean).sort()).toEqual([...GLOB_MODULES].sort())
  })
})

describe('ui-preview', () => {
  it("leaves nothing a publish would call a dirty tree: git ignores the sample folders, even one a killed run left", () => {
    const left = spawnSync('git', ['check-ignore', '-q', 'scripts/.ui-preview-test-AbC123/sample.tsx'], { cwd: root })
    expect(left.status).toBe(0)
  })

  it('renders a named renderer export with JSON props in both themes', () => {
    const result = run([
      'src/renderer/src/components/ui/button.tsx#Button',
      '--props', '{"children":"Save","onClick":"fn"}'
    ])
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const html = output('Button')
    for (const page of Object.values(html)) {
      expect(page).toContain('<!doctype html>')
      expect(page).toContain('data-slot="button"')
      expect(page).toContain('t-raise-primary text-primary-foreground')
      // A class such as has-[>svg:first-child] puts a raw > inside a quoted attribute.
      expect(page).toMatch(/<button(?:[^>"]|"[^"]*")*>Save<\/button>/)
      expect(page).toContain('width: 480px')
      expect(page).not.toContain('<script')
    }
    expect(html.dark).toContain('<html lang="en">')
    // Each page names its own theme and links the other one.
    expect(html.dark).toContain('Dark theme</h1>')
    expect(html.dark).toContain('>Open the light theme</a>')
    expect(html.light).toContain('Light theme</h1>')
    expect(html.light).toContain('>Open the dark theme</a>')
    expect(html.dark).toContain('Button.light.html')
    expect(html.light).toContain('<html lang="en" class="theme-light">')
    expect(html.light).toContain('Button.html')
    expect(result.stdout).toContain('/tmp/ui-preview/Button.html\n/tmp/ui-preview/Button.light.html\n')
  })

  it('reads the markup once it settles, so a count ticking up shows where it lands', () => {
    const { dir, target, name } = temporaryComponent((name) => `
      import { useEffect, useState } from 'react'
      export function ${name}() {
        // A count ticking up, as useCountUp does: it changes every 20ms until it lands.
        const [n, setN] = useState(0)
        useEffect(() => {
          if (n >= 5) return
          const timer = setTimeout(() => setN(n + 1), 20)
          return () => clearTimeout(timer)
        }, [n])
        return <span>{n === 5 ? 'settled' : n}</span>
      }
    `)
    const result = run([target], dir)
    expect(result.status, result.stderr).toBe(0)
    expect(output(name).dark).toContain('<span>settled</span>')
  })

  it('stubs CSS and nested callbacks, resolves aliases, and notes missing styles once', () => {
    const { dir, name, target } = temporaryComponent((name) => `
      import './sample.css'
      import { cn } from '@renderer/lib/cn'
      import { motion } from 'motion/react'
      export function ${name}({ children, onReady, nested }) {
        onReady()
        nested.callbacks[0]()
        return <motion.div className={cn('sample', 'static')}>{children}</motion.div>
      }
    `)
    writeFileSync(join(dir, 'sample.css'), 'This is deliberately not valid CSS or JavaScript.')
    const result = run([target, '--props', JSON.stringify({
      children: '<Save & close>', onReady: 'fn', nested: { callbacks: ['fn'] }
    }), '--width', '320'], dir)
    expect(result.status, result.stderr).toBe(0)
    const html = output(name)
    expect(result.stdout.split('\n').filter((line) => line.startsWith('No built stylesheet')))
      .toEqual(['No built stylesheet at out/renderer/assets/*.css; writing previews without it.'])
    for (const page of Object.values(html)) {
      expect(page).toContain('width: 320px')
      expect(page).toContain('class="sample static"')
      expect(page).toContain('&lt;Save &amp; close&gt;')
      expect(page).not.toContain('deliberately not valid')
    }
  })

  it('resolves every alias of tsconfig.web.json and renders a store-backed component', () => {
    // @server/shared and @shared are the renderer's own aliases; a store read
    // through useSyncExternalStore has no server snapshot, so the render is a
    // client one into a document.
    const { dir, name, target } = temporaryComponent((name) => `
      import { useSyncExternalStore } from 'react'
      import { emptyNotes } from '@shared/notes'
      import { notesEmpty } from '@server/shared/notes'
      import { cn } from '@renderer/lib/cn'
      const subscribe = () => () => {}
      export function ${name}() {
        const empty = useSyncExternalStore(subscribe, () => notesEmpty(emptyNotes()))
        return <p className={cn('live')}>{empty ? 'notes empty' : 'notes written'}</p>
      }
    `)
    const result = run([target], dir)
    expect(result.status, result.stderr).toBe(0)
    const html = output(name)
    expect(html.dark).toContain('notes empty')
    expect(html.light).toContain('notes empty')
  })

  it('renders the transcript fixture files, named exports included, in both themes', () => {
    for (const [target, name, exported] of [
      ['src/renderer/src/surfaces/transcript/ActionGroup.tsx#ActionGroup', 'ActionGroup', 'fixtures'],
      ['src/renderer/src/surfaces/transcript/ActivityRow.tsx#ActivityRow', 'ActivityRow', 'ACTION_FIXTURES'],
    ] as const) {
      const result = run([target])
      expect(result.status, `${exported}: ${result.stderr}`).toBe(0)
      const html = output(name)
      const labels = (page: string) => page.match(/class="preview-label"/g)?.length ?? 0
      expect(labels(html.dark), name).toBeGreaterThanOrEqual(3)
      expect(labels(html.light)).toBe(labels(html.dark))
      expect(html.light).toContain('class="theme-light"')
    }
  }, 60_000)

  it('discovers adjacent fixtures and renders each name and its props in both pages', () => {
    const { dir, name, target } = temporaryComponent((name) => `
      export function ${name}({ children, disabled, onReady, title }) {
        onReady()
        return <button disabled={disabled} title={title}>{children}</button>
      }
    `)
    writeFileSync(join(dir, 'sample.fixtures.tsx'), `export default [
      { name: 'Ready <now>', props: { children: 'Save', onReady: 'fn' } },
      { name: 'Unavailable', props: { children: 'Waiting', disabled: true, onReady: () => {} } }
    ]`)
    const result = run([target, '--props', '{"title":"Shared","children":"Overridden"}'], dir)
    expect(result.status, result.stderr).toBe(0)
    for (const page of Object.values(output(name))) {
      expect(page).toContain('class="preview-label">Ready &lt;now&gt;</div>')
      expect(page).toContain('class="preview-label">Unavailable</div>')
      expect(page).toContain('<button title="Shared">Save</button>')
      expect(page).toContain('<button disabled="" title="Shared">Waiting</button>')
      expect(page).toContain('font-size: 11px')
      expect(page).not.toContain('Overridden')
    }
  })

  it('prefers fixtures for the selected export when components share a module', () => {
    const { dir, name, target } = temporaryComponent((name) => `
      export function ${name}({ children }) { return <span>{children}</span> }
    `)
    writeFileSync(join(dir, 'sample.fixtures.tsx'), `
      export const ${name}Fixtures = [{ name: 'Named case', props: { children: 'Named fixture' } }]
      export default [{ name: 'Default case', props: { children: 'Default fixture' } }]
    `)
    const result = run([target], dir)
    expect(result.status, result.stderr).toBe(0)
    expect(output(name).dark).toContain('<span>Named fixture</span>')
  })

  it('captures a fixture after it opens state through a real control', () => {
    const { dir, name, target } = temporaryComponent((name) => `
      import { useState } from 'react'
      export function ${name}() {
        const [open, setOpen] = useState(false)
        return <button onClick={() => {
          window.dispatchEvent(new Event('fixture-open'))
          setOpen(true)
        }}>{open ? 'Opened' : 'Closed'} {Date.now()}</button>
      }
    `)
    writeFileSync(join(dir, 'sample.fixtures.tsx'), `export default [{
      name: 'Open', props: {}, now: 123, prepare: (container) => container.querySelector('button').click()
    }]`)
    const result = run([target], dir)
    expect(result.status, result.stderr).toBe(0)
    expect(output(name).dark).toContain('<button>Opened 123</button>')
  })

  it('passes a fixture Set and element through untouched', () => {
    const { dir, name, target } = temporaryComponent((name) => `
      export function ${name}({ ids, icon }) {
        return <p>{[...ids].join(',')}{icon}</p>
      }
    `)
    writeFileSync(join(dir, 'sample.fixtures.tsx'), `export default [
      { name: 'Kept', props: { ids: new Set(['a', 'b']), icon: <b>i</b> } }
    ]`)
    const result = run([target], dir)
    expect(result.status, result.stderr).toBe(0)
    expect(output(name).dark).toContain('<p>a,b<b>i</b></p>')
  })

  it('embeds all existing built styles without changing theme selectors', () => {
    const { dir, name, target } = temporaryComponent((name) => `export function ${name}() { return <span>Styled</span> }`)
    const assets = join(dir, 'out/renderer/assets')
    mkdirSync(assets, { recursive: true })
    writeFileSync(join(assets, 'index.css'), ':root { --background: black; } html.theme-light { --background: white; }')
    writeFileSync(join(assets, 'component.css'), '.sample { color: var(--foreground); }')
    writeFileSync(join(assets, 'ignored.js'), 'not a stylesheet')
    const result = run([target], dir)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('No built stylesheet')
    for (const page of Object.values(output(name))) {
      expect(page).toContain('html.theme-light { --background: white; }')
      expect(page).toContain('.sample { color: var(--foreground); }')
      expect(page).toContain(`<base href="file://${assets}/"/>`)
      expect(page).not.toContain('not a stylesheet')
    }
  })

  it('--fresh compiles the stylesheet from source in the built index sheet\'s place, keeping the other sheets', () => {
    const { dir, name, target } = temporaryComponent((name) => `export function ${name}() { return <span className="bg-primary">Fresh</span> }`)
    const assets = join(dir, 'out/renderer/assets')
    mkdirSync(assets, { recursive: true })
    writeFileSync(join(assets, 'index-abc123.css'), '.stale-build-marker { color: red; }')
    writeFileSync(join(assets, 'TerminalView-abc123.css'), '.kept-chunk-sheet { color: blue; }')
    const result = run([target, '--fresh'], dir)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('No built stylesheet')
    for (const page of Object.values(output(name))) {
      expect(page).not.toContain('.stale-build-marker')
      expect(page).toContain('.kept-chunk-sheet { color: blue; }')
      // The token layer and a utility the renderer uses, from index.css itself.
      expect(page).toContain('--dur-fast: 120ms')
      expect(page).toContain('.bg-primary')
      expect(page).toMatch(/url\("file:\/\/[^"]*src\/renderer\/src\/assets\/fonts\/JetBrainsMono-Regular\.ttf"\)/)
    }
  })

  it('draws an open popup in place under its fixture: a popover in the flow, a dialog fixed to a window box', () => {
    const { dir, name, target } = temporaryComponent((name) => `
      import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
      import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
      export function ${name}({ kind }: { kind: 'popover' | 'dialog' }) {
        return kind === 'popover'
          ? <Popover open><PopoverTrigger>Accounts</PopoverTrigger><PopoverContent>Two accounts</PopoverContent></Popover>
          : <Dialog open><DialogContent><DialogTitle>Rename the thread</DialogTitle></DialogContent></Dialog>
      }`)
    writeFileSync(join(dir, 'sample.fixtures.tsx'), `export default [
      { name: 'Popover', props: { kind: 'popover' } },
      { name: 'Dialog', props: { kind: 'dialog' } },
    ]`)
    const result = run([target], dir)
    expect(result.status, result.stderr).toBe(0)
    for (const page of Object.values(output(name))) {
      const [, popover, dialog] = page.split('class="preview-fixture"')
      expect(popover).toContain('Accounts')
      expect(popover).toMatch(/<div class="preview-portal">.*data-slot="popover-content".*Two accounts/s)
      // The positioner lies in the flow: no coordinates from a jsdom that measures nothing.
      expect(popover).not.toMatch(/data-side="[a-z]+"[^>]*style="/)
      expect(popover).not.toContain('Rename the thread')
      expect(dialog).toMatch(/<div class="preview-portal" data-preview-window="">.*role="dialog".*Rename the thread/s)
      expect(dialog).not.toContain('Two accounts')
    }
  })

  it('renders markdown: no worker to wait on', () => {
    const result = run(['src/renderer/src/surfaces/AgentMarkdown.tsx#AgentMarkdown'])
    expect(result.status, result.stderr).toBe(0)
    const html = output('AgentMarkdown')
    expect(html.dark).toContain('Why the build is slow</h1>')
    expect(html.light).toContain('The numbers</h3>')
  }, 60_000)

  it('names a default export after its module', () => {
    const { dir, name } = temporaryComponent(() => 'export default function Example() { return <span>Default export</span> }')
    writeFileSync(join(dir, `${name}.tsx`), readFileSync(join(dir, 'sample.tsx')))
    const result = run([`${name}.tsx#default`], dir)
    expect(result.status, result.stderr).toBe(0)
    for (const page of Object.values(output(name))) expect(page).toContain('<span>Default export</span>')
  })

  it('reports a missing export and malformed fixtures', () => {
    const { dir, target } = temporaryComponent((name) => `export function ${name}() { return <span>Example</span> }`)
    const missing = run(['sample.tsx#Missing'], dir)
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('No export "Missing" in sample.tsx')
    writeFileSync(join(dir, 'sample.fixtures.tsx'), 'export default [{ name: "Missing props" }]')
    const malformed = run([target], dir)
    expect(malformed.status).toBe(1)
    expect(malformed.stderr).toContain('must default-export [{ name, props }]')
  })

  it('writes under --out, leaving /tmp/ui-preview alone', () => {
    const { dir, name, target } = temporaryComponent((name) => `export function ${name}() { return <span>Elsewhere</span> }`)
    const out = join(dir, 'pages')
    const result = run([target, '--out', out], dir)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`${out}/${name}.html\n${out}/${name}.light.html\n`)
    expect(readFileSync(join(out, `${name}.light.html`), 'utf8')).toContain('<span>Elsewhere</span>')
    expect(existsSync(`/tmp/ui-preview/${name}.html`)).toBe(false)
  })

  it('keeps the virtual workspace rows visible in both shell fixtures', () => {
    const out = mkdtempSync('/tmp/ui-preview-shell-')
    dirs.push(out)
    const result = run(['src/renderer/src/chrome/ShellFrame.preview.tsx#ShellFrame', '--out', out])
    expect(result.status, result.stderr).toBe(0)
    for (const name of ['ShellFrame.html', 'ShellFrame.light.html']) {
      const html = readFileSync(join(out, name), 'utf8')
      expect(html.match(/>Notes cache</g)).toHaveLength(2)
      expect(html.match(/<div data-index="0" class="absolute /g)).toHaveLength(2)
    }
  })

  it('refuses --shot without a Chrome to shoot with', () => {
    const { dir, target } = temporaryComponent((name) => `export function ${name}() { return <span>Shot</span> }`)
    const result = spawnSync('bun', [script, target, '--shot', '--out', join(dir, 'pages')], {
      cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, TEMP_CODE_CHROME: join(dir, 'no-chrome') }
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--shot needs headless Chrome')
  })

  it('renders the fixtures that need CSS.escape, scrollIntoView and a worker import', () => {
    for (const [target, name] of [
      ['src/renderer/src/chrome/DockBar.tsx#DockBar', 'DockBar'],
      ['src/renderer/src/chrome/SurfaceTabs.tsx#SurfaceTabs', 'SurfaceTabs'],
      ['src/renderer/src/chrome/rail/DebugPanel.tsx#DebugView', 'DebugView'],
    ] as const) {
      const result = run([target])
      expect(result.status, `${name}: ${result.stderr}`).toBe(0)
      expect(output(name).dark).toContain('class="preview-fixture"')
    }
  }, 120_000)

  it.each([
    [[], 'Usage:'],
    [['sample.tsx'], 'Usage:'],
    [['sample.tsx#Example', '--width', '0'], '--width must be a positive integer'],
    [['sample.tsx#Example', '--shot-widths', '864,'], '--shot-widths must be comma-separated positive integers'],
    [['sample.tsx#Example', '--width', 'NaN'], '--width must be a positive integer'],
    [['sample.tsx#Example', '--props', '[]'], '--props must be a JSON object']
  ])('rejects invalid arguments %j', (args, message) => {
    const result = run(args as string[])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(message)
  })
})

describe('preview layouts', () => {
  it('selects fixtures per export and captures a dialog in the same window as its backdrop content', () => {
    const { dir, target, name } = temporaryComponent((name) => `
      import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
      export function ${name}({ title }: { title: string }) {
        return <div data-preview-stage style={{ height: 480 }}>
          <p>Home draft</p>
          <Dialog defaultOpen><DialogContent><DialogTitle>{title}</DialogTitle></DialogContent></Dialog>
        </div>
      }
    `)
    writeFileSync(join(dir, 'sample.fixtures.tsx'), `export const fixturesByExport = {
      ${name}: [{ name: 'First run', props: { title: 'Set up a computer' } }],
      Other: [{ name: 'Other', props: {} }]
    }`)
    const result = run([target], dir)
    expect(result.status, result.stderr).toBe(0)
    for (const page of Object.values(output(name))) {
      expect(page).toContain('First run</div>')
      expect(page).not.toContain('Other</div>')
      const html = new JSDOM(page.slice(page.indexOf('<body>')))
      try {
        const stage = html.window.document.querySelector('[data-preview-stage]')
        expect(stage?.querySelector('p')?.textContent).toBe('Home draft')
        expect(stage?.querySelector('[data-preview-window] [role="dialog"]')?.textContent).toContain('Set up a computer')
      } finally {
        html.window.close()
      }
    }
  })

  it('keeps a sheet’s edge and width in a preview window', () => {
    const { dir, target, name } = temporaryComponent((name) => `
      import { Sheet, SheetContent, SheetTitle } from '@renderer/components/ui/sheet'
      export function ${name}() {
        return <Sheet open><SheetContent width={672} side="right"><SheetTitle>Agent detail</SheetTitle></SheetContent></Sheet>
      }
    `)
    const result = run([target], dir)
    expect(result.status, result.stderr).toBe(0)
    const html = output(name).dark
    expect(html).toMatch(/<div class="preview-portal" data-preview-window="">.*data-slot="sheet-content".*data-side="right".*Agent detail/s)
    expect(html).toContain('width: 672px')
  })

  it('writes browser positioning only for a preview with measured details', () => {
    const { dir, target, name } = temporaryComponent((name) => `
      export function ${name}() {
        return <ul><li><svg className="task-mark" data-state="active" /></li><svg className="task-cursor" /></ul>
      }
    `)
    const result = run([target], dir)
    expect(result.status, result.stderr).toBe(0)
    const html = output(name).dark
    expect(html).toContain('<script>(function positionPreviewDetails')
    expect(html).toContain('.task-mark[data-state="active"]')
  })

  it('requires a positive integer for each requested screenshot width', () => {
    const result = run(['sample.tsx#Example', '--shot-widths', '864,0'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--shot-widths must be comma-separated positive integers')
  })
})

it('can hold the clock for a preview', () => {
  const { dir, target, name } = temporaryComponent((name) => `
    export const previewClock = 1700000000000
    export function ${name}() { return <span>{Date.now()}</span> }
  `)
  const result = run([target], dir)
  expect(result.status, result.stderr).toBe(0)
  expect(output(name).dark).toContain('<span>1700000000000</span>')
})

it('draws the real decoded-image and agent-detail bodies in static previews', () => {
  for (const [target, name, words] of [
    ['surfaces/MediaViewer.fixtures.tsx#MediaViewerPreview', 'MediaViewerPreview', ['320 × 200', 'Before', 'After']],
    ['surfaces/threads/fleet/AgentDetail.fixtures.tsx#AgentDetailPreview', 'AgentDetailPreview', ['The west trail needs a note', 'The box did not answer.', 'data-preview-window']],
    ['surfaces/threads/ActivitySection.tsx#ActivityRows', 'ActivityRows', ['All routes passed', 'Loading the output', "Couldn't read the output"]],
  ] as const) {
    const result = run(['src/renderer/src/' + target])
    expect(result.status, result.stderr).toBe(0)
    for (const word of words) expect(output(name).dark).toContain(word)
  }
}, 90_000)

it('uses browser row heights for the static transcript offsets', () => {
  const { dir, target, name } = temporaryComponent((name) => `
    export function ${name}() {
      return <div className="agent-transcript"><div data-column>
        <div data-row="first" style={{top: 16}}>The first row</div>
        <div data-row="second" style={{top: 40}}>The second row</div>
      </div></div>
    }
  `)
  const result = run([target], dir)
  expect(result.status, result.stderr).toBe(0)
  const page = output(name).dark
  const html = new JSDOM(page.slice(page.indexOf('<body>')), {
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLElement.prototype.getBoundingClientRect = function () {
        return new window.DOMRect(0, 0, 100, this.dataset.row === 'first' ? 60 : 20)
      }
    }
  })
  try {
    expect(html.window.document.querySelector<HTMLElement>('[data-row="second"]')?.style.top).toBe('76px')
    expect(html.window.document.querySelector<HTMLElement>('[data-column]')?.style.height).toBe('96px')
  } finally {
    html.window.close()
  }
})
