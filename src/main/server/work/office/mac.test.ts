import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ACCESS_PROMPT_SCRIPT, macCarrier, NEW_OUTLOOK, SCRIPTS, textAsHtml, waitingWords, type ScriptName, openFailure } from './mac'
import { OSA_TIMEOUT_MS, osaError, OsaTimeout, type Osa } from './osa'

/**
 * The Mac carrier on the box: each JXA script is run in a sandbox against a
 * stand-in for the objects JXA hands it (Excel's and Outlook's, by the names
 * their dictionaries give), and the carrier against a recorded osascript.
 * Neither proves a real Excel or Outlook answers so; docs/agents/work-office.md
 * "Not proven" lists the live test.
 */

/** A JXA property: called to read, assigned to write. */
function prop<T>(obj: Record<string, unknown>, name: string, value: T, writes: [string, unknown][]): void {
  let v = value
  Object.defineProperty(obj, name, { get: () => () => v, set: (x: T) => (writes.push([name, x]), (v = x)), enumerable: true })
}

function runScript(name: ScriptName, args: unknown, apps: Record<string, unknown>): unknown {
  const out = runInNewContext(`${SCRIPTS[name]}\nrun([${JSON.stringify(JSON.stringify(args))}])`, { Application: (n: string) => apps[n], JSON, Date, Math, String, Number, Error, ObjC: { import: () => {}, unwrap: (x: unknown) => x }, $: { NSFileManager: { defaultManager: { displayNameAtPath: () => 'Macintosh HD' } } } })
  return JSON.parse(String(out))
}

function excel(writes: [string, unknown][], cells: { value: unknown; formula2: unknown; numberFormat: unknown }) {
  const range: Record<string, unknown> = {}
  prop(range, 'value', cells.value, writes)
  prop(range, 'formula2', cells.formula2, writes)
  prop(range, 'numberFormat', cells.numberFormat, writes)
  const sheet = {
    name: () => 'Sheet1',
    usedRange: { rows: { length: 3 }, columns: { length: 2 }, firstRowIndex: () => 2, firstColumnIndex: () => 1, value: () => 1 },
    ranges: { byName: (a: string) => (writes.push(['range', a]), range) }
  }
  const worksheets = Object.assign(() => [sheet], { byName: () => sheet })
  const book = { fullName: () => '/tmp/Book.xlsx', name: () => 'Book.xlsx', worksheets }
  return { running: () => true, workbooks: () => [book] }
}

/**
 * A sheet as Excel's dictionary answers it: a range's \`value\` and \`formula2\` are a grid (one cell, a bare
 * value), its \`number format\` ONE value, the format when all its cells share it and "" when they differ.
 */
function excelSheet(cells: Record<string, { v: unknown; z: string }>, asked: string[]) {
  const pos = (a: string) => {
    const m = /^([A-Z]+)(\d+)$/.exec(a)!
    return [Number(m[2]), [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)] as const
  }
  const name = (r: number, c: number) => `${String.fromCharCode(64 + c)}${r}`
  const range = (addr: string) => {
    asked.push(addr)
    const [a, b = a] = addr.split(':')
    const [r1, c1] = pos(a)
    const [r2, c2] = pos(b)
    const at = (f: (x: { v: unknown; z: string }) => unknown) =>
      Array.from({ length: r2 - r1 + 1 }, (_, i) => Array.from({ length: c2 - c1 + 1 }, (_, j) => f(cells[name(r1 + i, c1 + j)] ?? { v: '', z: 'General' })))
    const one = r1 === r2 && c1 === c2
    const zs = at((x) => x.z).flat()
    return {
      value: () => (one ? at((x) => x.v)[0][0] : at((x) => x.v)),
      formula2: () => (one ? String(at((x) => x.v)[0][0]) : at((x) => String(x.v))),
      numberFormat: () => (zs.every((z) => z === zs[0]) ? zs[0] : '')
    }
  }
  const sheet = { name: () => 'Sheet1', ranges: { byName: range } }
  const book = { fullName: () => '/tmp/Book.xlsx', name: () => 'Book.xlsx', worksheets: Object.assign(() => [sheet], { byName: () => sheet }) }
  return { running: () => true, workbooks: () => [book] }
}

