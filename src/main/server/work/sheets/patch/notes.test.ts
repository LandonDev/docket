import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { expect, test } from 'vitest'
import { NotesRefused, patchNotes, readNotes, type NotesEdit } from './notes'
import { patchText, readText as readRich } from './text'
import { readText, readZip, writeZip, type Entry, type Zip } from './zip'

const COMMENTS = 'xl/comments1.xml'
const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, '../harness/corpus', name)))
const corpus = fixture('threaded_comments.xlsx')
const xml = (bytes: Uint8Array, part = COMMENTS) => readText(readZip(bytes), part)
const enc = new TextEncoder()
const withComments = (text: string, from = corpus) =>
  writeZip(readZip(from), new Map([[COMMENTS, enc.encode(text)]]), new Set(), new Map())
type CellNote = [row: number, column: number, text: string]
const edit = (notes: CellNote[], sheet = 'Review'): NotesEdit => ({
  kind: 'notes',
  sheet,
  notes: notes.map(([row, column, text]) => ({ row, column, text }))
})
const comment = (bytes: Uint8Array, ref: string) =>
  new RegExp(`<(?:\\w+:)?comment ref="${ref}".*?</(?:\\w+:)?comment>`, 's').exec(xml(bytes))![0]

// The note at A9 as Excel writes one: the author's name in bold, then the words on the next line.
const BOLD =
  '<r><rPr><b/><sz val="9"/><color indexed="81"/><rFont val="Tahoma"/><family val="2"/></rPr><t>Lab:</t></r>'
const PLAIN = '<rPr><sz val="9"/><color indexed="81"/><rFont val="Tahoma"/><family val="2"/></rPr>'
const OLD = /<comment ref="A9" authorId="2"><text>.*?<\/text><\/comment>/s
const noteAs = (inside: string) =>
  withComments(
    xml(corpus).replace(
      OLD,
      `<comment ref="A9" authorId="2" shapeId="0"><text>${inside}</text></comment>`
    )
  )
const excel = noteAs(`${BOLD}<r>${PLAIN}<t xml:space="preserve">\nCheck the Q3 total</t></r>`)

function localRecord(z: Zip, entry: Entry): Buffer {
  const view = new DataView(z.buf.buffer, z.buf.byteOffset, z.buf.byteLength)
  const at = entry.localOffset
  let end = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true) + entry.compSize
  if (entry.flags & 8) end += view.getUint32(end, true) === 0x08074b50 ? 16 : 12
  return Buffer.from(z.buf.subarray(at, end))
}

/** Runs the patch and holds it to its report: the comments part changed or nothing did, every other entry kept its bytes. */
function checked(
  input: Uint8Array,
  edits: NotesEdit[],
  changed: string[] = [],
  proof?: { name: string; holds: string; excel: string }
) {
  const { bytes, report } = patchNotes(input, edits)
  expect(report).toEqual({ partsChanged: changed, partsAdded: [], partsRemoved: [] })
  const before = readZip(input)
  const after = readZip(bytes)
  expect([...after.byName.keys()]).toEqual([...before.byName.keys()])
  for (const entry of before.entries)
    expect(
      localRecord(before, entry).equals(localRecord(after, after.byName.get(entry.name)!)),
      entry.name
    ).toBe(!changed.includes(entry.name))
  if (!changed.length) expect(bytes).toBe(input)
  for (const part of changed) {
    const errors: string[] = []
    new DOMParser({ onError: (_level, message) => errors.push(message) }).parseFromString(
      xml(bytes, part),
      'application/xml'
    )
    expect(errors, part).toEqual([])
    // Every comment the edit did not name is as it was, byte for byte.
    const named = new Set(
      edits.flatMap((e) =>
        e.notes.map((note) => `${String.fromCharCode(65 + note.column)}${note.row + 1}`)
      )
    )
    for (const [old, ref] of xml(input, part).matchAll(/<comment ref="(\w+)".*?<\/comment>/gs))
      if (!named.has(ref)) expect(xml(bytes, part)).toContain(old)
    expect(xml(bytes, part).split('<commentList>')[0]).toBe(
      xml(input, part).split('<commentList>')[0]
    )
  }
  if (proof && process.env.TEXT_PROOF_DIR) {
    mkdirSync(process.env.TEXT_PROOF_DIR, { recursive: true })
    writeFileSync(join(process.env.TEXT_PROOF_DIR, proof.name + '.xlsx'), bytes)
    writeFileSync(
      join(process.env.TEXT_PROOF_DIR, proof.name + '.json'),
      JSON.stringify({ ...proof, kind: 'notes', edits, report, notes: readNotes(bytes) }, null, 2) +
        '\n'
    )
  }
  return bytes
}

