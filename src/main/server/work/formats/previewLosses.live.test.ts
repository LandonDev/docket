import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { expect, it } from 'vitest'
import { DEFAULT_STYLES, defaultSetup } from 'work-kit/editor/page'
import { paraOf, paraText } from 'work-kit/editor/para'
import { TEMPCODE_THEME } from 'work-kit/format/theme'
import { emptySidecar, type Block, type Imported, type Styles } from 'work-kit/formats'
import { readDocx, writeDocx } from 'work-kit/formats/docx'
import { formats } from './index'
import { convertersOf, JobRunner } from './jobs'
import { Toolchain } from './tools'

const REAL = process.env.TEMP_CODE_WORK_TOOLS_DATA
const para = (id: string, text: string, styles: Styles = {}): Block => ({
  id, type: 'paragraph', props: {}, children: [], content: [{ type: 'text', text, styles }]
})
const comment = 'Look at this title'
const reply = 'The title works for me'
const inserted = 'New words from Pat'
const note = 'A note about the plan'

async function fixture() {
  const title = para('title', 'A plan for spring')
  title.props.para = paraText({ style: 'Title' })
  const body = para('body', 'Styled words', { fontFamily: 'Cambria', fontSize: '15', color: 'theme:accent1', highlight: '#FFEE99', underline: true })
  body.props.para = paraText({ spaceBefore: 12, spaceAfter: 18, lineSpacing: 1.5 })
  const tail: Block = {
    id: 'tail', type: 'paragraph', props: {}, children: [], content: [
      { type: 'text', text: 'See this note', styles: {} },
      { type: 'footnote', props: { id: 'note', note } }
    ]
  }
  return writeDocx([title, body, para('inserted', inserted), tail], {
    ...emptySidecar(),
    threads: [{ id: 'thread', quote: 'A plan', resolved: false, ranges: [{ blockId: 'title', from: 0, to: 6 }], comments: [
      { id: 'comment', author: 'Alex', body: [para('comment-body', comment)] },
      { id: 'reply', author: 'Pat', body: [para('reply-body', reply)] }
    ] }],
    changes: [{ id: 'change', kind: 'insert', author: 'Pat', text: inserted, range: { blockId: 'inserted', from: 0, to: inserted.length } }],
    document: {
      schema: 1,
      styles: Object.fromEntries(DEFAULT_STYLES.map((style) => [style.name, style])),
      theme: TEMPCODE_THEME,
      setup: { ...defaultSetup(), columns: 2, header: true, footer: true },
      header: { start: [{ text: 'Plan header' }], center: [], end: [{ field: 'page' }] },
      footer: { start: [{ text: 'Plan footer' }], center: [], end: [{ field: 'page' }] }
    }
  }, { title: 'Spring plan' })
}

function readFeatures(doc: Imported) {
  const content = (block: Block) => Array.isArray(block.content) ? block.content : []
  const body = doc.blocks.find((b) => content(b).some((r) => r.type === 'text' && r.text.includes('Styled words')))
  const run = body && content(body).find((r) => r.type === 'text' && r.text.includes('Styled words'))
  const style = run?.type === 'text' ? run.styles : {}
  return {
    comments: doc.sidecar.threads.map((t) => ({ anchored: t.ranges.length > 0, comments: t.comments.map((c) => c.body.flatMap(content).map((r) => r.type === 'text' ? r.text : '').join('')) })),
    change: doc.sidecar.changes.map((c) => ({ kind: c.kind, author: c.author, text: c.text })),
    footnote: doc.sidecar.notes.flatMap((n) => n.blocks.flatMap(content)).map((r) => r.type === 'text' ? r.text : ''),
    font: style.fontFamily ?? null,
    size: style.fontSize ?? null,
    colour: style.color ?? null,
    highlight: style.highlight ?? null,
    underline: style.underline ?? false,
    title: doc.blocks.map((b) => paraOf(b).style).find(Boolean) ?? null,
    spacing: body ? paraOf(body) : null,
    columns: doc.sidecar.document?.setup.columns ?? null,
    header: doc.sidecar.document?.header ?? null,
    footer: doc.sidecar.document?.footer ?? null
  }
}

it.skipIf(!REAL)('measures what OpenDocument and Rich Text keep from the Word export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc6-losses-'))
  try {
    const runner = new JobRunner({
      host: 'env_box', dataDir: dir, tools: new Toolchain(REAL!), log: () => {},
      converters: convertersOf([formats], () => {})
    })
    const original = await fixture()
    const baseline = readFeatures(readDocx(original))
    expect(baseline).toMatchObject({
      comments: [{ anchored: true, comments: [comment, reply] }], change: [{ kind: 'insert', author: 'Pat', text: inserted }],
      footnote: [note], font: 'Cambria', size: '15', colour: 'theme:accent1', highlight: '#FFEE99',
      underline: true, title: 'Title', spacing: { spaceBefore: 12, spaceAfter: 18, lineSpacing: 1.5 }, columns: 2,
      header: { start: [{ text: 'Plan header' }], end: [{ field: 'page' }] },
      footer: { start: [{ text: 'Plan footer' }], end: [{ field: 'page' }] }
    })
    console.log('DOCX', JSON.stringify(baseline))
    const input = join(dir, 'plan.docx')
    writeFileSync(input, original)
    for (const format of ['odt', 'rtf']) {
      const output = join(dir, `plan.${format}`)
      await runner.convert({ from: 'docx', to: format, input, output, here: true })
      const bytes = readFileSync(output)
      const markup = format === 'odt' ? strFromU8(unzipSync(bytes)['content.xml']!) : bytes.toString('latin1')
      const inspected = {
        comment: markup.includes(comment), reply: markup.includes(reply),
        annotations: format === 'odt' ? markup.match(/<office:annotation(?=[ >])[^>]*>/g) ?? [] : markup.match(/\\(?:atnref|annotation)\b/g) ?? []
      }
      const returned = join(dir, `from-${format}.docx`)
      await runner.convert({ from: format, to: 'docx', input: output, output: returned, here: true })
      console.log(format.toUpperCase(), JSON.stringify({ ...readFeatures(readDocx(readFileSync(returned))), inspected }))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 180_000)