describe('number formats, as real Excel answers them', () => {
  it('spread one shared format over the block in a single read', () => {
    const asked: string[] = []
    const got = runScript('readRange', { book: 'Book.xlsx', sheet: 'Sheet1', address: 'A1:C4' }, { 'Microsoft Excel': excelSheet({ A1: { v: 1, z: 'General' } }, asked) }) as { formats: string[][]; values: unknown[][] }
    expect(got.formats).toEqual(Array.from({ length: 4 }, () => ['General', 'General', 'General']))
    expect(got.values).toHaveLength(4)
    expect(asked).toEqual(['A1:C4'])
  })

  it('read mixed formats by row, then by cell only in the row that differs', () => {
    const asked: string[] = []
    const cells = { B2: { v: 3, z: '0.00' }, C3: { v: 4, z: 'yyyy-mm-dd' }, A3: { v: 5, z: 'yyyy-mm-dd' }, B3: { v: 6, z: 'yyyy-mm-dd' } }
    const got = runScript('readRange', { book: 'Book.xlsx', sheet: 'Sheet1', address: 'A2:C3' }, { 'Microsoft Excel': excelSheet(cells, asked) }) as { formats: string[][] }
    expect(got.formats).toEqual([['General', '0.00', 'General'], ['yyyy-mm-dd', 'yyyy-mm-dd', 'yyyy-mm-dd']])
    expect(asked).toEqual(['A2:C3', 'A2:C2', 'A2', 'B2', 'C2', 'A3:C3'])
  })
})

describe('the Excel scripts', () => {
  it('list workbooks with each sheet used from A1 to its last cell', () => {
    expect(runScript('workbooks', {}, { 'Microsoft Excel': excel([], { value: 1, formula2: '', numberFormat: '' }) })).toEqual([
      { key: '/tmp/Book.xlsx', name: 'Book.xlsx', sheets: [{ name: 'Sheet1', rows: 4, columns: 2 }] }
    ])
  })

  it('read a block as rows, empty cells as null, dates as ISO, formulas only where there is one', () => {
    const when = new Date(Date.UTC(2026, 10, 19))
    const got = runScript('readRange', { book: '/tmp/Book.xlsx', sheet: 'Sheet1', address: 'A1:B2' }, {
      'Microsoft Excel': excel([], { value: [['a', ''], [when, 3]], formula2: [['a', ''], ['2026-11-19', '=B1+1']], numberFormat: [['General', 'General'], ['yyyy-mm-dd', '0']] })
    })
    expect(got).toEqual({ values: [['a', null], ['2026-11-19T00:00:00.000Z', 3]], formulas: [['', ''], ['', '=B1+1']], formats: [['General', 'General'], ['yyyy-mm-dd', '0']] })
  })

  it('read one cell, which JXA answers as a bare value, as a 1 by 1 block', () => {
    expect(runScript('readRange', { book: 'Book.xlsx', sheet: 'Sheet1', address: 'B2' }, { 'Microsoft Excel': excel([], { value: 7, formula2: '7', numberFormat: 'General' }) })).toEqual({
      values: [[7]],
      formulas: [['']],
      formats: [['General']]
    })
  })

  it('write a block in one assignment: values as they are, or every cell as formula text when one is a formula', () => {
    const w1: [string, unknown][] = []
    runScript('writeRange', { book: 'Book.xlsx', sheet: 'Sheet1', address: 'A1:B1', grid: [[1, null]], formulas: false }, { 'Microsoft Excel': excel(w1, { value: 0, formula2: '', numberFormat: '' }) })
    expect(w1).toEqual([['range', 'A1:B1'], ['value', [[1, '']]]])
    const w2: [string, unknown][] = []
    runScript('writeRange', { book: 'Book.xlsx', sheet: 'Sheet1', address: 'A1:B1', grid: [[1, '=A1*2']], formulas: true }, { 'Microsoft Excel': excel(w2, { value: 0, formula2: '', numberFormat: '' }) })
    expect(w2).toEqual([['range', 'A1:B1'], ['formula2', [['1', '=A1*2']]]])
    const w3: [string, unknown][] = []
    runScript('writeRange', { book: 'Book.xlsx', sheet: 'Sheet1', address: 'A1', grid: [['2026-11-19T00:00:00.000Z']], formulas: false }, { 'Microsoft Excel': excel(w3, { value: 0, formula2: '', numberFormat: '' }) })
    expect(w3[1][1]).toBeInstanceOf(Date)
  })

  it('answer an empty list, not a TypeError, when Excel is open with no workbook (JXA gives null)', () => {
    const xl = { running: () => true, workbooks: () => null }
    expect(runScript('workbooks', {}, { 'Microsoft Excel': xl })).toEqual([])
    expect(() => runScript('readRange', { book: 'B.xlsx', sheet: 'Sheet1', address: 'A1' }, { 'Microsoft Excel': xl })).toThrow('(-1728)')
  })

  it('refuse a workbook that is not open', () => {
    expect(() => runScript('readRange', { book: 'Other.xlsx', sheet: 'Sheet1', address: 'A1' }, { 'Microsoft Excel': excel([], { value: 1, formula2: '', numberFormat: '' }) })).toThrow('(-1728)')
  })
})

/**
 * Outlook's mail objects as JXA hands them: a recipient list is called to read and pushed to add. A reply comes back
 * addressed as Outlook addresses it, to the mail's Reply-To when it has one; `o.delete` takes a recipient off, unless
 * `sticky` (an Outlook that will not let one go), or throws a made message away.
 */