test('reads the notes with their authors and leaves out the notes that stand in for threads', () => {
  expect(readNotes(corpus)).toEqual([
    {
      sheet: 'Review',
      row: 8,
      column: 0,
      author: 'Lab',
      text: 'An ordinary note next to the threads'
    }
  ])
  expect(readNotes(corpus, 'Review')).toHaveLength(1)
  expect(() => readNotes(corpus, 'Nowhere')).toThrow(NotesRefused)
  // The author's own line is not part of the text.
  expect(readNotes(excel)).toEqual([
    { sheet: 'Review', row: 8, column: 0, author: 'Lab', text: 'Check the Q3 total' }
  ])
  expect(readNotes(fixture('patch/base.xlsx'))).toEqual([])
})

test('replaces a note’s words in its own font and touches nothing else', () => {
  const bytes = checked(
    corpus,
    [edit([[8, 0, 'Checked on Monday.\nAll three agree.']])],
    [COMMENTS],
    {
      name: 'note-among-threads',
      holds: 'Review!A9’s note has new words on two lines; B2 and C5 keep their threads.',
      excel:
        'The note at A9 reads "Checked on Monday." and, on a second line, "All three agree." in the note’s small Tahoma. B2 and C5 still show their threaded comments with their replies.'
    }
  )
  expect(comment(bytes, 'A9')).toBe(
    '<comment ref="A9" authorId="2"><text><r><rPr><sz val="8"/><color indexed="81"/><rFont val="Tahoma"/><family val="2"/></rPr><t xml:space="preserve">Checked on Monday.\nAll three agree.</t></r></text></comment>'
  )
  expect(readNotes(bytes)[0].text).toBe('Checked on Monday.\nAll three agree.')
  // The importer still reads the note, and still counts the threads.
  const { workbook, report } = importXlsx(bytes)
  expect(JSON.stringify(workbook.resources)).toContain('Checked on Monday.')
  expect(report.sheets[0].counts.threadedComments).toBe(4)
  // A repeat, and the words it already has, change nothing.
  checked(bytes, [edit([[8, 0, 'Checked on Monday.\nAll three agree.']])])
  checked(corpus, [edit([[8, 0, 'An ordinary note next to the threads']])])
})

test('keeps Excel’s author line as it is and writes the words after it', () => {
  const bytes = checked(excel, [edit([[8, 0, 'Checked: a < b & "c"']])], [COMMENTS], {
    name: 'note-with-author-line',
    holds:
      'Review!A9’s note begins with its author in bold, as Excel writes a note; the words after it are new.',
    excel:
      'The note at A9 reads "Lab:" in bold and, on the next line, Checked: a < b & "c" not in bold.'
  })
  expect(comment(bytes, 'A9')).toBe(
    `<comment ref="A9" authorId="2" shapeId="0"><text>${BOLD}<r>${PLAIN}<t xml:space="preserve">\nChecked: a &lt; b &amp; &quot;c&quot;</t></r></text></comment>`
  )
  expect(readNotes(bytes)[0]).toMatchObject({ author: 'Lab', text: 'Checked: a < b & "c"' })
  checked(bytes, [edit([[8, 0, 'Checked: a < b & "c"']])])
  // Emptied, the note keeps its author's line.
  const empty = checked(excel, [edit([[8, 0, '']])], [COMMENTS])
  expect(comment(empty, 'A9')).toContain(`${BOLD}<r>${PLAIN}<t xml:space="preserve">\n</t></r>`)
  expect(readNotes(empty)[0].text).toBe('')
})

