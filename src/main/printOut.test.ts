import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_VIEWER, PRINT_KEEP, PRINT_MAX_BYTES, XDG_SETTLE_MS, answerPrint, printDir, printName, printPdf, sweepPrints, xdgOpen } from './printOut'

/** Print… hands the previewed PDF to the system's own viewer (docs/agents/work-editors.md "Print"). */
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'tc-print-'))
  dirs.push(d)
  return d
}
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : [])

describe('Print…', () => {
  it('writes the previewed bytes to a file of its own under the temp folder and opens it in the system viewer', async () => {
    const t = temp()
    const opened: string[] = []
    const answer = await printPdf({ temp: t, open: async (path) => (opened.push(path), '') }, 'Run of show', PDF)
    expect(answer).toEqual({ ok: true, via: 'viewer' })
    expect(opened).toHaveLength(1)
    expect(opened[0]!.startsWith(printDir(t))).toBe(true)
    expect(opened[0]!.endsWith('/Run of show.pdf')).toBe(true)
    // The same bytes he previewed, readable by him alone.
    expect(new Uint8Array(readFileSync(opened[0]!))).toEqual(PDF)
    expect(statSync(opened[0]!).mode & 0o777).toBe(0o600)
    // A second print of the same name is another file: the viewer may still hold the first.
    await printPdf({ temp: t, open: async (path) => (opened.push(path), '') }, 'Run of show', PDF)
    expect(opened[1]).not.toBe(opened[0])
    expect(existsSync(opened[0]!)).toBe(true)
  })

  it('names the file by the document, with nothing a path, a device or a file list could make of it', () => {
    expect(printName('Run of show')).toBe('Run of show.pdf')
    expect(printName('Plan.pdf')).toBe('Plan.pdf')
    expect(printName('../../etc/passwd')).toBe('__.._etc_passwd.pdf')
    expect(printName('a/b\\c:d*e?"f<g>h|i')).toBe('a_b_c_d_e__f_g_h_i.pdf')
    expect(printName('   ')).toBe('Document.pdf')
    expect(printName(42)).toBe('Document.pdf')
    // A device's name on Windows is never the file's, with or without the ending.
    for (const device of ['CON', 'nul', 'Aux.pdf', 'COM1', 'lpt9.PDF']) expect(printName(device)).toBe('Document.pdf')
    // Marks that turn text round are gone: the name ends in the .pdf it reads as.
    expect(printName('\u202efdp.exe')).toBe('fdp.exe.pdf')
    expect(printName('ends in dots... ')).toBe('ends in dots.pdf')
    // Short enough for any file system, counted in bytes and never cut through a character.
    expect(Buffer.byteLength(printName('x'.repeat(400)))).toBeLessThanOrEqual(204)
    const cjk = printName('計画書'.repeat(40))
    expect(Buffer.byteLength(cjk)).toBeLessThanOrEqual(204)
    expect(cjk).toMatch(/^(計画書)+計?画?\.pdf$/)
    expect(cjk).not.toContain('\ufffd')
  })

  it('writes a long name in another script whole, and says so plainly when a file cannot be written', async () => {
    const t = temp()
    const opened: string[] = []
    expect(await printPdf({ temp: t, open: async (path) => (opened.push(path), '') }, '計画書'.repeat(40), PDF)).toEqual({ ok: true, via: 'viewer' })
    expect(existsSync(opened[0]!)).toBe(true)
    // The copies' folder cannot be written: one plain line, and nothing left behind.
    const shut = temp()
    mkdirSync(printDir(shut))
    chmodSync(printDir(shut), 0o500)
    try {
      if (process.getuid?.() !== 0) expect(await printPdf({ temp: shut, open: async () => '' }, 'x', PDF)).toEqual({ ok: false, error: 'The file could not be written' })
    } finally {
      chmodSync(printDir(shut), 0o700)
    }
    expect(walk(printDir(shut))).toEqual([])
  })

  it('answers only a window\'s own page, never a frame inside it', async () => {
    const t = temp()
    const deps = { temp: t, open: async (): Promise<string> => '' }
    const main = {}
    expect(await answerPrint(deps, { sender: { mainFrame: main }, senderFrame: {} }, 'x', PDF)).toEqual({ ok: false, error: 'Only the window itself can print' })
    expect(await answerPrint(deps, { sender: { mainFrame: main }, senderFrame: null }, 'x', PDF)).toEqual({ ok: false, error: 'Only the window itself can print' })
    expect(walk(printDir(t))).toEqual([])
    expect(await answerPrint(deps, { sender: { mainFrame: main }, senderFrame: main }, 'x', PDF)).toEqual({ ok: true, via: 'viewer' })
  })

  it('refuses what is not a PDF, nothing at all, and a file past its size, and writes none of them', async () => {
    const t = temp()
    const open = async (): Promise<string> => ''
    expect(await printPdf({ temp: t, open }, 'x', new TextEncoder().encode('<html>'))).toEqual({ ok: false, error: 'Only a PDF can be printed' })
    expect(await printPdf({ temp: t, open }, 'x', new Uint8Array())).toEqual({ ok: false, error: 'There is nothing to print' })
    expect(await printPdf({ temp: t, open }, 'x', 'not bytes')).toEqual({ ok: false, error: 'There is nothing to print' })
    const big = { byteLength: PRINT_MAX_BYTES + 1 } as unknown as Uint8Array
    Object.setPrototypeOf(big, Uint8Array.prototype)
    expect(await printPdf({ temp: t, open }, 'x', big)).toEqual({ ok: false, error: 'That file is too large to print from here' })
    expect(walk(printDir(t))).toEqual([])
  })

  it('says why when the system could not open it, and leaves no copy behind', async () => {
    const t = temp()
    expect(await printPdf({ temp: t, open: async () => 'No application knows how to open this file' }, 'x', PDF)).toEqual({ ok: false, error: 'No application knows how to open this file' })
    expect(await printPdf({ temp: t, open: () => Promise.reject(new Error('the viewer crashed')) }, 'x', PDF)).toEqual({ ok: false, error: 'the viewer crashed' })
    expect(walk(printDir(t))).toEqual([])
  })

  it('on Linux hears xdg-open for a moment: a failed exit or no xdg-open says why; a good exit, or one still running, is the viewer holding the file', async () => {
    vi.useFakeTimers()
    try {
      const runs: Array<{ args: unknown[]; child: EventEmitter & { unref(): void } }> = []
      const spawn = ((...args: unknown[]) => {
        const child = Object.assign(new EventEmitter(), { unref: () => {} })
        runs.push({ args, child })
        return child
      }) as unknown as Parameters<typeof xdgOpen>[1]
      const at = (p: Promise<string>, act: () => void): Promise<string> => (act(), p)
      expect(await at(xdgOpen('/t/Run.pdf', spawn), () => runs.at(-1)!.child.emit('exit', 0))).toBe('')
      expect(runs[0]!.args).toEqual(['xdg-open', ['/t/Run.pdf'], { detached: true, stdio: 'ignore' }])
      expect(await at(xdgOpen('/t/Run.pdf', spawn), () => runs.at(-1)!.child.emit('exit', 3))).toBe(NO_VIEWER)
      expect(await at(xdgOpen('/t/Run.pdf', spawn), () => runs.at(-1)!.child.emit('error', new Error('spawn xdg-open ENOENT')))).toBe(NO_VIEWER)
      // Its generic mode waits for the viewer to close: the answer does not.
      const waiting = xdgOpen('/t/Run.pdf', spawn)
      await vi.advanceTimersByTimeAsync(XDG_SETTLE_MS)
      expect(await waiting).toBe('')
      // Through Print…, an xdg-open that never exits still answers.
      const t = temp()
      const printed = printPdf({ temp: t, open: (path) => xdgOpen(path, spawn) }, 'Run of show', PDF)
      await vi.advanceTimersByTimeAsync(XDG_SETTLE_MS)
      expect(await printed).toEqual({ ok: true, via: 'viewer' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sweeps copies handed over more than a day ago, at each print, and keeps the fresh ones', async () => {
    const t = temp()
    const now = Date.now()
    const made = (name: string, at: number): string => {
      const dir = join(printDir(t), name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'Plan.pdf'), PDF)
      utimesSync(dir, at / 1000, at / 1000)
      return dir
    }
    const old = made('old', now - 25 * 60 * 60_000)
    const fresh = made('fresh', now - 60_000)
    sweepPrints(t, now)
    expect([existsSync(old), existsSync(fresh)]).toEqual([false, true])
    const older = made('older', now - 3 * 24 * 60 * 60_000)
    await printPdf({ temp: t, open: async () => '', now: () => now }, 'x', PDF)
    expect(existsSync(older)).toBe(false)
    // A temp folder with nothing of ours in it is left alone.
    expect(() => sweepPrints(join(t, 'nowhere'))).not.toThrow()
  })

  it('keeps only the newest copies, and never throws or follows a link where its folder should be', async () => {
    const t = temp()
    const now = Date.now()
    for (let i = 0; i < PRINT_KEEP + 3; i++) {
      const dir = join(printDir(t), `copy-${String(i).padStart(2, '0')}`)
      mkdirSync(dir, { recursive: true })
      utimesSync(dir, (now - i * 60_000) / 1000, (now - i * 60_000) / 1000)
    }
    sweepPrints(t, now)
    const left = readdirSync(printDir(t)).sort()
    expect(left).toHaveLength(PRINT_KEEP)
    expect(left[0]).toBe('copy-00')
    expect(left).not.toContain(`copy-${PRINT_KEEP + 2}`)

    // A link planted where the folder should be: nothing behind it is touched, and nothing is written through it.
    const planted = temp()
    const victim = join(temp(), 'his files')
    mkdirSync(join(victim, 'Old project'), { recursive: true })
    utimesSync(join(victim, 'Old project'), (now - 3 * 24 * 60 * 60_000) / 1000, (now - 3 * 24 * 60 * 60_000) / 1000)
    symlinkSync(victim, printDir(planted))
    sweepPrints(planted, now)
    expect(existsSync(join(victim, 'Old project'))).toBe(true)
    expect(await printPdf({ temp: planted, open: async () => '' }, 'x', PDF)).toEqual({ ok: false, error: 'The file could not be written' })
    expect(readdirSync(victim)).toEqual(['Old project'])

    // A plain file in its place, or a folder that cannot be read: no throw, so the handler is always there.
    const filed = temp()
    writeFileSync(printDir(filed), 'not a folder')
    expect(() => sweepPrints(filed, now)).not.toThrow()
    const locked = temp()
    mkdirSync(printDir(locked))
    chmodSync(printDir(locked), 0o000)
    try {
      expect(() => sweepPrints(locked, now)).not.toThrow()
    } finally {
      chmodSync(printDir(locked), 0o700)
    }
  })
})