function outlook(log: string[], o: { replyTo?: string; sticky?: boolean } = {}) {
  type R = { emailAddress: () => { address: string } }
  const lists: R[][] = []
  const recipients = (kind: string, start: string[] = []) => {
    const list: R[] = start.map((x) => ({ emailAddress: () => ({ address: x }) }))
    lists.push(list)
    return Object.assign(() => list.slice(), {
      push: (r: { emailAddress: { address: string } }) => (log.push(`${kind} ${r.emailAddress.address}`), list.push({ emailAddress: () => r.emailAddress }))
    })
  }
  const message = (id: number, to: string[] = []) => {
    const m: Record<string, unknown> = { id: () => id, toRecipients: recipients('to', to), ccRecipients: recipients('cc'), bccRecipients: recipients('bcc') }
    let content = '<p>quoted</p>'
    Object.defineProperty(m, 'content', { get: () => () => content, set: (x: string) => (log.push(`content ${x}`), (content = x)) })
    return m
  }
  return {
    running: () => true,
    exchangeAccounts: () => [{ emailAddress: () => 'me@example.com' }],
    imapAccounts: () => [],
    popAccounts: () => [],
    messages: { byId: (id: number) => message(id) },
    outgoingMessages: { push: () => log.push('made') },
    OutgoingMessage: (p: { subject: string }) => (log.push(`new ${p.subject}`), message(7)),
    ToRecipient: (x: unknown) => x,
    CcRecipient: (x: unknown) => x,
    BccRecipient: (x: unknown) => x,
    replyTo: (_m: unknown, p: { openingWindow: boolean }) => (log.push(`reply window=${p.openingWindow}`), message(8, [o.replyTo ?? 'dana@example.com'])),
    forward: (_m: unknown, p: { to: string }) => (log.push(`forward to=${p.to}`), message(9, p.to.split(',').filter(Boolean))),
    delete: (x: R | Record<string, unknown>) => {
      for (const list of lists) {
        const at = list.indexOf(x as R)
        if (at >= 0) {
          if (o.sticky) return
          log.push(`off ${(x as R).emailAddress().address}`)
          return void list.splice(at, 1)
        }
      }
      log.push('THROWN AWAY')
    },
    send: () => log.push('SENT')
  }
}

describe('the Outlook mail script', () => {
  const m = { to: ['dana@example.com'], cc: [], bcc: [], subject: 'Plan', html: '<b>hi</b>' }
  it('leaves a draft and never sends it', () => {
    const log: string[] = []
    expect(runScript('mail', { m, send: false }, { 'Microsoft Outlook': outlook(log) })).toBe('7')
    expect(log).toEqual(['new Plan', 'made', 'to dana@example.com'])
  })
  it('sends only when told to, and a reply keeps Outlook\'s quote under the new text, with no window', () => {
    const log: string[] = []
    runScript('mail', { m: { ...m, replyTo: '42' }, send: true }, { 'Microsoft Outlook': outlook(log) })
    expect(log).toEqual(['reply window=false', 'content <b>hi</b><p>quoted</p>', 'off dana@example.com', 'to dana@example.com', 'SENT'])
  })

  describe('a reply or forward goes only to the recipients held (the hold review\'s 21.1)', () => {
    it("sends a reply to the held sender, never to the mail's Reply-To that Outlook addressed it to", () => {
      const log: string[] = []
      expect(runScript('mail', { m: { ...m, cc: ['lee@example.com'], replyTo: '42' }, send: true }, { 'Microsoft Outlook': outlook(log, { replyTo: 'b@elsewhere.com' }) })).toBe('8')
      expect(log).toEqual(['reply window=false', 'content <b>hi</b><p>quoted</p>', 'off b@elsewhere.com', 'to dana@example.com', 'cc lee@example.com', 'SENT'])
    })
    it('refuses, throwing the reply away unsent, when Outlook keeps a recipient it made', () => {
      const log: string[] = []
      expect(runScript('mail', { m: { ...m, replyTo: '42' }, send: true }, { 'Microsoft Outlook': outlook(log, { replyTo: 'b@elsewhere.com', sticky: true }) })).toEqual({
        refused: 'Outlook made this reply for To b@elsewhere.com, dana@example.com, not To dana@example.com as held, so nothing was sent.'
      })
      expect(log).not.toContain('SENT')
      expect(log.at(-1)).toBe('THROWN AWAY')
    })
    it('checks a forward too: its To, Cc and Bcc as held go, any other is refused', () => {
      const log: string[] = []
      runScript('mail', { m: { ...m, to: ['lee@example.com'], bcc: ['me@example.com'], forward: '42' }, send: true }, { 'Microsoft Outlook': outlook(log) })
      expect(log.at(-1)).toBe('SENT')
      // A forward Outlook addressed to someone more (as the stand-in does with a second address in its `to`) is not sent.
      const bad: string[] = []
      const apps = { 'Microsoft Outlook': { ...outlook(bad), forward: () => (bad.push('forward'), outlook(bad).replyTo({}, { openingWindow: false })) } }
      expect(runScript('mail', { m: { ...m, to: ['lee@example.com'], forward: '42' }, send: true }, apps)).toMatchObject({ refused: expect.stringContaining('Outlook made this forward for To dana@example.com') })
      expect(bad).not.toContain('SENT')
    })
    it("leaves a reply draft as Outlook addressed it: he sends a draft himself, from Outlook's own window", () => {
      const log: string[] = []
      expect(runScript('mail', { m: { ...m, to: [], replyTo: '42' }, send: false }, { 'Microsoft Outlook': outlook(log, { replyTo: 'b@elsewhere.com' }) })).toBe('8')
      expect(log).toEqual(['reply window=false', 'content <b>hi</b><p>quoted</p>'])
    })
    it('the carrier throws the refusal as refused, so the press fails with nothing sent', async () => {
      const osa: Osa = async () => JSON.stringify({ refused: 'Outlook made this reply for To b@elsewhere.com, not To dana@example.com as held, so nothing was sent.' })
      const c = macCarrier({ osa, installed: () => true })
      await expect(c.sendMail({ ...m, replyTo: '42' })).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('so nothing was sent') })
    })
  })
})