test('other ways a note’s text is laid out keep their own shape', () => {
  // the author's line and the words in one run, as some writers make it
  const one = noteAs(`<r>${PLAIN}<t>Lab:\nOld</t></r>`)
  expect(readNotes(one)[0].text).toBe('Old')
  expect(comment(checked(one, [edit([[8, 0, 'New']])], [COMMENTS]), 'A9')).toContain(
    `<text><r>${PLAIN}<t xml:space="preserve">Lab:\nNew</t></r></text>`
  )
  // text with no runs at all
  const bare = noteAs('<t>Old</t>')
  expect(comment(checked(bare, [edit([[8, 0, 'New']])], [COMMENTS]), 'A9')).toContain(
    '<text><t>New</t></text>'
  )
  // the author's line and nothing after it: the words follow in its font, not in bold
  const lone = noteAs(BOLD)
  expect(readNotes(lone)[0].text).toBe('')
  expect(comment(checked(lone, [edit([[8, 0, 'New']])], [COMMENTS]), 'A9')).toContain(
    `<text>${BOLD}<r>${PLAIN}<t xml:space="preserve">\nNew</t></r></text>`
  )
  // words in several fonts and a phonetic run: the new words take the first font
  const mixed = noteAs(
    `${BOLD}<r>${PLAIN}<t xml:space="preserve">\nOld </t></r><r><rPr><i/></rPr><t>words</t></r><rPh sb="0" eb="1"><t>x</t></rPh>`
  )
  expect(readNotes(mixed)[0].text).toBe('Old words')
  expect(comment(checked(mixed, [edit([[8, 0, 'New']])], [COMMENTS]), 'A9')).toContain(
    `<text>${BOLD}<r>${PLAIN}<t xml:space="preserve">\nNew</t></r></text>`
  )
  // an empty text element
  const none = withComments(
    xml(corpus).replace(OLD, '<comment ref="A9" authorId="2"><text/></comment>')
  )
  expect(comment(checked(none, [edit([[8, 0, 'New']])], [COMMENTS]), 'A9')).toContain(
    '<text><t>New</t></text>'
  )
  // a name that only begins like the author's is not the author's line
  const near = noteAs(`<r>${PLAIN}<t>Lab: see below</t></r>`)
  expect(readNotes(near)[0].text).toBe('Lab: see below')
})

test('a note’s new words and rich text in its cell go into one file, in either order', () => {
  const text = [
    {
      kind: 'text' as const,
      sheet: 'Review',
      cells: [
        {
          row: 8,
          column: 0,
          runs: [
            { text: 'Rich ' },
            { text: 'beside its note', font: { bold: true, colour: '#C00000' } }
          ]
        }
      ]
    }
  ]
  const noted = checked(
    corpus,
    [edit([[8, 0, 'The cell under this note is rich text.']])],
    [COMMENTS]
  )
  const both = patchText(noted, text).bytes
  expect(readNotes(both)[0].text).toBe('The cell under this note is rich text.')
  expect(readRich(both).map(({ row, column }) => [row, column])).toEqual([[8, 0]])
  expect(xml(both)).toBe(xml(noted))
  const other = checked(
    patchText(corpus, text).bytes,
    [edit([[8, 0, 'The cell under this note is rich text.']])],
    [COMMENTS],
    {
      name: 'note-and-rich-text',
      holds: 'Review!A9 holds rich text and its note has new words; B2 and C5 keep their threads.',
      excel:
        'A9 reads "Rich beside its note" with "beside its note" bold and dark red; its note reads "The cell under this note is rich text."; B2 and C5 still show their threads.'
    }
  )
  expect(readRich(other)).toEqual(readRich(both))
  expect(xml(other)).toBe(xml(both))
})