/** A JXA element collection: called, it answers the list; indexed and counted, one item at a time. */
function elements<T>(list: T[]): (() => T[]) & Record<number, T> {
  const f = (() => list) as (() => T[]) & Record<number, T>
  Object.defineProperty(f, 'length', { value: list.length })
  list.forEach((x, i) => (f[i] = x))
  return f
}

describe('Word edits', () => {
  it('insert at the end before the last paragraph mark, and at the start, through a range (Word has no insertAfter)', () => {
    const log: unknown[] = []
    const d: Record<string, unknown> = { fullName: () => '/tmp/a.docx', name: () => 'a.docx', trackRevisions: () => false, textObject: { endOfContent: () => 12 } }
    Object.defineProperty(d, 'trackRevisions', { get: () => () => false, set: (v: boolean) => log.push(['track', v]) })
    const range = (at: { start: number; end: number }) => ({ set content(t: string) { log.push(['put', at.start, at.end, t]) } })
    const w = { running: () => true, documents: elements([d]), createRange: (_d: unknown, at: { start: number; end: number }) => range(at) }
    expect(runScript('editDocument', { doc: '/tmp/a.docx', edit: { insert: ' end', at: 'end' }, tracked: true }, { 'Microsoft Word': w })).toBe(1)
    runScript('editDocument', { doc: 'a.docx', edit: { insert: 'start ', at: 'start' }, tracked: false }, { 'Microsoft Word': w })
    expect(log).toEqual([['track', true], ['put', 11, 11, ' end'], ['track', false], ['track', false], ['put', 0, 0, 'start '], ['track', false]])
  })

  /** Word's Find as its dictionary takes it: the stand-in replaces as Word would with every flag off and ^^ read as one ^. */
  const word = (text: string, o: { does?: (t: string) => string } = {}) => {
    let t = text
    const finds: Record<string, unknown>[] = []
    const cleared: unknown[] = []
    const findObject = {}
    const d: Record<string, unknown> = { fullName: () => '/tmp/a.docx', name: () => 'a.docx', textObject: { content: () => t, findObject } }
    Object.defineProperty(d, 'trackRevisions', { get: () => () => false, set: () => {} })
    const w = {
      running: () => true,
      documents: elements([d]),
      clearFormatting: (f: unknown) => void cleared.push(f),
      executeFind: (_f: unknown, opts: Record<string, unknown>) => {
        finds.push(opts)
        const un = (x: unknown) => String(x).split('^^').join('^')
        t = o.does ? o.does(t) : t.split(un(opts.findText)).join(un(opts.replaceWith))
        return true
      }
    }
    return { apps: { 'Microsoft Word': w }, finds, cleared, findObject, text: () => t }
  }

  it("find and replace set every one of his last Find's flags, take ^ as itself, and answer what Word did", () => {
    const wd = word('Q3 (draft) and Q3 (draft).')
    expect(runScript('editDocument', { doc: '/tmp/a.docx', edit: { find: 'Q3 (draft)', replace: 'Q3 ^c' }, tracked: false }, wd.apps)).toBe(2)
    expect(wd.finds).toEqual([{ findText: 'Q3 (draft)', replaceWith: 'Q3 ^^c', replace: 'replace all', matchCase: true, matchWholeWord: false, matchWildcards: false, matchSoundsLike: false, matchAllWordForms: false, findFormat: false, matchForward: true, wrapFind: 'find stop' }])
    expect(wd.cleared).toEqual([wd.findObject])
    expect(wd.text()).toBe('Q3 ^c and Q3 ^c.')
    const caret = word('a^b, a^b')
    runScript('editDocument', { doc: 'a.docx', edit: { find: 'a^b', replace: 'c' }, tracked: false }, caret.apps)
    expect(caret.finds[0]).toMatchObject({ findText: 'a^^b', replaceWith: 'c' })
    // Word changed one of the two: the press says so, never "changed" whatever Word did.
    const short = word('one, one', { does: (t) => t.replace('one', 'two') })
    expect(runScript('editDocument', { doc: 'a.docx', edit: { find: 'one', replace: 'two' }, tracked: false }, short.apps)).toBe(1)
    // When the new words hold the old, a different result cannot be counted: -1.
    const odd = word('ab ab', { does: (t) => t.replace('ab', 'abab') })
    expect(runScript('editDocument', { doc: 'a.docx', edit: { find: 'ab', replace: 'abc' }, tracked: false }, odd.apps)).toBe(-1)
  })
})

describe('PowerPoint decks', () => {
  /** A shape as PowerPoint answers it; `text: null` has no text frame, `broken` throws on its text (a placeholder that is gone). */
  const shape = (text: string | null, broken = false) => {
    const range: Record<string, unknown> = {}
    let t = text ?? ''
    Object.defineProperty(range, 'content', { get: () => () => (broken ? (() => { throw new Error('The object you are trying to access does not exist (-1728)') })() : t), set: (v: string) => (t = v) })
    return { hasTextFrame: () => text !== null, textFrame: { textRange: range }, read: () => t }
  }
  const deck = (slides: ReturnType<typeof shape>[][]) => ({ fullName: () => '/tmp/office-live/deck-test.pptx', name: () => 'deck-test.pptx', slides: elements(slides.map((sh) => ({ shapes: elements(sh) }))) })
  const ppt = (d: ReturnType<typeof deck>) => ({ 'Microsoft PowerPoint': { running: () => true, presentations: elements([d]) } })

  it('read every text box, shape by shape, passing over pictures and shapes that cannot be read', () => {
    const d = deck([[shape('Dummy deck'), shape('First body')], [shape(null), shape('Second', true), shape('Second body')], []])
    expect(runScript('readSlides', { pres: '/tmp/office-live/deck-test.pptx' }, ppt(d))).toEqual([
      { index: 1, texts: ['Dummy deck', 'First body'] },
      { index: 2, texts: ['Second body'] },
      { index: 3, texts: [] }
    ])
  })

  it("replace text in each box that holds it through PowerPoint's own replace, which keeps each run's formatting, and count the boxes", () => {
    const a = shape('Q1 plan, Q1 done')
    const b = shape('See Q1')
    const d = deck([[a, shape('none')], [b]])
    const asked: { after: number; findWhat: string; replaceWhat: string; matchCase: boolean; wholeWords: boolean }[] = []
    // A text range as PowerPoint's dictionary answers `replace`: the hit's range (offset from 1, its length), or nothing.
    const app = ppt(d)['Microsoft PowerPoint'] as Record<string, unknown>
    app.replace = (range: { content: () => string }, o: (typeof asked)[number]) => {
      asked.push(o)
      const s = range.content()
      const at = s.indexOf(o.findWhat, o.after)
      if (at < 0) return null
      const box = [a, b].find((x) => x.textFrame.textRange === range)!
      ;(box.textFrame.textRange as unknown as { content: string }).content = s.slice(0, at) + o.replaceWhat + s.slice(at + o.findWhat.length)
      return { offset: () => at + 1, length: () => o.replaceWhat.length }
    }
    expect(runScript('replaceSlideText', { pres: 'deck-test.pptx', find: 'Q1', replace: 'Q2' }, { 'Microsoft PowerPoint': app })).toBe(2)
    expect([a.read(), b.read()]).toEqual(['Q2 plan, Q2 done', 'See Q2'])
    // Each call past the words it put in; never the box's content set whole (that flattens its runs).
    expect(asked.map((o) => [o.after, o.matchCase, o.wholeWords])).toEqual([[0, true, false], [2, true, false], [11, true, false], [0, true, false], [6, true, false]])
  })
})