test('refuses a cell with no note, a thread, and what a note cannot hold', () => {
  expect(() => patchNotes(corpus, [edit([[0, 0, 'new']])])).toThrow(
    /A1 has no note in this file\. Add a new note in Excel\./
  )
  expect(() => patchNotes(corpus, [edit([[1, 1, 'mine']])])).toThrow(
    /The comment at B2 is a thread\. Reply to it in Excel\./
  )
  expect(() => patchNotes(corpus, [edit([[4, 2, 'mine']])])).toThrow(/C5 is a thread/)
  expect(() => patchNotes(corpus, [edit([[8, 0, 'x']], 'Nowhere')])).toThrow(
    /No worksheet named “Nowhere”/
  )
  expect(() => patchNotes(fixture('patch/base.xlsx'), [edit([[0, 0, 'x']], 'Data')])).toThrow(
    /Add a new note in Excel/
  )
  expect(() => patchNotes(corpus, [edit([[8, 0, 'a'.repeat(32_768)]])])).toThrow(
    /more than 32,767 characters/
  )
  expect(() => patchNotes(corpus, [edit([[-1, 0, 'x']])])).toThrow(/outside the worksheet/)
  expect(() => patchNotes(corpus, [edit([[8, 0, 7 as never]])])).toThrow(/Give the note’s text/)
  expect(() =>
    patchNotes(corpus, [edit(Array.from({ length: 20_001 }, (_, row): CellNote => [row, 0, 'x']))])
  ).toThrow(/at most 20,000 notes/)
  // A refusal after a good note leaves nothing written: the call throws as a whole.
  expect(() =>
    patchNotes(corpus, [
      edit([
        [8, 0, 'fine'],
        [1, 1, 'thread']
      ])
    ])
  ).toThrow(NotesRefused)
  // A thread is known by its own part even where the stand-in note's words were changed, and by its author alone.
  const reworded = withComments(xml(corpus).replace('[Threaded comment]', 'Edited'))
  expect(() => patchNotes(reworded, [edit([[1, 1, 'mine']])])).toThrow(/is a thread/)
  expect(patchNotes(corpus, []).bytes).toBe(corpus)
})

test('prefixes survive, and the last word on a note wins', () => {
  const prefixed = xml(corpus)
    .replace(/(<\/?)(\w+)(?=[\s/>])/g, '$1c:$2')
    .replace('xmlns="', 'xmlns:c="')
  const source = withComments(prefixed)
  expect(readNotes(source)).toHaveLength(1)
  const { bytes } = patchNotes(source, [
    edit([
      [8, 0, 'first'],
      [8, 0, 'second']
    ])
  ])
  expect(xml(bytes)).toContain(
    '<c:comment ref="A9" authorId="2"><c:text><c:r><c:rPr><c:sz val="8"/><c:color indexed="81"/><c:rFont val="Tahoma"/><c:family val="2"/></c:rPr><c:t>second</c:t></c:r></c:text></c:comment>'
  )
  expect(readNotes(bytes)[0].text).toBe('second')
})

test('hostile input is refused in words or read within bounds', () => {
  expect(() => readNotes(new Uint8Array(64))).toThrow(NotesRefused)
  const broken = withComments(xml(corpus).replace('</comments>', ''))
  expect(() => readNotes(broken)).toThrow(/could not be read/)
  expect(() => patchNotes(broken, [edit([[8, 0, 'x']])])).toThrow(NotesRefused)
  // An author the list does not have, a reference that is no cell, and ten thousand notes.
  const many = Array.from(
    { length: 10_000 },
    (_, i) => `<comment ref="D${i + 1}" authorId="99"><text><t>n${i}</t></text></comment>`
  ).join('')
  const big = withComments(
    xml(corpus).replace(
      '<commentList>',
      `<commentList><comment ref="A1:B2" authorId="2"><text><t>range</t></text></comment>${many}`
    )
  )
  const started = performance.now()
  const notes = readNotes(big)
  expect(notes).toHaveLength(10_001)
  expect(notes[0]).toEqual({ sheet: 'Review', row: 0, column: 3, author: '', text: 'n0' })
  const done = patchNotes(big, [
    edit([
      [9_999, 3, 'last'],
      [8, 0, 'control \u0001 dropped']
    ])
  ])
  expect(readNotes(done.bytes).at(-1)!.text).toBe('control  dropped')
  expect(performance.now() - started).toBeLessThan(5_000)
})