describe('the slideshow script', () => {
  it('runs the deck\'s own slideshow over every slide from the first, and brings PowerPoint forward', () => {
    const settings: Record<string, unknown> = {}
    const ran: unknown[] = []
    const d: Record<string, unknown> = { fullName: () => '/Users/owner/Talk.pptx', name: () => 'Talk.pptx', slides: { length: 12 }, slideShowSettings: settings, saved: () => true }
    let active = false
    const pp = { running: () => true, presentations: elements([d]), runSlideShow: (s: unknown) => void ran.push(s), activate: () => void (active = true) }
    expect(runScript('presentPowerPoint', { key: '/Users/owner/Talk.pptx' }, { 'Microsoft PowerPoint': pp })).toEqual({ slides: 12 })
    expect(settings).toEqual({ rangeType: 'slide show range show all', startingSlide: 1, endingSlide: 12 })
    expect(ran).toEqual([settings])
    expect(active).toBe(true)
    // the settings' writes mark the deck changed: a saved deck is marked saved again
    expect(d.saved).toBe(true)
  })

  it('leaves a deck with unsaved changes marked changed', () => {
    const d: Record<string, unknown> = { fullName: () => '/Users/owner/Talk.pptx', name: () => 'Talk.pptx', slides: { length: 3 }, slideShowSettings: {}, saved: () => false }
    const pp = { running: () => true, presentations: elements([d]), runSlideShow: () => undefined, activate: () => undefined }
    runScript('presentPowerPoint', { key: '/Users/owner/Talk.pptx' }, { 'Microsoft PowerPoint': pp })
    expect(typeof d.saved).toBe('function')
  })

  it('says so when the deck never opened', () => {
    const pp = { running: () => true, presentations: elements([]), runSlideShow: () => undefined }
    expect(() => runScript('presentPowerPoint', { key: '/Users/owner/Talk.pptx' }, { 'Microsoft PowerPoint': pp })).toThrow('Nothing open named /Users/owner/Talk.pptx. (-1728)')
  })
})

describe("Word's HFS names", () => {
  const doc = (full: string) => ({ fullName: () => full, name: () => full.split(/[:/]/).pop(), textObject: { content: () => 'One\rTwo' } })
  const word = (...docs: ReturnType<typeof doc>[]) => ({ 'Microsoft Word': { running: () => true, documents: elements(docs) } })

  it('become POSIX keys: the startup disk at the root, another disk under /Volumes', () => {
    expect(runScript('documents', {}, word(doc('Macintosh HD:private:tmp:office-live:doc-test.docx'), doc('Backup:Notes:a/b.docx'), doc('/Users/o/c.docx')))).toEqual([
      { key: '/private/tmp/office-live/doc-test.docx', name: 'doc-test.docx' },
      { key: '/Volumes/Backup/Notes/a:b.docx', name: 'b.docx' },
      { key: '/Users/o/c.docx', name: 'c.docx' }
    ])
  })

  it('are found by the POSIX key, by /tmp for /private/tmp, and by name', () => {
    const apps = word(doc('Macintosh HD:private:tmp:office-live:doc-test.docx'))
    for (const key of ['/private/tmp/office-live/doc-test.docx', '/tmp/office-live/doc-test.docx', 'doc-test.docx']) expect(runScript('readDocument', { doc: key }, apps)).toEqual(['One', 'Two'])
    expect(() => runScript('readDocument', { doc: '/tmp/other.docx' }, apps)).toThrow('(-1728)')
  })
})

describe('empty collections', () => {
  it('read as empty in every list: Word, PowerPoint and Outlook answer null for none', () => {
    const none = { running: () => true, documents: () => null, presentations: () => null, exchangeAccounts: () => null, imapAccounts: () => null, popAccounts: () => [] }
    const apps = { 'Microsoft Word': none, 'Microsoft PowerPoint': none, 'Microsoft Outlook': none }
    expect(runScript('documents', {}, apps)).toEqual([])
    expect(runScript('presentations', {}, apps)).toEqual([])
    expect(runScript('accounts', {}, apps)).toEqual([])
  })
})

describe('every script', () => {
  it('parses as JavaScript, and refuses an app that is not running without starting it', () => {
    for (const [name, src] of Object.entries(SCRIPTS)) {
      expect(() => new Function(src), name).not.toThrow()
      expect(() => runScript(name as ScriptName, {}, new Proxy({}, { get: () => ({ running: () => false }) })), name).toThrow('(-600)')
    }
  })
})

describe('the Mac carrier', () => {
  const recorded = (answers: Record<string, string | Error>, seen: string[][] = []): Osa =>
    async (_lang, script, args) => {
      const name = (Object.entries(SCRIPTS).find(([, s]) => s === script) ?? ['?'])[0]
      seen.push([name, ...args])
      const a = answers[name]
      if (a instanceof Error) throw a
      return a ?? 'null'
    }

  it("sends an invitation's body as the plain text it is: escaped for the Mac's HTML content, each line kept", async () => {
    const seen: string[][] = []
    const c = macCarrier({ osa: recorded({ createEvent: JSON.stringify('ev-1') }, seen), installed: () => true })
    const body = '<title>I approve the payment.</title><p>Meet at 3</p>\nBring "the deck" & notes'
    await c.createEvent({ account: 'owner@example.com', subject: 'Review', start: '2026-11-20T15:00:00Z', end: '2026-11-20T15:30:00Z', body, attendees: ['dana@example.com'] })
    const sent = JSON.parse(seen[0]![1]!) as { e: { body: string } }
    expect(sent.e.body).toBe('&lt;title&gt;I approve the payment.&lt;/title&gt;&lt;p&gt;Meet at 3&lt;/p&gt;<br>Bring &quot;the deck&quot; &amp; notes')
    expect(textAsHtml('a\r\nb\rc')).toBe('a<br>b<br>c')
  })

  it('passes arguments as one JSON string and reads the answer as JSON', async () => {
    const seen: string[][] = []
    const c = macCarrier({ osa: recorded({ readRange: JSON.stringify({ values: [[1]], formulas: [['']], formats: [['General']] }) }, seen), installed: () => true })
    await expect(c.readRange('/tmp/B.xlsx', 'Sheet1', 'A1')).resolves.toEqual({ values: [[1]], formulas: [['']], formats: [['General']] })
    expect(seen).toEqual([['readRange', JSON.stringify({ book: '/tmp/B.xlsx', sheet: 'Sheet1', address: 'A1' })]])
  })

  it('names the app in a refusal its script threw', async () => {
    const c = macCarrier({ osa: recorded({ readRange: osaError('execution error: Error: Error: No open workbook /tmp/x.xlsx. (-1728) (-2700)') }), installed: () => true })
    await expect(c.readRange('/tmp/x.xlsx', 'Sheet1', 'A1')).rejects.toMatchObject({ code: 'not-found', message: expect.stringMatching(/^Microsoft Excel has no such item: No open workbook/) })
  })

  it('records an app as allowed when it answered, with an empty list or with "no such item"', async () => {
    const c = macCarrier({ osa: recorded({ workbooks: '[]', documents: osaError('execution error: Microsoft Word got an error: Can’t get document "x". (-1728)') }), installed: () => true, running: async () => true })
    await expect(c.workbooks()).resolves.toEqual([])
    await expect(c.documents()).rejects.toMatchObject({ code: 'not-found' })
    const seen = await c.apps()
    expect(seen.find((a) => a.app === 'excel')?.allowed).toBe('yes')
    expect(seen.find((a) => a.app === 'word')?.allowed).toBe('yes')
  })

  it('says in words when macOS refuses, and remembers it for the status', async () => {
    const c = macCarrier({ osa: recorded({ workbooks: osaError('execution error: Not authorized to send Apple events to Microsoft Excel. (-1743)') }), installed: () => true, running: async () => true })
    await expect(c.workbooks()).rejects.toMatchObject({ code: 'not-allowed', message: expect.stringContaining('Automation') })
    expect((await c.apps()).find((a) => a.app === 'excel')).toEqual({ app: 'excel', installed: true, running: true, allowed: 'no' })
  })

  it('refuses an app that is not installed without running osascript, and opens a file with the switch', async () => {
    const seen: string[][] = []
    const opened: string[][] = []
    const c = macCarrier({ osa: recorded({}, seen), installed: (app) => app === 'excel', open: async (a) => void opened.push(a) })
    await expect(c.readDocument('/tmp/a.docx')).rejects.toMatchObject({ code: 'not-installed' })
    await c.open('excel', { kind: 'path', path: '/tmp/B.xlsx' })
    await c.open('excel', { kind: 'url', url: 'https://contoso.sharepoint.com/B.xlsx' })
    expect(seen).toEqual([])
    expect(opened).toEqual([['-a', 'Microsoft Excel', '/tmp/B.xlsx'], ['ms-excel:ofe|u|https://contoso.sharepoint.com/B.xlsx']])
  })

  it('says a file that is not there plainly, and any other failure of open in its own words', () => {
    // what /usr/bin/open said for a missing deck on his Mac (the live proof, 2026-11-23)
    const gone = openFailure('Command failed: /usr/bin/open -a Microsoft PowerPoint /Users/owner/No such deck.pptx\nThe file /Users/owner/No such deck.pptx does not exist.\n')
    expect([gone.message, gone.code]).toEqual(['There is no such file on this Mac.', 'not-found'])
    const other = openFailure('Command failed: /usr/bin/open -a Microsoft PowerPoint /x\nLSOpenURLsWithRole() failed with error -10810.\n')
    expect(other.code).toBe('failed')
    expect(other.message).toBe('The file did not open: Command failed: /usr/bin/open -a Microsoft PowerPoint /x\nLSOpenURLsWithRole() failed with error -10810.')
  })

  it("presents a deck: PowerPoint opens it with the switch's own open, then runs its slideshow by script", async () => {
    const seen: string[][] = []
    const opened: string[][] = []
    const c = macCarrier({ osa: recorded({ presentPowerPoint: JSON.stringify({ slides: 12 }) }, seen), installed: (app) => app === 'powerpoint', open: async (a) => void opened.push(a) })
    await c.present!({ kind: 'path', path: '/Users/owner/Talk.pptx' })
    expect(opened).toEqual([['-a', 'Microsoft PowerPoint', '/Users/owner/Talk.pptx']])
    expect(seen).toEqual([['presentPowerPoint', JSON.stringify({ key: '/Users/owner/Talk.pptx' })]])
    const none = macCarrier({ osa: recorded({}, seen), installed: () => false, open: async (a) => void opened.push(a) })
    await expect(none.present!({ kind: 'path', path: '/Users/owner/Talk.pptx' })).rejects.toMatchObject({ code: 'not-installed' })
  })

  it('says New Outlook cannot carry mail, from its own setting, without running a script', async () => {
    const seen: string[][] = []
    expect(await macCarrier({ osa: recorded({}, seen), installed: () => true, newOutlook: async () => true }).outlookProblem!()).toBe(NEW_OUTLOOK)
    expect(await macCarrier({ osa: recorded({}, seen), installed: () => true, newOutlook: async () => false }).outlookProblem!()).toBeNull()
    expect(await macCarrier({ osa: recorded({}, seen), installed: () => false, newOutlook: async () => true }).outlookProblem!()).toBeNull()
    expect(seen).toEqual([])
  })

  it('maps osascript errors', () => {
    expect(osaError('Microsoft Outlook got an error: Application isn’t running. (-600)').code).toBe('not-running')
    expect(osaError('execution error: Microsoft Excel got an error: Not authorized. (-1744)').code).toBe('needs-consent')
    expect(osaError('execution error: Can’t get worksheet "X". (-1728)').code).toBe('not-found')
  })

  it('takes the code a script threw, not the -2700 JXA wraps it in (as stderr reads live)', () => {
    const notOpen = osaError('execution error: Error: Error: Microsoft Word is not open. (-600) (-2700)')
    expect(notOpen).toMatchObject({ code: 'not-running', message: 'Microsoft Word is not open.' })
    const none = osaError('execution error: Error: Error: No open workbook /tmp/x.xlsx. (-1728) (-2700)')
    expect(none.code).toBe('not-found')
    expect(none.message).toContain('No open workbook /tmp/x.xlsx. (-1728)')
    expect(osaError('execution error: Error: TypeError: null is not an object (-2700)')).toMatchObject({ code: 'failed', message: expect.stringContaining('TypeError: null is not an object') })
  })
})

describe("the system's prompt for OneDrive's files", () => {
  const SENTENCE = '"Microsoft Excel.app" wants to access files managed by "OneDrive - purdue.edu".'
  const FILE = '/Users/him/Library/CloudStorage/OneDrive-purdue.edu/Budget.xlsx'
  /** An osascript whose app scripts never answer while the prompt is up, and whose detector prints the sentence. */
  const mac = (state: { up: boolean }, opened: string[][] = []) =>
    macCarrier({
      osa: async (lang, script) => {
        if (lang === 'AppleScript' && script === ACCESS_PROMPT_SCRIPT) return state.up ? SENTENCE : ''
        if (state.up) throw new OsaTimeout()
        return '[]'
      },
      installed: () => true,
      running: async () => true,
      open: async (args) => void opened.push(args),
      sleep: async () => {}
    })

  it('stays under the link between hosts, so a call from the box hears this Mac say why', () => {
    expect(OSA_TIMEOUT_MS).toBeLessThan(120_000)
    expect(ACCESS_PROMPT_SCRIPT).toMatch(/^[\x00-\x7f]*$/)
  })

  it('says the app waits on him, not a bare timeout, when a call gets no answer while the prompt is up', async () => {
    const state = { up: true }
    const c = mac(state)
    await expect(c.workbooks()).rejects.toMatchObject({ code: 'needs-consent', message: waitingWords('excel') })
    expect((await c.apps()).find((a) => a.app === 'excel')!.waiting).toBe(waitingWords('excel'))
    // he pressed Allow: the next look forgets it, and a call answers
    state.up = false
    expect((await c.apps()).find((a) => a.app === 'excel')!.waiting).toBeUndefined()
    await expect(c.workbooks()).resolves.toEqual([])
  })

  it('says so at the open itself for a file OneDrive manages, and not for any other file', async () => {
    const opened: string[][] = []
    const c = mac({ up: true }, opened)
    await expect(c.open('excel', { kind: 'path', path: FILE })).rejects.toMatchObject({ code: 'needs-consent' })
    expect(opened).toEqual([['-a', 'Microsoft Excel', FILE]])
    await expect(mac({ up: false }).open('excel', { kind: 'path', path: FILE })).resolves.toBeUndefined()
    await expect(mac({ up: true }).open('excel', { kind: 'path', path: '/Users/him/Documents/b.xlsx' })).resolves.toBeUndefined()
  })

  it('with no prompt up, an app that does not answer is said to have a dialog open', async () => {
    const c = macCarrier({ osa: async (lang) => (lang === 'AppleScript' ? '' : Promise.reject(new OsaTimeout())), installed: () => true, running: async () => true })
    await expect(c.documents()).rejects.toMatchObject({ code: 'busy', message: expect.stringMatching(/Microsoft Word did not answer within 100 s: a dialog may be open/) })
  })
})
